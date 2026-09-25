// Website API routes. Org/project management, database config, and query bridge under /api/v0.

import { json, Spiceflow } from 'spiceflow'
import { z } from 'zod'
import dedent from 'string-dedent'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { ulid } from 'ulid'
import { env } from 'cloudflare:workers'
import { trace, getLogger } from '@strada.sh/sdk'
import { deployTinybirdResources, getDeploymentManagedReadToken, TinybirdClient, TINYBIRD_DATASOURCES } from 'strada/src/tinybird'
import {
  hasCustomRetention,
  mergeProjectRetention,
  renderTinybirdRetention,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type ProjectRetention,
} from 'strada/src/tinybird-retention'
import { bundledTinybirdResources } from './tinybird-bundled-resources.ts'
import {
  getAccessibleOrgDatabase,
  getAccessibleProject,
  getAccessibleOrgToken,
  getDb,
  getOrCreateProjectJwt,
  hashToken,
  generateIngestToken,
  requireOrgMember,
  requireSession,
} from './db.ts'
import {
  executeBackendQuery,
  insertBackendRow,
  appendProjectFilterSettings,
  type DbConfig,
  type QueryResult,
} from './query-backend.ts'
import { isValidCron } from './health-check-workflow.ts'
import {
  generateSearchFilter,
  generateFilterRequestSchema,
  generateFilterResponseSchema,
  type AiSearchView,
} from './generate-filter.ts'
export type { AiFilterResult } from './generate-filter.ts'

const createOrgRequestSchema = z.object({ name: z.string().min(1) })

const updateDatabaseRequestSchema = z.discriminatedUnion('backend', [
  z.object({
    backend: z.literal('tinybird'),
    tinybirdEndpoint: z.string().url(),
    tinybirdAdminToken: z.string().min(1),
    tinybirdReadToken: z.string().min(1),
  }),
  z.object({
    backend: z.literal('clickhouse'),
    clickhouseUrl: z.string().url(),
    clickhouseDatabase: z.string().optional(),
    clickhouseUser: z.string().optional(),
    clickhousePassword: z.string().optional(),
  }),
])

const createProjectRequestSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
})

const retentionDaysSchema = z.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS).nullable()

const updateProjectRetentionRequestSchema = z.object({
  tracesDays: retentionDaysSchema.optional(),
  logsDays: retentionDaysSchema.optional(),
  errorsDays: retentionDaysSchema.optional(),
  metricsDays: retentionDaysSchema.optional(),
}).refine(
  (body) => Object.values(body).some((value) => value !== undefined),
  { message: 'pass at least one retention field' },
)

const createOrgTokenRequestSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(['ingest']),
})

const queryProjectRequestSchema = z.object({ sql: z.string().min(1) })

const updateIssueStatusRequestSchema = z.object({
  status: z.enum(['open', 'resolved', 'muted', 'ignored']),
})

const updateIssueAssigneeRequestSchema = z.object({
  assigneeMemberId: z.string().nullish(),
})

// ── Issue response schemas ──────────────────────────────────────────

const issueAssigneeSchema = z.object({
  memberId: z.string(),
  name: z.string(),
  email: z.string(),
}).nullable()

const issueResolverSchema = z.object({
  memberId: z.string(),
  name: z.string(),
}).nullable()

const issueSummarySchema = z.object({
  fingerprintHash: z.string(),
  status: z.enum(['open', 'resolved', 'muted', 'ignored']),
  assigneeMemberId: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  resolvedByMemberId: z.string().nullable(),
  updatedAt: z.number().nullable(),
  assignee: issueAssigneeSchema,
  resolvedBy: issueResolverSchema,
})

const issueListResponseSchema = z.object({
  issues: z.array(issueSummarySchema),
})

const issueStatusResponseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(['open', 'resolved', 'muted', 'ignored']),
})

const issueAssigneeResponseSchema = z.object({
  ok: z.literal(true),
})

export type { QueryResult as QueryResponse } from './query-backend.ts'

function stripSemicolons(sql: string) {
  return sql.trim().replace(/;+\s*$/, '').trimEnd()
}

function detectFormat(sql: string): string | null {
  const normalized = stripSemicolons(sql)
  const match = normalized.match(/\bFORMAT\s+(\w+)\s*$/i)
  return match ? match[1]! : null
}

// ── Issue state helpers (Tinybird/ClickHouse ReplacingMergeTree) ─────
//
// Issue triage state (status, assignee) lives in ClickHouse via
// ReplacingMergeTree, not in D1. D1 is a per-request SQLite database
// on Cloudflare; it cannot handle high-RPS analytical queries and
// adds latency to every read. ClickHouse keeps issue state co-located
// with error data so the CLI and UI can join them in a single SQL query
// instead of doing two round-trips (ClickHouse + D1).
//
// ReplacingMergeTree deduplicates by (ProjectId, FingerprintHash),
// keeping only the row with the highest Version. Reads use argMax(col, Version) to
// force deduplication at query time. Writes use wait=true on Tinybird
// to guarantee read-after-write consistency (important because status
// and assignee updates do read-before-write to preserve the other field).
//
// Rows use PascalCase keys matching the ClickHouse/Tinybird column names
// directly. The Tinybird datasource's json:$ mappings also use PascalCase
// (json:$.ProjectId, json:$.Status, etc.) so no snake→Pascal remapping
// is needed for either backend.

export interface IssueStateRow {
  ProjectId: string
  FingerprintHash: string
  Status: string
  AssigneeMemberId: string
  ResolvedAt: string | null
  ResolvedByMemberId: string
  LastAlertedAt: string | null
  /** Comma-separated deployment.id values active when the issue was resolved. Used to suppress alerts for old deployments and detect regressions in new ones. */
  ResolvedInDeploymentIds: string
  Version: number
  UpdatedAt: string
}

/**
 * Read current issue state for a fingerprint. Returns defaults if no row exists yet.
 * Used by both status and assignee routes to preserve the other field on partial updates.
 */
async function readCurrentIssueState(ctx: { dbConfig: DbConfig; proj: { id: string; tinybirdJwt: string | null; tinybirdJwtDatasources: string | null }; projectId: string; fingerprintHash: string }): Promise<IssueStateRow> {
  const { dbConfig, proj, projectId, fingerprintHash } = ctx
  const sql = `SELECT argMax(Status, Version) AS Status, argMax(AssigneeMemberId, Version) AS AssigneeMemberId, argMax(ResolvedAt, Version) AS ResolvedAt, argMax(ResolvedByMemberId, Version) AS ResolvedByMemberId, argMax(LastAlertedAt, Version) AS LastAlertedAt, argMax(ResolvedInDeploymentIds, Version) AS ResolvedInDeploymentIds FROM otel_issue_state WHERE FingerprintHash = '${fingerprintHash}' GROUP BY FingerprintHash LIMIT 1 FORMAT JSON`
  try {
    const result = await executeBackendQuery({ dbConfig, project: { id: projectId, tinybirdJwt: proj.tinybirdJwt, tinybirdJwtDatasources: proj.tinybirdJwtDatasources }, sql })
    const row = result.data?.[0]
    if (row) {
      return {
        ProjectId: projectId,
        FingerprintHash: fingerprintHash,
        Status: (row.Status as string) || 'open',
        AssigneeMemberId: (row.AssigneeMemberId as string) || '',
        ResolvedAt: (row.ResolvedAt as string) || null,
        ResolvedByMemberId: (row.ResolvedByMemberId as string) || '',
        LastAlertedAt: (row.LastAlertedAt as string) || null,
        ResolvedInDeploymentIds: (row.ResolvedInDeploymentIds as string) || '',
        Version: 0,
        UpdatedAt: '',
      }
    }
  } catch {
    // No existing state; return defaults for a new issue
  }
  return {
    ProjectId: projectId,
    FingerprintHash: fingerprintHash,
    Status: 'open',
    AssigneeMemberId: '',
    ResolvedAt: null,
    ResolvedByMemberId: '',
    LastAlertedAt: null,
    ResolvedInDeploymentIds: '',
    Version: 0,
    UpdatedAt: '',
  }
}

/**
 * Query distinct deployment.id values from recent errors for a fingerprint.
 * Returns a comma-separated string of deployment IDs, stored in otel_issue_state
 * when resolving an issue. Used later by the alert check to distinguish "old
 * deployment still erroring" (suppress) from "new deployment regression" (reopen).
 *
 * If no deployment.id is set on any error (user didn't configure it), returns ''.
 */
async function queryActiveDeploymentIds(ctx: { dbConfig: DbConfig; proj: { id: string; tinybirdJwt: string | null; tinybirdJwtDatasources: string | null }; projectId: string; fingerprintHash: string }): Promise<string> {
  const { dbConfig, proj, projectId, fingerprintHash } = ctx
  const sql = `SELECT DISTINCT ResourceAttributes['deployment.id'] AS deployment_id FROM otel_errors WHERE FingerprintHash = '${fingerprintHash}' AND Timestamp >= now() - INTERVAL 24 HOUR AND ResourceAttributes['deployment.id'] != '' LIMIT 50 FORMAT JSON`

  try {
    const result = await executeBackendQuery({ dbConfig, project: { id: projectId, tinybirdJwt: proj.tinybirdJwt, tinybirdJwtDatasources: proj.tinybirdJwtDatasources }, sql })
    const ids = (result.data ?? [])
      .map((row) => String(row.deployment_id ?? ''))
      .filter(Boolean)
    return ids.join(',')
  } catch (err) {
    logger.error({ message: 'queryActiveDeploymentIds failed', error: String(err) })
    return ''
  }
}

/** Write a row to otel_issue_state via the shared insertBackendRow helper. */
async function writeIssueState(ctx: { dbConfig: DbConfig; row: IssueStateRow }): Promise<void> {
  try {
    await insertBackendRow({ dbConfig: ctx.dbConfig, table: 'otel_issue_state', row: { ...ctx.row } })
  } catch (err) {
    logger.error({ message: 'writeIssueState failed', error: String(err) })
    throw json({ error: 'failed to write issue state' }, { status: 500 })
  }
}

// ── Health check result helpers (otel_health_checks) ─────────────────

export interface CheckSummary {
  lastCheckedAt: number
  lastSuccess: boolean
  lastStatusCode: number
  lastLatencyMs: number
  lastErrorMessage: string
  /** Success ratio over the last 24h, 0-1. Null when no runs in 24h. */
  uptime24h: number | null
  runs24h: number
}

export interface CheckResultRow {
  timestamp: number
  statusCode: number
  latencyMs: number
  success: boolean
  errorMessage: string
  responseBody: string
}

type HealthCheckRuleWithProject = {
  id: string
  projectId: string | null
  project: { id: string; tinybirdJwt: string | null; tinybirdJwtDatasources: string | null } | null
}

/** Latest result and 24h uptime per check. One query per project because reads are project-scoped. */
async function queryCheckSummaries(ctx: { dbConfig: DbConfig; rules: HealthCheckRuleWithProject[] }): Promise<Map<string, CheckSummary>> {
  const byProject = new Map<string, { project: NonNullable<HealthCheckRuleWithProject['project']>; ids: string[] }>()
  for (const rule of ctx.rules) {
    if (!rule.project) continue
    const entry = byProject.get(rule.project.id) ?? { project: rule.project, ids: [] }
    entry.ids.push(rule.id)
    byProject.set(rule.project.id, entry)
  }

  const summaries = new Map<string, CheckSummary>()
  await Promise.all([...byProject.values()].map(async ({ project, ids }) => {
    const sql = dedent`
      SELECT
        CheckId,
        toUnixTimestamp64Milli(max(Timestamp)) AS LastCheckedAt,
        argMax(Success, Timestamp) AS LastSuccess,
        argMax(StatusCode, Timestamp) AS LastStatusCode,
        argMax(LatencyMs, Timestamp) AS LastLatencyMs,
        argMax(ErrorMessage, Timestamp) AS LastErrorMessage,
        countIf(Timestamp >= now() - INTERVAL 24 HOUR) AS Runs24h,
        countIf(Timestamp >= now() - INTERVAL 24 HOUR AND Success = 1) AS Ok24h
      FROM otel_health_checks
      WHERE CheckId IN (${ids.map((id) => `'${id}'`).join(', ')})
        AND Timestamp >= now() - INTERVAL 7 DAY
      GROUP BY CheckId
      LIMIT ${ids.length}
      FORMAT JSON
    `
    try {
      const result = await executeBackendQuery({ dbConfig: ctx.dbConfig, project, sql })
      for (const row of result.data ?? []) {
        const runs24h = Number(row.Runs24h)
        summaries.set(String(row.CheckId), {
          lastCheckedAt: Number(row.LastCheckedAt),
          lastSuccess: Number(row.LastSuccess) === 1,
          lastStatusCode: Number(row.LastStatusCode),
          lastLatencyMs: Number(row.LastLatencyMs),
          lastErrorMessage: String(row.LastErrorMessage ?? ''),
          uptime24h: runs24h > 0 ? Number(row.Ok24h) / runs24h : null,
          runs24h,
        })
      }
    } catch (err) {
      logger.error({ message: 'queryCheckSummaries failed', projectId: project.id, error: String(err) })
    }
  }))
  return summaries
}

function toProjectRetention(project: {
  id: string
  tracesRetentionDays: number | null
  logsRetentionDays: number | null
  errorsRetentionDays: number | null
  metricsRetentionDays: number | null
}): ProjectRetention {
  return {
    id: project.id,
    tracesRetentionDays: project.tracesRetentionDays,
    logsRetentionDays: project.logsRetentionDays,
    errorsRetentionDays: project.errorsRetentionDays,
    metricsRetentionDays: project.metricsRetentionDays,
  }
}

function retentionResponse(project: ProjectRetention) {
  return {
    tracesDays: project.tracesRetentionDays,
    logsDays: project.logsRetentionDays,
    errorsDays: project.errorsRetentionDays,
    metricsDays: project.metricsRetentionDays,
  }
}

async function loadOrgProjectRetention(orgId: string): Promise<ProjectRetention[]> {
  const db = getDb()
  const projects = await db.query.project.findMany({
    where: { orgId },
  })
  return projects.map(toProjectRetention)
}

async function deployOrgTinybirdRetention(ctx: {
  orgId: string
  database: {
    id: string
    tinybirdEndpoint: string | null
    tinybirdAdminToken: string | null
  }
}) {
  const existing = ctx.database
  if (!existing.tinybirdEndpoint || !existing.tinybirdAdminToken) {
    return new Error('missing Tinybird endpoint or admin token for this org')
  }

  const db = getDb()
  const client = new TinybirdClient({
    baseUrl: existing.tinybirdEndpoint,
    token: existing.tinybirdAdminToken,
  })
  const datasources = renderTinybirdRetention({
    datasources: [...bundledTinybirdResources.datasources],
    projects: await loadOrgProjectRetention(ctx.orgId),
  })

  const deployment = await deployTinybirdResources({
    client,
    datasources,
    pipes: [...bundledTinybirdResources.pipes],
    allowDestructive: true,
    pollIntervalMs: 3000,
    waitTimeoutMs: 60_000,
  })
  if (deployment instanceof Error) return deployment
  if (deployment.result === 'in_progress') {
    return {
      ok: false as const,
      result: deployment.result,
      backend: 'tinybird' as const,
      tinybirdEndpoint: existing.tinybirdEndpoint,
    }
  }

  const readToken = await getDeploymentManagedReadToken(client)
  if (readToken instanceof Error) return readToken

  const updatedAt = Date.now()
  const currentDatasources = TINYBIRD_DATASOURCES.join(',')
  await db.batch([
    db.update(schema.database)
      .set({ tinybirdReadToken: readToken.token, updatedAt })
      .where(orm.eq(schema.database.id, existing.id))
      .limit(1),
    db.update(schema.project)
      .set({ tinybirdJwt: null, tinybirdJwtDatasources: currentDatasources, updatedAt })
      .where(orm.eq(schema.project.orgId, ctx.orgId)),
  ])

  return {
    ok: true as const,
    result: deployment.result,
    backend: 'tinybird' as const,
    tinybirdEndpoint: existing.tinybirdEndpoint,
  }
}

async function createOrgForUser(userId: string, name: string) {
  const db = getDb()
  const orgId = ulid()
  const dbId = ulid()

  await db.batch([
    db.insert(schema.org).values({ id: orgId, name }),
    db.insert(schema.orgMember).values({ orgId, userId, role: 'admin' }),
    db.insert(schema.database).values({ id: dbId, orgId, backend: 'tinybird' }),
  ])

  return { id: orgId, name, databaseId: dbId, role: 'admin' as const }
}

const tracer = trace.getTracer('strada-website-api')
const logger = getLogger('strada-website-api')

export const api = new Spiceflow({ tracer })
  .get('/api/v0/health', () => ({ ok: true }))
  // Public end-to-end probe for Strada health checks: D1 lookup, project JWT, Tinybird /v0/sql.
  // Uses the website's own project (STRADA_PROJECT_ID) and returns no query data.
  .get('/api/v0/health/tinybird', async () => {
    const start = Date.now()
    const headers = { 'cache-control': 'no-store' }
    const db = getDb()
    const project = await db.query.project.findFirst({ where: { id: env.STRADA_PROJECT_ID } })
    if (!project) {
      return json({ ok: false, error: 'project not found' }, { status: 503, headers })
    }
    const dbConfig = await db.query.database.findFirst({ where: { orgId: project.orgId } })
    if (!dbConfig) {
      return json({ ok: false, error: 'database config not found' }, { status: 503, headers })
    }
    try {
      const result = await executeBackendQuery({
        dbConfig,
        project,
        sql: 'SELECT count() AS c FROM otel_health_checks WHERE Timestamp >= now() - INTERVAL 1 HOUR LIMIT 1 FORMAT JSON',
      })
      if (!result.data?.length) throw new Error('query returned no rows')
      return json({ ok: true, backend: dbConfig.backend, latencyMs: Date.now() - start }, { headers })
    } catch (err) {
      logger.error({ message: 'tinybird health check failed', error: String(err) })
      return json({ ok: false, error: 'query failed', latencyMs: Date.now() - start }, { status: 503, headers })
    }
  })
  .route({
      method: 'POST',
      path: '/api/v0/orgs',
      request: createOrgRequestSchema,
      async handler({ request }) {
        const session = await requireSession(request)
        const body = await request.json()
        const org = await createOrgForUser(session.userId, body.name)
        return { id: org.id, name: org.name, databaseId: org.databaseId }
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/ensure-default',
      async handler({ request }) {
        const session = await requireSession(request)
        const db = getDb()
        const members = await db.query.orgMember.findMany({
          where: { userId: session.userId },
          with: { org: true },
        })
        const existing = members.find((member) => member.org != null)
        if (existing?.org) {
          return {
            id: existing.org.id,
            name: existing.org.name,
            role: existing.role,
            created: false,
          }
        }

        const org = await createOrgForUser(session.userId, 'Personal')
        return {
          id: org.id,
          name: org.name,
          role: org.role,
          created: true,
        }
      },
    })
    .get('/api/v0/orgs', async ({ request }) => {
      const session = await requireSession(request)
      const db = getDb()
      const members = await db.query.orgMember.findMany({
        where: { userId: session.userId },
        with: { org: true },
      })
      const orgs = members.flatMap((m) =>
        m.org ? [{ id: m.org.id, name: m.org.name, role: m.role }] : [],
      )
      return { orgs }
    })
    .route({
      method: 'PUT',
      path: '/api/v0/orgs/:orgId/database',
      request: updateDatabaseRequestSchema,
      async handler({ request, params }) {
        const session = await requireSession(request)
        const access = await getAccessibleOrgDatabase({ userId: session.userId, orgId: params.orgId })
        if (!access || access.member.role !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }

        const db = getDb()
        const body = await request.json()
        const existing = access.database
        if (!existing) {
          throw json({ error: 'no database config for this org' }, { status: 404 })
        }

        const updatedAt = Date.now()
        const updateDatabase = body.backend === 'tinybird'
          ? db.update(schema.database)
            .set({
              backend: 'tinybird',
              tinybirdEndpoint: body.tinybirdEndpoint,
              tinybirdAdminToken: body.tinybirdAdminToken,
              tinybirdReadToken: body.tinybirdReadToken,
              clickhouseUrl: null,
              clickhouseDatabase: null,
              clickhouseUser: null,
              clickhousePassword: null,
              updatedAt,
            })
            .where(orm.eq(schema.database.id, existing.id))
          : db.update(schema.database)
            .set({
              backend: 'clickhouse',
              clickhouseUrl: body.clickhouseUrl,
              clickhouseDatabase: body.clickhouseDatabase || 'default',
              clickhouseUser: body.clickhouseUser || 'default',
              clickhousePassword: body.clickhousePassword || '',
              tinybirdEndpoint: null,
              tinybirdAdminToken: null,
              tinybirdReadToken: null,
              updatedAt,
            })
            .where(orm.eq(schema.database.id, existing.id))

        await db.batch([
          updateDatabase,
          db.update(schema.project)
            .set({ tinybirdJwt: null, tinybirdJwtDatasources: null, updatedAt })
            .where(orm.eq(schema.project.orgId, params.orgId)),
        ])

        return { ok: true }
      },
    })
    .get('/api/v0/orgs/:orgId/database', async ({ request, params }) => {
      const session = await requireSession(request)
      const access = await getAccessibleOrgDatabase({ userId: session.userId, orgId: params.orgId })
      if (!access || access.member.role !== 'admin') {
        throw json({ error: 'forbidden' }, { status: 403 })
      }
      const row = access.database
      if (!row) {
        throw json({ error: 'no database config' }, { status: 404 })
      }
      return {
        id: row.id,
        backend: row.backend,
        tinybirdEndpoint: row.tinybirdEndpoint,
        hasReadToken: !!row.tinybirdReadToken,
        hasAdminToken: !!row.tinybirdAdminToken,
        clickhouseUrl: row.clickhouseUrl,
        clickhouseDatabase: row.clickhouseDatabase,
        clickhouseUser: row.clickhouseUser,
        hasClickhousePassword: !!row.clickhousePassword,
      }
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/:orgId/database/migrate',
      async handler({ request, params }) {
        const session = await requireSession(request)
        const access = await getAccessibleOrgDatabase({ userId: session.userId, orgId: params.orgId })
        if (!access || access.member.role !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }

        const existing = access.database
        if (!existing) {
          throw json({ error: 'no database config for this org' }, { status: 404 })
        }
        if (existing.backend !== 'tinybird') {
          throw json({ error: 'database upgrade only supports Tinybird backends' }, { status: 400 })
        }

        const deployment = await deployOrgTinybirdRetention({
          orgId: params.orgId,
          database: existing,
        })
        if (deployment instanceof Error) {
          throw json({ error: deployment.message }, { status: 502 })
        }
        return deployment
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/:orgId/projects',
      request: createProjectRequestSchema,
      async handler({ request, params }) {
        const session = await requireSession(request)
        const access = await getAccessibleOrgDatabase({ userId: session.userId, orgId: params.orgId })
        if (!access || access.member.role !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }

        const db = getDb()
        const body = await request.json()
        const dbRow = access.database
        if (!dbRow) {
          throw json({ error: 'configure database first' }, { status: 400 })
        }

        const rows = await db.insert(schema.project)
          .values({ slug: body.slug, orgId: params.orgId, databaseId: dbRow.id })
          .returning()
        const proj = rows[0]
        if (!proj) throw json({ error: 'insert failed' }, { status: 500 })

        const { fullKey, prefix } = generateIngestToken()
        const hashed = await hashToken(fullKey)
        await db.insert(schema.orgToken).values({
          orgId: params.orgId,
          name: `${body.slug} ingest`,
          prefix,
          hashedKey: hashed,
          createdBy: session.userId,
        })

        return {
          id: proj.id,
          slug: proj.slug,
          ingestEndpoint: `https://${proj.id}-ingest.strada.sh`,
          token: fullKey,
          retention: retentionResponse(toProjectRetention(proj)),
        }
      },
    })
    .get('/api/v0/orgs/:orgId/projects', async ({ request, params }) => {
      const session = await requireSession(request)
      await requireOrgMember(session.userId, params.orgId)
      const db = getDb()
      const projects = await db.query.project.findMany({
        where: { orgId: params.orgId },
        orderBy: { createdAt: 'desc' },
      })
      return {
        projects: projects.map((p) => ({
          id: p.id,
          slug: p.slug,
          ingestEndpoint: `https://${p.id}-ingest.strada.sh`,
          createdAt: p.createdAt,
          retention: retentionResponse(toProjectRetention(p)),
        })),
      }
    })
    .route({
      method: 'DELETE',
      path: '/api/v0/projects/:id',
      async handler({ request, params }) {
        const session = await requireSession(request)
        const proj = await getAccessibleProject({ userId: session.userId, projectId: params.id })
        if (!proj) {
          throw json({ error: 'project not found' }, { status: 404 })
        }
        if (proj.accessRole !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }
        const db = getDb()
        const needsRetentionReconcile = proj.database?.backend === 'tinybird' && hasCustomRetention(toProjectRetention(proj))
        await db.delete(schema.project).where(orm.eq(schema.project.id, params.id)).limit(1)
        if (!needsRetentionReconcile || !proj.database) {
          return { ok: true, retention: { deployment: 'applied' as const } }
        }
        const deployment = await deployOrgTinybirdRetention({
          orgId: proj.orgId,
          database: proj.database,
        })
        if (deployment instanceof Error) {
          logger.error({ message: 'project deleted but retention reconciliation failed', error: deployment.message })
          return {
            ok: true,
            retention: { deployment: 'failed' as const, error: deployment.message },
          }
        }
        return {
          ok: true,
          retention: {
            deployment: deployment.result === 'in_progress' ? 'in_progress' as const : 'applied' as const,
          },
        }
      },
    })
    .get('/api/v0/projects/:id/retention', async ({ request, params }) => {
      const session = await requireSession(request)
      const proj = await getAccessibleProject({ userId: session.userId, projectId: params.id })
      if (!proj) {
        throw json({ error: 'project not found' }, { status: 404 })
      }
      return retentionResponse(toProjectRetention(proj))
    })
    .route({
      method: 'PUT',
      path: '/api/v0/projects/:id/retention',
      request: updateProjectRetentionRequestSchema,
      async handler({ request, params }) {
        const session = await requireSession(request)
        const proj = await getAccessibleProject({ userId: session.userId, projectId: params.id })
        if (!proj) {
          throw json({ error: 'project not found' }, { status: 404 })
        }
        if (proj.accessRole !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }
        if (proj.database?.backend !== 'tinybird') {
          throw json({
            error: 'Per-project retention updates require a Tinybird backend. Self-hosted ClickHouse keeps all raw telemetry unless you add table TTL yourself.',
          }, { status: 400 })
        }

        const body = await request.json()
        const nextRetention = mergeProjectRetention({
          current: toProjectRetention(proj),
          update: body,
        })
        const db = getDb()
        await db.update(schema.project)
          .set({
            tracesRetentionDays: nextRetention.tracesRetentionDays,
            logsRetentionDays: nextRetention.logsRetentionDays,
            errorsRetentionDays: nextRetention.errorsRetentionDays,
            metricsRetentionDays: nextRetention.metricsRetentionDays,
            updatedAt: Date.now(),
          })
          .where(orm.eq(schema.project.id, params.id))
          .limit(1)

        const deployment = await deployOrgTinybirdRetention({
          orgId: proj.orgId,
          database: proj.database,
        })
        if (deployment instanceof Error) {
          logger.error({ message: 'retention settings saved but Tinybird deployment failed', error: deployment.message })
          return {
            retention: retentionResponse(nextRetention),
            deployment: 'failed' as const,
            error: deployment.message,
          }
        }
        return {
          retention: retentionResponse(nextRetention),
          deployment: deployment.result === 'in_progress' ? 'in_progress' as const : 'applied' as const,
        }
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/:orgId/tokens',
      request: createOrgTokenRequestSchema,
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }

        const db = getDb()
        const body = await request.json()
        const { fullKey, prefix } = generateIngestToken()
        const hashed = await hashToken(fullKey)

        await db.insert(schema.orgToken).values({
          orgId: params.orgId,
          name: body.name,
          prefix,
          hashedKey: hashed,
          scope: body.scope,
          createdBy: session.userId,
        })

        return { key: fullKey, prefix: `str_${prefix}...`, name: body.name, scope: body.scope }
      },
    })
    .get('/api/v0/orgs/:orgId/tokens', async ({ request, params }) => {
      const session = await requireSession(request)
      const member = await requireOrgMember(session.userId, params.orgId)
      if (member.role !== 'admin') throw json({ error: 'forbidden' }, { status: 403 })
      const db = getDb()

      const tokens = await db.query.orgToken.findMany({
        where: { orgId: params.orgId },
        with: { creator: { columns: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      })
      return {
        tokens: tokens.map((t) => ({
          id: t.id,
          name: t.name,
          prefix: `str_${t.prefix}...`,
          scope: t.scope,
          createdBy: t.creator?.name ?? 'unknown',
          createdAt: t.createdAt,
        })),
      }
    })
    .route({
      method: 'DELETE',
      path: '/api/v0/org-tokens/:id',
      async handler({ request, params }) {
        const session = await requireSession(request)
        const token = await getAccessibleOrgToken(session.userId, params.id)
        if (!token?.org) {
          throw json({ error: 'token not found' }, { status: 404 })
        }
        if (token.org.members[0]?.role !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }
        const db = getDb()
        await db.delete(schema.orgToken).where(orm.eq(schema.orgToken.id, params.id))
        return { ok: true }
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/projects/:projectId/query',
      request: queryProjectRequestSchema,
      detail: {
        summary: 'Run a SQL query against a project',
        tags: ['query'],
        description: dedent`
          Proxies a ClickHouse SQL \
          \`SELECT\` statement to the project's configured backend.

          ## Output format

          The output format is controlled by a \`FORMAT\` clause at the end of the SQL.
          There is no separate format parameter.

          **No \`FORMAT\` clause (default)**

          The server injects \`FORMAT JSON\` automatically and returns a structured JSON
          envelope. Note: Tinybird's own default format is TSV. The injection is required
          to get JSON back.

          **\`FORMAT\` clause present**

          The SQL is sent to the backend unchanged and the raw response body is returned
          as \`{ raw: string, contentType: string }\`.
        `,
      },
      async handler({ request, params }) {
        const session = await requireSession(request)
        const proj = await getAccessibleProject({ userId: session.userId, projectId: params.projectId })
        if (!proj) {
          throw json({ error: 'project not found' }, { status: 404 })
        }

        const dbConfig = proj.database
        if (!dbConfig) {
          throw json({ error: 'no database configured' }, { status: 400 })
        }

        const body = await request.json()
        const secrets = [
          dbConfig.tinybirdAdminToken,
          dbConfig.tinybirdReadToken,
          dbConfig.clickhousePassword,
        ].filter((s): s is string => !!s && s.length > 0)

        function redact(text: string) {
          let result = text
          for (const secret of secrets) {
            result = result.replaceAll(secret, '[REDACTED]')
          }
          return result
        }

        const normalizedSql = stripSemicolons(body.sql)
        const format = detectFormat(normalizedSql)
        const sqlToSend = format ? normalizedSql : `${normalizedSql} FORMAT JSON`
        const hasExplicitFormat = format !== null

        // The query bridge needs special handling beyond executeBackendQuery:
        // - Tinybird: JWT retry on 403 (stale JWT → regenerate and retry)
        // - Both: explicit FORMAT passthrough (raw response instead of JSON)
        // - Both: secret redaction in error messages
        if (dbConfig.backend === 'tinybird') {
          if (!dbConfig.tinybirdEndpoint || !dbConfig.tinybirdAdminToken) {
            throw json({ error: 'tinybird not configured' }, { status: 400 })
          }
          const url = `${dbConfig.tinybirdEndpoint}/v0/sql`

          async function queryWithJwt(jwt: string) {
            return fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${jwt}`,
              },
              body: JSON.stringify({ q: sqlToSend }),
            })
          }

          const jwtCtx = {
            projectId: params.projectId,
            tinybirdEndpoint: dbConfig.tinybirdEndpoint,
            tinybirdAdminToken: dbConfig.tinybirdAdminToken,
            tinybirdJwt: proj.tinybirdJwt,
            tinybirdJwtDatasources: proj.tinybirdJwtDatasources,
          }

          let jwt = await getOrCreateProjectJwt(jwtCtx)
          let res = await queryWithJwt(jwt)

          if (res.status === 403) {
            // Force JWT regeneration but keep the stored datasource list so we
            // don't accidentally reference tables that haven't been deployed yet.
            jwt = await getOrCreateProjectJwt({ ...jwtCtx, tinybirdJwt: null })
            res = await queryWithJwt(jwt)
          }

          if (!res.ok) {
            const text = redact(await res.text())
            let parsed: unknown
            try { parsed = JSON.parse(text) } catch { parsed = null }
            throw json(parsed ?? { error: text }, { status: res.status })
          }

          if (hasExplicitFormat) {
            const raw = redact(await res.text())
            const contentType = res.headers.get('content-type') ?? 'text/plain'
            return { raw, contentType } satisfies QueryResult
          }
          return await res.json()
        }

        if (dbConfig.backend === 'clickhouse') {
          if (!dbConfig.clickhouseUrl) {
            throw json({ error: 'clickhouse not configured' }, { status: 400 })
          }
          const filteredSql = appendProjectFilterSettings(sqlToSend, params.projectId)
          const endpoint = `${dbConfig.clickhouseUrl}/?database=${encodeURIComponent(dbConfig.clickhouseDatabase || 'default')}&query=${encodeURIComponent(filteredSql)}`
          const res = await fetch(endpoint, {
            headers: {
              'X-ClickHouse-User': dbConfig.clickhouseUser || 'default',
              'X-ClickHouse-Key': dbConfig.clickhousePassword || '',
            },
          })
          if (!res.ok) {
            const text = redact(await res.text())
            let parsed: unknown
            try { parsed = JSON.parse(text) } catch { parsed = null }
            throw json(parsed ?? { error: text }, { status: res.status })
          }

          if (hasExplicitFormat) {
            const raw = redact(await res.text())
            const contentType = res.headers.get('content-type') ?? 'text/plain'
            return { raw, contentType } satisfies QueryResult
          }
          return await res.json()
        }

        throw json({ error: 'unknown backend' }, { status: 500 })
      },
    })
    // ── AI-powered search filter generation ────────────────────────────
    .route({
      method: 'POST',
      path: '/api/v0/projects/:projectId/generate-filter',
      request: generateFilterRequestSchema,
      response: generateFilterResponseSchema,
      detail: {
        summary: 'Generate a ClickHouse WHERE clause from natural language',
        tags: ['query'],
      },
      async handler({ request, params }) {
        const session = await requireSession(request)
        const proj = await getAccessibleProject({ userId: session.userId, projectId: params.projectId })
        if (!proj) {
          throw json({ error: 'project not found' }, { status: 404 })
        }

        const body = await request.json()
        return generateSearchFilter({
          view: body.view as AiSearchView,
          searchText: body.searchText,
          previousErrors: body.previousErrors,
          signal: request.signal,
        })
      },
    })
    // ── Issue management (status + assignee) ───────────────────────────
    // Issue state lives in ClickHouse/Tinybird via ReplacingMergeTree.
     // Writes go to the Tinybird Events API (wait=true); reads use argMax(col, Version) for dedup.
    // Both mutation routes do read-before-write to preserve the other field.
    .route({
      method: 'GET',
      path: '/api/v0/projects/:projectId/issues',
      response: issueListResponseSchema,
      async handler({ request, params }) {
        const session = await requireSession(request)
        const proj = await getAccessibleProject({ userId: session.userId, projectId: params.projectId })
        if (!proj) {
          throw json({ error: 'project not found' }, { status: 404 })
        }

        const dbConfig = proj.database
        if (!dbConfig) {
          throw json({ error: 'no database configured' }, { status: 400 })
        }

        const url = new URL(request.url)
        const fingerprintFilter = url.searchParams.get('fingerprintHash')

        let sql: string
        if (fingerprintFilter) {
          // Use argMax() instead of FINAL (Tinybird JWT subquery doesn't support FINAL)
          sql = `SELECT FingerprintHash, argMax(Status, Version) AS Status, argMax(AssigneeMemberId, Version) AS AssigneeMemberId, argMax(ResolvedAt, Version) AS ResolvedAt, argMax(ResolvedByMemberId, Version) AS ResolvedByMemberId, argMax(UpdatedAt, Version) AS UpdatedAt FROM otel_issue_state WHERE FingerprintHash = '${fingerprintFilter}' GROUP BY FingerprintHash LIMIT 1 FORMAT JSON`
        } else {
          sql = `SELECT FingerprintHash, argMax(Status, Version) AS Status, argMax(AssigneeMemberId, Version) AS AssigneeMemberId, argMax(ResolvedAt, Version) AS ResolvedAt, argMax(ResolvedByMemberId, Version) AS ResolvedByMemberId, argMax(UpdatedAt, Version) AS UpdatedAt FROM otel_issue_state GROUP BY FingerprintHash ORDER BY UpdatedAt DESC LIMIT 500 FORMAT JSON`
        }

        const result = await executeBackendQuery({ dbConfig, project: { id: params.projectId, tinybirdJwt: proj.tinybirdJwt, tinybirdJwtDatasources: proj.tinybirdJwtDatasources }, sql })
        const rows = result.data ?? []

        // Batch-resolve assignee and resolver names from D1
        const memberIds = new Set<string>()
        for (const row of rows) {
          if (row.AssigneeMemberId) memberIds.add(row.AssigneeMemberId as string)
          if (row.ResolvedByMemberId) memberIds.add(row.ResolvedByMemberId as string)
        }

        const memberMap = new Map<string, { id: string; name: string; email: string }>()
        if (memberIds.size > 0) {
          const db = getDb()
          const members = await db.query.orgMember.findMany({
            where: { orgId: proj.orgId },
            with: { user: { columns: { id: true, name: true, email: true } } },
          })
          for (const m of members) {
            if (m.user && memberIds.has(m.id)) {
              memberMap.set(m.id, { id: m.id, name: m.user.name, email: m.user.email })
            }
          }
        }

        return {
          issues: rows.map((row) => {
            const assigneeId = (row.AssigneeMemberId as string) || null
            const resolverMemberId = (row.ResolvedByMemberId as string) || null
            const assignee = assigneeId && memberMap.has(assigneeId)
              ? { memberId: assigneeId, name: memberMap.get(assigneeId)!.name, email: memberMap.get(assigneeId)!.email }
              : null
            const resolvedBy = resolverMemberId && memberMap.has(resolverMemberId)
              ? { memberId: resolverMemberId, name: memberMap.get(resolverMemberId)!.name }
              : null

            const resolvedAtRaw = row.ResolvedAt as string | null
            const resolvedAt = resolvedAtRaw ? new Date(resolvedAtRaw).getTime() : null
            const updatedAtRaw = row.UpdatedAt as string | null
            const updatedAt = updatedAtRaw ? new Date(updatedAtRaw).getTime() : null

            return {
              fingerprintHash: row.FingerprintHash as string,
              status: (row.Status as string || 'open') as 'open' | 'resolved' | 'muted' | 'ignored',
              assigneeMemberId: assigneeId,
              resolvedAt,
              resolvedByMemberId: resolverMemberId,
              updatedAt,
              assignee,
              resolvedBy,
            }
          }),
        }
      },
    })
    .route({
      method: 'PUT',
      path: '/api/v0/projects/:projectId/issues/:fingerprintHash/status',
      request: updateIssueStatusRequestSchema,
      response: issueStatusResponseSchema,
      async handler({ request, params }) {
        const session = await requireSession(request)
        const proj = await getAccessibleProject({ userId: session.userId, projectId: params.projectId })
        if (!proj) {
          throw json({ error: 'project not found' }, { status: 404 })
        }

        const dbConfig = proj.database
        if (!dbConfig) {
          throw json({ error: 'no database configured' }, { status: 400 })
        }

        const db = getDb()
        const body = await request.json()
        const now = Date.now()

        // Read current state to preserve assignee when only changing status
        const current = await readCurrentIssueState({ dbConfig, proj, projectId: params.projectId, fingerprintHash: params.fingerprintHash })

        // Resolve the current user's orgMember ID for this project's org
        let resolvedByMemberId = current.ResolvedByMemberId
        let resolvedInDeploymentIds = current.ResolvedInDeploymentIds
        if (body.status === 'resolved') {
          const member = await db.query.orgMember.findFirst({
            where: { orgId: proj.orgId, userId: session.userId },
          })
          resolvedByMemberId = member?.id ?? ''

          // Query the distinct deployment.id values currently producing this error.
          // When new errors arrive with a DIFFERENT deployment.id, we know it's a
          // regression (new deploy, same bug). Same deployment.id = old code still
          // running, safe to suppress alerts.
          resolvedInDeploymentIds = await queryActiveDeploymentIds({
            dbConfig, proj, projectId: params.projectId, fingerprintHash: params.fingerprintHash,
          })
        } else {
          // Clear resolved info when moving to non-resolved status
          resolvedByMemberId = ''
          resolvedInDeploymentIds = ''
        }
        const resolvedAt = body.status === 'resolved' ? new Date(now).toISOString() : null

        await writeIssueState({
          dbConfig,
          row: {
            ProjectId: params.projectId,
            FingerprintHash: params.fingerprintHash,
            Status: body.status,
            AssigneeMemberId: current.AssigneeMemberId,
            ResolvedAt: resolvedAt,
            ResolvedByMemberId: resolvedByMemberId,
            LastAlertedAt: current.LastAlertedAt,
            ResolvedInDeploymentIds: resolvedInDeploymentIds,
            Version: now,
            UpdatedAt: new Date(now).toISOString(),
          },
        })

        return { ok: true, status: body.status }
      },
    })
    .route({
      method: 'PUT',
      path: '/api/v0/projects/:projectId/issues/:fingerprintHash/assignee',
      request: updateIssueAssigneeRequestSchema,
      response: issueAssigneeResponseSchema,
      async handler({ request, params }) {
        const session = await requireSession(request)
        const proj = await getAccessibleProject({ userId: session.userId, projectId: params.projectId })
        if (!proj) {
          throw json({ error: 'project not found' }, { status: 404 })
        }

        const dbConfig = proj.database
        if (!dbConfig) {
          throw json({ error: 'no database configured' }, { status: 400 })
        }

        const body = await request.json()
        const db = getDb()
        const now = Date.now()

        // Validate assignee member belongs to this org
        if (body.assigneeMemberId) {
          const member = await db.query.orgMember.findFirst({
            where: { id: body.assigneeMemberId, orgId: proj.orgId },
          })
          if (!member) {
            throw json({ error: 'member not found in this org' }, { status: 400 })
          }
        }

        // Read current state to preserve status when only changing assignee
        const current = await readCurrentIssueState({ dbConfig, proj, projectId: params.projectId, fingerprintHash: params.fingerprintHash })

        await writeIssueState({
          dbConfig,
          row: {
            ProjectId: current.ProjectId,
            FingerprintHash: current.FingerprintHash,
            Status: current.Status,
            AssigneeMemberId: body.assigneeMemberId ?? '',
            ResolvedAt: current.ResolvedAt,
            ResolvedByMemberId: current.ResolvedByMemberId,
            LastAlertedAt: current.LastAlertedAt,
            ResolvedInDeploymentIds: current.ResolvedInDeploymentIds,
            Version: now,
            UpdatedAt: new Date(now).toISOString(),
          },
        })

        return { ok: true }
      },
    })
    // ── Alert management ──────────────────────────────────────────────
    // Alert rules and destinations are org-scoped. Rules define what to
    // watch (error_threshold, health_check). Destinations define where to
    // send (email, webhook, slack). They are linked many-to-many via
    // alert_rule_destination. Multiple rules per org are supported;
    // project-scoped rules override org-wide rules for the same project.
    .route({
      method: 'GET',
      path: '/api/v0/orgs/:orgId/alerts',
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const rules = await db.query.alertRule.findMany({
          where: { orgId: params.orgId },
          with: { destinations: true, project: true },
        })

        return {
          rules: rules.map((r) => ({
            id: r.id,
            name: r.name,
            type: r.type,
            enabled: r.enabled,
            projectId: r.projectId,
            projectSlug: r.project?.slug ?? null,
            errorThreshold: r.errorThreshold,
            errorWindowMinutes: r.errorWindowMinutes,
            cooldownMinutes: r.cooldownMinutes,
            // health_check fields
            checkUrl: r.checkUrl,
            checkMethod: r.checkMethod,
            checkSchedule: r.checkSchedule,
            checkTimeoutMs: r.checkTimeoutMs,
            checkFailureThreshold: r.checkFailureThreshold,
            destinations: r.destinations.map((d) => ({
              id: d.id,
              channel: d.channel,
              destination: d.destination,
            })),
          })),
        }
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/:orgId/alerts',
      request: z.object({
        name: z.string().min(1),
        projectId: z.string().min(1).nullable().optional(),
        errorThreshold: z.number().int().min(1).optional(),
        errorWindowMinutes: z.number().int().min(1).optional(),
        cooldownMinutes: z.number().int().min(1).optional(),
        // Optional: create a destination inline and link it
        channel: z.enum(['email', 'webhook', 'slack']).optional(),
        destination: z.string().min(1).optional(),
      }),
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'admin access required' }, { status: 403 })
        }

        const db = getDb()
        const body = await request.json()

        // Validate channel and destination must be provided together
        const hasChannel = body.channel != null
        const hasDestination = body.destination != null
        if (hasChannel !== hasDestination) {
          throw json({ error: 'channel and destination must be provided together' }, { status: 400 })
        }

        if (body.projectId != null) {
          const proj = await db.query.project.findFirst({
            where: { id: body.projectId, orgId: params.orgId },
          })
          if (!proj) {
            throw json({ error: 'project not found in this org' }, { status: 404 })
          }
        }

        const [rule] = await db.insert(schema.alertRule)
          .values({
            orgId: params.orgId,
            type: 'error_threshold',
            name: body.name,
            projectId: body.projectId ?? null,
            errorThreshold: body.errorThreshold ?? 1,
            errorWindowMinutes: body.errorWindowMinutes ?? 5,
            cooldownMinutes: body.cooldownMinutes ?? 60,
          })
          .returning()

        // If channel/destination provided, create the destination inline
        // and link it to ALL existing rules in the org (not just the new one)
        if (body.channel && body.destination) {
          const [dest] = await db.insert(schema.alertDestination)
            .values({
              orgId: params.orgId,
              channel: body.channel,
              destination: body.destination,
            })
            .onConflictDoNothing()
            .returning()

          const destination = dest ?? await db.query.alertDestination.findFirst({
            where: { orgId: params.orgId, channel: body.channel, destination: body.destination },
          })

          if (destination) {
            // Link to all existing rules in the org
            const allRules = await db.query.alertRule.findMany({
              where: { orgId: params.orgId },
            })
            for (const r of allRules) {
              await db.insert(schema.alertRuleDestination)
                .values({ ruleId: r.id, destinationId: destination.id })
                .onConflictDoNothing()
            }
          }
        }

        // Auto-link all existing org destinations to the new rule
        const existingDests = await db.query.alertDestination.findMany({
          where: { orgId: params.orgId },
        })
        for (const dest of existingDests) {
          await db.insert(schema.alertRuleDestination)
            .values({ ruleId: rule!.id, destinationId: dest.id })
            .onConflictDoNothing()
        }

        return { id: rule!.id, ok: true }
      },
    })
    .route({
      method: 'PUT',
      path: '/api/v0/orgs/:orgId/alerts/:ruleId',
      request: z.object({
        name: z.string().min(1).optional(),
        errorThreshold: z.number().int().min(1).optional(),
        errorWindowMinutes: z.number().int().min(1).optional(),
        cooldownMinutes: z.number().int().min(1).optional(),
      }),
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'admin access required' }, { status: 403 })
        }

        const db = getDb()
        const body = await request.json()

        const rule = await db.query.alertRule.findFirst({
          where: { id: params.ruleId, orgId: params.orgId, type: 'error_threshold' },
        })
        if (!rule) {
          throw json({ error: 'alert rule not found' }, { status: 404 })
        }

        const updates: Record<string, unknown> = { updatedAt: Date.now() }
        if (body.name != null) updates.name = body.name
        if (body.errorThreshold != null) updates.errorThreshold = body.errorThreshold
        if (body.errorWindowMinutes != null) updates.errorWindowMinutes = body.errorWindowMinutes
        if (body.cooldownMinutes != null) updates.cooldownMinutes = body.cooldownMinutes

        await db.update(schema.alertRule)
          .set(updates)
          .where(orm.eq(schema.alertRule.id, params.ruleId))
          .limit(1)

        return { ok: true }
      },
    })
    .route({
      method: 'DELETE',
      path: '/api/v0/orgs/:orgId/alerts/:ruleId',
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'admin access required' }, { status: 403 })
        }

        const db = getDb()
        const rule = await db.query.alertRule.findFirst({
          where: { id: params.ruleId, orgId: params.orgId, type: 'error_threshold' },
        })
        if (!rule) {
          throw json({ error: 'alert rule not found' }, { status: 404 })
        }

        await db.delete(schema.alertRule)
          .where(orm.eq(schema.alertRule.id, params.ruleId))
          .limit(1)

        return { ok: true }
      },
    })
    // ── Destinations ────────────────────────────────────────────────
    .route({
      method: 'GET',
      path: '/api/v0/orgs/:orgId/destinations',
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const destinations = await db.query.alertDestination.findMany({
          where: { orgId: params.orgId },
        })

        return {
          destinations: destinations.map((d) => ({
            id: d.id,
            channel: d.channel,
            destination: d.destination,
          })),
        }
      },
    })
    .route({
      method: 'DELETE',
      path: '/api/v0/orgs/:orgId/destinations/:destinationId',
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'admin access required' }, { status: 403 })
        }

        const db = getDb()
        const dest = await db.query.alertDestination.findFirst({
          where: { id: params.destinationId, orgId: params.orgId },
        })
        if (!dest) {
          throw json({ error: 'destination not found' }, { status: 404 })
        }

        // Cascade: junction rows are deleted by FK cascade on alertRuleDestination
        await db.delete(schema.alertDestination)
          .where(orm.eq(schema.alertDestination.id, params.destinationId))
          .limit(1)

        return { ok: true }
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/:orgId/alerts/test',
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'admin access required' }, { status: 403 })
        }

        const db = getDb()
        const destinations = await db.query.alertDestination.findMany({
          where: { orgId: params.orgId },
        })

        if (destinations.length === 0) {
          throw json({ error: 'no alert destinations configured' }, { status: 400 })
        }

        const orgRow = await db.query.org.findFirst({ where: { id: params.orgId } })
        const orgName = orgRow?.name || 'Unknown'

        const { buildTestAlertEmailHtml } = await import('./alert-email.tsx')
        const results: Array<{ channel: string; destination: string; ok: boolean }> = []

        for (const dest of destinations) {
          try {
            if (dest.channel === 'email') {
              const html = await buildTestAlertEmailHtml(orgName)
              await env.EMAIL.send({
                from: { email: 'alerts@updates.strada.sh', name: 'Strada' },
                to: dest.destination,
                subject: '[Strada] Test alert',
                html,
              })
              results.push({ channel: dest.channel, destination: dest.destination, ok: true })
            } else if (dest.channel === 'webhook') {
              const res = await fetch(dest.destination, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'test_alert', org: orgName }),
              })
              results.push({ channel: dest.channel, destination: dest.destination, ok: res.ok })
            }
          } catch (err) {
            logger.error({ message: 'test alert failed', channel: dest.channel, destination: dest.destination, error: String(err) })
            results.push({ channel: dest.channel, destination: dest.destination, ok: false })
          }
        }

        return { results }
      },
    })
    // ── Health check management ───────────────────────────────────────
    // Health check rules are alert_rule rows with type = 'health_check'.
    // Config and mutable state live in D1. Check results are append-only
    // in ClickHouse (otel_health_checks).
    .route({
      method: 'GET',
      path: '/api/v0/orgs/:orgId/checks',
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const rules = await db.query.alertRule.findMany({
          where: { orgId: params.orgId, type: 'health_check' },
          with: { destinations: true, project: true },
        })
        const dbConfig = await db.query.database.findFirst({ where: { orgId: params.orgId } })
        const summaries = dbConfig ? await queryCheckSummaries({ dbConfig, rules }) : new Map<string, CheckSummary>()

        return {
          checks: rules.map((r) => ({
            id: r.id,
            name: r.name,
            enabled: r.enabled,
            disabledReason: r.checkDisabledReason || null,
            alertStatus: r.checkLastAlertStatus || null,
            firstFailedAt: r.checkFirstFailedAt,
            lastAlertedAt: r.lastAlertedAt,
            summary: summaries.get(r.id) ?? null,
            url: r.checkUrl,
            method: r.checkMethod ?? 'GET',
            schedule: r.checkSchedule ?? '*/5 * * * *',
            expectedStatusMin: r.checkExpectedStatusMin ?? 200,
            expectedStatusMax: r.checkExpectedStatusMax ?? 299,
            timeoutMs: r.checkTimeoutMs ?? 10000,
            failureThreshold: r.checkFailureThreshold ?? 2,
            autoDisableAfterHours: r.checkAutoDisableAfterHours ?? 24,
            projectId: r.projectId,
            projectSlug: r.project?.slug ?? null,
            cooldownMinutes: r.cooldownMinutes,
            destinations: r.destinations.map((d) => ({
              id: d.id,
              channel: d.channel,
              destination: d.destination,
            })),
          })),
        }
      },
    })
    .route({
      method: 'GET',
      path: '/api/v0/orgs/:orgId/checks/:checkId/results',
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(20) }),
      async handler({ request, params, query }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const rule = await db.query.alertRule.findFirst({
          where: { id: params.checkId, orgId: params.orgId, type: 'health_check' },
          with: { project: true },
        })
        if (!rule) {
          throw json({ error: 'health check not found' }, { status: 404 })
        }
        if (!rule.project) {
          throw json({ error: 'health check has no project' }, { status: 409 })
        }
        const dbConfig = await db.query.database.findFirst({ where: { orgId: params.orgId } })
        if (!dbConfig) {
          throw json({ error: 'database not configured' }, { status: 409 })
        }

        const sql = dedent`
          SELECT
            toUnixTimestamp64Milli(Timestamp) AS Ts,
            StatusCode, LatencyMs, Success, ErrorMessage, ResponseBody
          FROM otel_health_checks
          WHERE CheckId = '${rule.id}'
            AND Timestamp >= now() - INTERVAL 90 DAY
          ORDER BY Timestamp DESC
          LIMIT ${query.limit}
          FORMAT JSON
        `
        const result = await executeBackendQuery({ dbConfig, project: rule.project, sql }).catch((err: unknown) => {
          logger.error({ message: 'check results query failed', checkId: rule.id, error: String(err) })
          throw json({ error: 'failed to query check results' }, { status: 502 })
        })
        const results: CheckResultRow[] = (result.data ?? []).map((row) => ({
          timestamp: Number(row.Ts),
          statusCode: Number(row.StatusCode),
          latencyMs: Number(row.LatencyMs),
          success: Number(row.Success) === 1,
          errorMessage: String(row.ErrorMessage ?? ''),
          responseBody: String(row.ResponseBody ?? ''),
        }))
        return { results }
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/:orgId/checks',
      request: z.object({
        name: z.string().min(1),
        url: z.string().url(),
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']).default('GET'),
        schedule: z.string().refine(isValidCron, {
          message: 'schedule must be a valid 5-field UTC cron expression',
        }).default('*/5 * * * *'),
        expectedStatusMin: z.number().int().min(100).max(599).default(200),
        expectedStatusMax: z.number().int().min(100).max(599).default(299),
        timeoutMs: z.number().int().min(1000).max(60000).default(10000),
        failureThreshold: z.number().int().min(1).max(100).default(2),
        autoDisableAfterHours: z.number().int().min(0).max(720).default(24),
        cooldownMinutes: z.number().int().min(1).default(60),
        projectId: z.string().min(1).nullable().optional(),
      }),
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'admin access required' }, { status: 403 })
        }

        const db = getDb()
        const body = await request.json()

        // Require at least one project in the org for ClickHouse scoping
        const projectRow = body.projectId
          ? await db.query.project.findFirst({ where: { id: body.projectId, orgId: params.orgId } })
          : await db.query.project.findFirst({ where: { orgId: params.orgId } })
        if (!projectRow) {
          throw json({ error: body.projectId ? 'project not found in this org' : 'create a project before creating health checks' }, { status: 400 })
        }

        // Create the health_check alert rule
        const [rule] = await db.insert(schema.alertRule)
          .values({
            orgId: params.orgId,
            type: 'health_check',
            name: body.name,
            // Always set: results are written and read with this project's scope.
            projectId: projectRow.id,
            cooldownMinutes: body.cooldownMinutes,
            checkUrl: body.url,
            checkMethod: body.method,
            checkSchedule: body.schedule,
            checkExpectedStatusMin: body.expectedStatusMin,
            checkExpectedStatusMax: body.expectedStatusMax,
            checkTimeoutMs: body.timeoutMs,
            checkFailureThreshold: body.failureThreshold,
            checkAutoDisableAfterHours: body.autoDisableAfterHours,
          })
          .returning()

        // Auto-link existing destinations for this org
        const destinations = await db.query.alertDestination.findMany({
          where: { orgId: params.orgId },
        })
        for (const dest of destinations) {
          await db.insert(schema.alertRuleDestination)
            .values({ ruleId: rule!.id, destinationId: dest.id })
            .onConflictDoNothing()
        }

        return { id: rule!.id, ok: true }
      },
    })
    .route({
      method: 'PUT',
      path: '/api/v0/orgs/:orgId/checks/:checkId',
      request: z.object({
        name: z.string().min(1).optional(),
        url: z.string().url().optional(),
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']).optional(),
        schedule: z.string().refine(isValidCron, {
          message: 'schedule must be a valid 5-field UTC cron expression',
        }).optional(),
        expectedStatusMin: z.number().int().min(100).max(599).optional(),
        expectedStatusMax: z.number().int().min(100).max(599).optional(),
        timeoutMs: z.number().int().min(1000).max(60000).optional(),
        failureThreshold: z.number().int().min(1).max(100).optional(),
        autoDisableAfterHours: z.number().int().min(0).max(720).optional(),
        cooldownMinutes: z.number().int().min(1).optional(),
        enabled: z.boolean().optional(),
      }),
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'admin access required' }, { status: 403 })
        }

        const db = getDb()
        const body = await request.json()

        const rule = await db.query.alertRule.findFirst({
          where: { id: params.checkId, orgId: params.orgId, type: 'health_check' },
        })
        if (!rule) {
          throw json({ error: 'health check not found' }, { status: 404 })
        }

        const updates: Record<string, unknown> = { updatedAt: Date.now() }
        if (body.name != null) updates.name = body.name
        if (body.url != null) updates.checkUrl = body.url
        if (body.method != null) updates.checkMethod = body.method
        if (body.schedule != null) updates.checkSchedule = body.schedule
        if (body.expectedStatusMin != null) updates.checkExpectedStatusMin = body.expectedStatusMin
        if (body.expectedStatusMax != null) updates.checkExpectedStatusMax = body.expectedStatusMax
        if (body.timeoutMs != null) updates.checkTimeoutMs = body.timeoutMs
        if (body.failureThreshold != null) updates.checkFailureThreshold = body.failureThreshold
        if (body.autoDisableAfterHours != null) updates.checkAutoDisableAfterHours = body.autoDisableAfterHours
        if (body.cooldownMinutes != null) updates.cooldownMinutes = body.cooldownMinutes

        // Handle enable/disable with state reset
        if (body.enabled === false) {
          updates.enabled = false
          updates.checkDisabledReason = 'manual'
        }
        if (body.enabled === true) {
          updates.enabled = true
          updates.checkDisabledReason = ''
          updates.checkFirstFailedAt = null
          updates.checkLastAlertStatus = ''
          updates.lastAlertedAt = null
        }

        await db.update(schema.alertRule)
          .set(updates)
          .where(orm.eq(schema.alertRule.id, params.checkId))
          .limit(1)

        return { ok: true }
      },
    })
    .route({
      method: 'DELETE',
      path: '/api/v0/orgs/:orgId/checks/:checkId',
      async handler({ request, params }) {
        const session = await requireSession(request)
        const member = await requireOrgMember(session.userId, params.orgId)
        if (member.role !== 'admin') {
          throw json({ error: 'admin access required' }, { status: 403 })
        }

        const db = getDb()

        const rule = await db.query.alertRule.findFirst({
          where: { id: params.checkId, orgId: params.orgId, type: 'health_check' },
        })
        if (!rule) {
          throw json({ error: 'health check not found' }, { status: 404 })
        }

        // Delete the rule itself (cascade handles junction table cleanup)
        await db.delete(schema.alertRule)
          .where(orm.eq(schema.alertRule.id, params.checkId))
          .limit(1)

        return { ok: true }
      },
    })
