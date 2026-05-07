// Website API routes. Org/project management, database config, and query bridge under /api/v0.

import { json, Spiceflow } from 'spiceflow'
import { z } from 'zod'
import dedent from 'string-dedent'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { ulid } from 'ulid'
import { env } from 'cloudflare:workers'
import { trace } from '@strada.sh/sdk'
import { deployTinybirdResources, getDeploymentManagedReadToken, TinybirdClient } from 'strada/src/tinybird'
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
    console.error('queryActiveDeploymentIds failed:', err)
    return ''
  }
}

/** Write a row to otel_issue_state via the shared insertBackendRow helper. */
async function writeIssueState(ctx: { dbConfig: DbConfig; row: IssueStateRow }): Promise<void> {
  try {
    await insertBackendRow({ dbConfig: ctx.dbConfig, table: 'otel_issue_state', row: { ...ctx.row } })
  } catch (err) {
    console.error('writeIssueState failed:', err)
    throw json({ error: 'failed to write issue state' }, { status: 500 })
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

export const api = new Spiceflow({ tracer })
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

        const db = getDb()
        const existing = access.database
        if (!existing) {
          throw json({ error: 'no database config for this org' }, { status: 404 })
        }
        if (existing.backend !== 'tinybird') {
          throw json({ error: 'database upgrade only supports Tinybird backends' }, { status: 400 })
        }
        if (!existing.tinybirdEndpoint || !existing.tinybirdAdminToken) {
          throw json({ error: 'missing Tinybird endpoint or admin token for this org' }, { status: 400 })
        }

        const client = new TinybirdClient({
          baseUrl: existing.tinybirdEndpoint,
          token: existing.tinybirdAdminToken,
        })

        const deployment = await deployTinybirdResources({
          client,
          datasources: [...bundledTinybirdResources.datasources],
          pipes: [...bundledTinybirdResources.pipes],
        })
        if (deployment instanceof Error) {
          throw json({ error: deployment.message }, { status: 502 })
        }

        const readToken = await getDeploymentManagedReadToken(client)
        if (readToken instanceof Error) {
          throw json({ error: readToken.message }, { status: 502 })
        }

        const updatedAt = Date.now()
        await db.batch([
          db.update(schema.database)
            .set({ tinybirdReadToken: readToken.token, updatedAt })
            .where(orm.eq(schema.database.id, existing.id)),
          db.update(schema.project)
            .set({ tinybirdJwt: null, tinybirdJwtDatasources: null, updatedAt })
            .where(orm.eq(schema.project.orgId, params.orgId)),
        ])

        return {
          ok: true,
          result: deployment.result,
          backend: existing.backend,
          tinybirdEndpoint: existing.tinybirdEndpoint,
        }
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
        await db.delete(schema.project).where(orm.eq(schema.project.id, params.id))
        return { ok: true }
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
            jwt = await getOrCreateProjectJwt({ ...jwtCtx, tinybirdJwt: null, tinybirdJwtDatasources: null })
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
    // send (email, webhook, slack). They are linked many-to-many
    // via alert_rule_destination. The cron handler in alert-check.ts reads
    // these rules to decide when and where to send notifications.
    //
    // These routes currently operate on error_threshold rules only. The
    // CLI's "alerts add" creates an error_threshold rule with a default
    // name, auto-linking the destination. Future routes will handle
    // health_check rules separately.
    .route({
      method: 'GET',
      path: '/api/v0/orgs/:orgId/alerts',
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()

        // Find the first error_threshold rule for this org (legacy: one per org)
        const rule = await db.query.alertRule.findFirst({
          where: { orgId: params.orgId, type: 'error_threshold' },
          with: { destinations: true },
        })

        if (!rule) {
          return { rule: null, destinations: [] }
        }

        return {
          rule: {
            id: rule.id,
            name: rule.name,
            type: rule.type,
            enabled: rule.enabled,
            errorThreshold: rule.errorThreshold,
            errorWindowMinutes: rule.errorWindowMinutes,
            cooldownMinutes: rule.cooldownMinutes,
          },
          destinations: rule.destinations.map((d) => ({
            id: d.id,
            channel: d.channel,
            destination: d.destination,
          })),
        }
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/:orgId/alerts/destinations',
      request: z.object({
        channel: z.enum(['email', 'webhook', 'slack']),
        destination: z.string().min(1),
        errorThreshold: z.number().int().min(1).optional(),
        errorWindowMinutes: z.number().int().min(1).optional(),
        cooldownMinutes: z.number().int().min(1).optional(),
      }),
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const body = await request.json()

        // Upsert the error_threshold rule for this org (default name)
        let rule = await db.query.alertRule.findFirst({
          where: { orgId: params.orgId, type: 'error_threshold' },
        })

        if (!rule) {
          const [created] = await db.insert(schema.alertRule)
            .values({
              orgId: params.orgId,
              type: 'error_threshold',
              name: 'Error alerts',
              errorThreshold: body.errorThreshold ?? 1,
              errorWindowMinutes: body.errorWindowMinutes ?? 5,
              cooldownMinutes: body.cooldownMinutes ?? 60,
            })
            .returning()
          rule = created!
        } else if (body.errorThreshold || body.errorWindowMinutes || body.cooldownMinutes) {
          await db.update(schema.alertRule)
            .set({
              ...(body.errorThreshold != null ? { errorThreshold: body.errorThreshold } : {}),
              ...(body.errorWindowMinutes != null ? { errorWindowMinutes: body.errorWindowMinutes } : {}),
              ...(body.cooldownMinutes != null ? { cooldownMinutes: body.cooldownMinutes } : {}),
              updatedAt: Date.now(),
            })
            .where(orm.eq(schema.alertRule.id, rule.id))
        }

        // Upsert destination (org-scoped, unique on org+channel+destination)
        const [dest] = await db.insert(schema.alertDestination)
          .values({
            orgId: params.orgId,
            channel: body.channel,
            destination: body.destination,
          })
          .onConflictDoNothing()
          .returning()

        // If destination already existed, look it up
        const destination = dest ?? await db.query.alertDestination.findFirst({
          where: {
            orgId: params.orgId,
            channel: body.channel,
            destination: body.destination,
          },
        })

        if (destination) {
          // Link destination to this rule (ignore if already linked).
          // Same-org is guaranteed because both rule and destination were
          // created/looked up with orgId = params.orgId above.
          await db.insert(schema.alertRuleDestination)
            .values({ ruleId: rule.id, destinationId: destination.id })
            .onConflictDoNothing()
        }

        return { ok: true }
      },
    })
    .route({
      method: 'PUT',
      path: '/api/v0/orgs/:orgId/alerts',
      request: z.object({
        errorThreshold: z.number().int().min(1).optional(),
        errorWindowMinutes: z.number().int().min(1).optional(),
        cooldownMinutes: z.number().int().min(1).optional(),
      }),
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const body = await request.json()

        const rule = await db.query.alertRule.findFirst({
          where: { orgId: params.orgId, type: 'error_threshold' },
        })
        if (!rule) {
          throw json({ error: 'no alert rule configured, add a destination first' }, { status: 404 })
        }

        await db.update(schema.alertRule)
          .set({
            ...(body.errorThreshold != null ? { errorThreshold: body.errorThreshold } : {}),
            ...(body.errorWindowMinutes != null ? { errorWindowMinutes: body.errorWindowMinutes } : {}),
            ...(body.cooldownMinutes != null ? { cooldownMinutes: body.cooldownMinutes } : {}),
            updatedAt: Date.now(),
          })
          .where(orm.eq(schema.alertRule.id, rule.id))

        return { ok: true }
      },
    })
    .route({
      method: 'DELETE',
      path: '/api/v0/orgs/:orgId/alerts/destinations/:destinationId',
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()

        // Verify the destination belongs to this org
        const dest = await db.query.alertDestination.findFirst({
          where: {
            id: params.destinationId,
            orgId: params.orgId,
          },
        })
        if (!dest) {
          throw json({ error: 'destination not found' }, { status: 404 })
        }

        // Remove all junction links first, then delete the destination itself.
        // Destinations are org-scoped and reusable across rules, so deleting
        // one removes it from every rule it was attached to. The CLI currently
        // only creates one rule per org so this is fine. If we later need
        // "unlink from one rule" without destroying the destination, add a
        // separate DELETE /alerts/rules/:ruleId/destinations/:destinationId.
        await db.delete(schema.alertRuleDestination)
          .where(orm.eq(schema.alertRuleDestination.destinationId, params.destinationId))
        await db.delete(schema.alertDestination)
          .where(orm.eq(schema.alertDestination.id, params.destinationId))

        return { ok: true }
      },
    })
    .route({
      method: 'POST',
      path: '/api/v0/orgs/:orgId/alerts/test',
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()

        // Load all destinations for this org (test all, not just one rule's)
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
              await fetch(dest.destination, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'test_alert', org: orgName }),
              })
              results.push({ channel: dest.channel, destination: dest.destination, ok: true })
            }
          } catch (err) {
            console.error(`Test alert failed for ${dest.channel}:${dest.destination}`, err)
            results.push({ channel: dest.channel, destination: dest.destination, ok: false })
          }
        }

        return { results }
      },
    })
