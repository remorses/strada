// Website API routes. Org/project management, database config, and query bridge under /api/v0.

import { json, Spiceflow } from 'spiceflow'
import { z } from 'zod'
import dedent from 'string-dedent'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { ulid } from 'ulid'
import { env } from 'cloudflare:workers'
import { deployTinybirdResources, getDeploymentManagedReadToken, TinybirdClient } from 'strada/src/tinybird'
import { bundledTinybirdResources } from './tinybird-bundled-resources.ts'
import {
  getAccessibleOrgDatabase,
  getAccessibleProject,
  getAccessibleProjectToken,
  getDb,
  getOrCreateProjectJwt,
  hashToken,
  generateProjectToken,
  requireOrgMember,
  requireSession,
} from './db.ts'

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

const createProjectTokenRequestSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(['ingest', 'read']),
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

export interface QueryResponse {
  data?: Record<string, unknown>[]
  rows?: number
  meta?: { name: string; type: string }[]
  statistics?: { elapsed: number; rows_read: number; bytes_read: number }
  raw?: string
  contentType?: string
}

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
// keeping only the row with the highest Version. Reads use FINAL to
// force deduplication at query time. Writes use wait=true on Tinybird
// to guarantee read-after-write consistency (important because status
// and assignee updates do read-before-write to preserve the other field).

interface IssueStateRow {
  project_id: string
  fingerprint_hash: string
  status: string
  assignee_member_id: string
  resolved_at: string | null
  resolved_by_member_id: string
  last_alerted_at: string | null
  version: number
  updated_at: string
}

interface QueryTinybirdCtx {
  dbConfig: { backend: string; tinybirdEndpoint: string | null; tinybirdAdminToken: string | null; clickhouseUrl: string | null; clickhouseDatabase: string | null; clickhouseUser: string | null; clickhousePassword: string | null }
  proj: { tinybirdJwt: string | null; tinybirdJwtDatasources: string | null }
  projectId: string
  sql: string
}

/** Run a SQL query against Tinybird/ClickHouse using the project JWT. Throws on failure. */
async function queryIssueState(ctx: QueryTinybirdCtx): Promise<QueryResponse> {
  const { dbConfig, proj, projectId, sql } = ctx
  if (dbConfig.backend === 'tinybird') {
    if (!dbConfig.tinybirdEndpoint || !dbConfig.tinybirdAdminToken) {
      throw json({ error: 'tinybird not configured' }, { status: 400 })
    }
    const jwtCtx = {
      projectId,
      tinybirdEndpoint: dbConfig.tinybirdEndpoint,
      tinybirdAdminToken: dbConfig.tinybirdAdminToken,
      tinybirdJwt: proj.tinybirdJwt,
      tinybirdJwtDatasources: proj.tinybirdJwtDatasources,
    }
    const jwt = await getOrCreateProjectJwt(jwtCtx)
    const res = await fetch(`${dbConfig.tinybirdEndpoint}/v0/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ q: sql }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw json({ error: `issue state query failed: ${text}` }, { status: res.status })
    }
    return await res.json()
  }
  if (dbConfig.backend === 'clickhouse') {
    if (!dbConfig.clickhouseUrl) {
      throw json({ error: 'clickhouse not configured' }, { status: 400 })
    }
    const endpoint = `${dbConfig.clickhouseUrl}/?database=${encodeURIComponent(dbConfig.clickhouseDatabase || 'default')}&query=${encodeURIComponent(sql)}`
    const res = await fetch(endpoint, {
      headers: {
        'X-ClickHouse-User': dbConfig.clickhouseUser || 'default',
        'X-ClickHouse-Key': dbConfig.clickhousePassword || '',
      },
    })
    if (!res.ok) {
      const text = await res.text()
      throw json({ error: `issue state query failed: ${text}` }, { status: res.status })
    }
    return await res.json()
  }
  throw json({ error: 'unknown backend' }, { status: 500 })
}

/**
 * Read current issue state for a fingerprint. Returns defaults if no row exists yet.
 * Used by both status and assignee routes to preserve the other field on partial updates.
 */
async function readCurrentIssueState(ctx: Omit<QueryTinybirdCtx, 'sql'> & { fingerprintHash: string }): Promise<IssueStateRow> {
  const { dbConfig, proj, projectId, fingerprintHash } = ctx
  // For ClickHouse backend, add explicit ProjectId filter since there's no JWT row-level filtering
  const projectFilter = dbConfig.backend === 'clickhouse' ? ` AND ProjectId = '${projectId}'` : ''
  const sql = `SELECT Status, AssigneeMemberId, ResolvedAt, ResolvedByMemberId, LastAlertedAt FROM otel_issue_state FINAL WHERE FingerprintHash = '${fingerprintHash}'${projectFilter} LIMIT 1 FORMAT JSON`
  try {
    const result = await queryIssueState({ dbConfig, proj, projectId, sql })
    const row = result.data?.[0]
    if (row) {
      return {
        project_id: projectId,
        fingerprint_hash: fingerprintHash,
        status: (row.Status as string) || 'open',
        assignee_member_id: (row.AssigneeMemberId as string) || '',
        resolved_at: (row.ResolvedAt as string) || null,
        resolved_by_member_id: (row.ResolvedByMemberId as string) || '',
        last_alerted_at: (row.LastAlertedAt as string) || null,
        version: 0,
        updated_at: '',
      }
    }
  } catch {
    // No existing state; return defaults for a new issue
  }
  return {
    project_id: projectId,
    fingerprint_hash: fingerprintHash,
    status: 'open',
    assignee_member_id: '',
    resolved_at: null,
    resolved_by_member_id: '',
    last_alerted_at: null,
    version: 0,
    updated_at: '',
  }
}

/**
 * Write a row to otel_issue_state via Tinybird Events API or ClickHouse INSERT.
 * Tinybird writes use wait=true for read-after-write consistency.
 */
async function writeIssueState(ctx: { dbConfig: QueryTinybirdCtx['dbConfig']; row: IssueStateRow }): Promise<void> {
  const { dbConfig, row } = ctx
  const ndjson = JSON.stringify(row)

  if (dbConfig.backend === 'tinybird') {
    if (!dbConfig.tinybirdEndpoint || !dbConfig.tinybirdAdminToken) {
      throw json({ error: 'tinybird not configured' }, { status: 400 })
    }
    // wait=true ensures the row is visible to subsequent reads before we return.
    // Without it, a quick status change followed by an assignee update could
    // read stale state and overwrite the status.
    const res = await fetch(`${dbConfig.tinybirdEndpoint}/v0/events?name=otel_issue_state&wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${dbConfig.tinybirdAdminToken}`,
      },
      body: ndjson,
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`Failed to write issue state to Tinybird: ${res.status} ${text}`)
      throw json({ error: 'failed to write issue state' }, { status: 500 })
    }
    // Validate the row actually landed (not quarantined)
    const resBody = await res.json().catch(() => null) as null | {
      successful_rows?: number
      quarantined_rows?: number
    }
    if (resBody && ((resBody.quarantined_rows ?? 0) > 0 || (resBody.successful_rows ?? 0) !== 1)) {
      console.error(`Tinybird issue state write warning: ${JSON.stringify(resBody)}`)
      throw json({ error: 'failed to write issue state' }, { status: 500 })
    }
    return
  }

  if (dbConfig.backend === 'clickhouse') {
    if (!dbConfig.clickhouseUrl) {
      throw json({ error: 'clickhouse not configured' }, { status: 400 })
    }
    // For ClickHouse, remap to PascalCase and INSERT
    const chRow = {
      ProjectId: row.project_id,
      FingerprintHash: row.fingerprint_hash,
      Status: row.status,
      AssigneeMemberId: row.assignee_member_id,
      ResolvedAt: row.resolved_at,
      ResolvedByMemberId: row.resolved_by_member_id,
      LastAlertedAt: row.last_alerted_at,
      Version: row.version,
      UpdatedAt: row.updated_at,
    }
    const insertSql = `INSERT INTO otel_issue_state FORMAT JSONEachRow`
    const endpoint = `${dbConfig.clickhouseUrl}/?database=${encodeURIComponent(dbConfig.clickhouseDatabase || 'default')}&query=${encodeURIComponent(insertSql)}`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ClickHouse-User': dbConfig.clickhouseUser || 'default',
        'X-ClickHouse-Key': dbConfig.clickhousePassword || '',
      },
      body: JSON.stringify(chRow),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`Failed to write issue state to ClickHouse: ${res.status} ${text}`)
      throw json({ error: 'failed to write issue state' }, { status: 500 })
    }
    return
  }

  throw json({ error: 'unknown backend' }, { status: 500 })
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

export const api = new Spiceflow()
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

        return {
          id: proj.id,
          slug: proj.slug,
          ingestEndpoint: `https://${proj.id}-ingest.strada.sh`,
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
      path: '/api/v0/projects/:projectId/tokens',
      request: createProjectTokenRequestSchema,
      async handler({ request, params }) {
        const session = await requireSession(request)
        const proj = await getAccessibleProject({ userId: session.userId, projectId: params.projectId })
        if (!proj) {
          throw json({ error: 'project not found' }, { status: 404 })
        }
        if (proj.accessRole !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }

        const db = getDb()
        const body = await request.json()
        const { fullKey, prefix } = generateProjectToken()
        const hashed = await hashToken(fullKey)

        await db.insert(schema.projectToken).values({
          projectId: params.projectId,
          name: body.name,
          prefix,
          hashedKey: hashed,
          scope: body.scope,
          createdBy: session.userId,
        })

        return { key: fullKey, prefix: `str_${prefix}...`, name: body.name, scope: body.scope }
      },
    })
    .get('/api/v0/projects/:projectId/tokens', async ({ request, params }) => {
      const session = await requireSession(request)
      const proj = await getAccessibleProject({ userId: session.userId, projectId: params.projectId })
      if (!proj) {
        throw json({ error: 'project not found' }, { status: 404 })
      }
      const db = getDb()

      const tokens = await db.query.projectToken.findMany({
        where: { projectId: params.projectId },
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
      path: '/api/v0/project-tokens/:id',
      async handler({ request, params }) {
        const session = await requireSession(request)
        const token = await getAccessibleProjectToken(session.userId, params.id)
        if (!token?.project) {
          throw json({ error: 'token not found' }, { status: 404 })
        }
        if (token.accessRole !== 'admin') {
          throw json({ error: 'forbidden' }, { status: 403 })
        }
        const db = getDb()
        await db.delete(schema.projectToken).where(orm.eq(schema.projectToken.id, params.id))
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
            return { raw, contentType } satisfies QueryResponse
          }
          return await res.json()
        }

        if (dbConfig.backend === 'clickhouse') {
          if (!dbConfig.clickhouseUrl) {
            throw json({ error: 'clickhouse not configured' }, { status: 400 })
          }
          const endpoint = `${dbConfig.clickhouseUrl}/?database=${encodeURIComponent(dbConfig.clickhouseDatabase || 'default')}&query=${encodeURIComponent(sqlToSend)}`
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
            return { raw, contentType } satisfies QueryResponse
          }
          return await res.json()
        }

        throw json({ error: 'unknown backend' }, { status: 500 })
      },
    })
    // ── Issue management (status + assignee) ───────────────────────────
    // Issue state lives in ClickHouse/Tinybird via ReplacingMergeTree.
    // Writes go to the Tinybird Events API (wait=true); reads use SQL with FINAL.
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

        // For ClickHouse backend, add explicit ProjectId filter (no JWT row-level filtering)
        const projectFilter = dbConfig.backend === 'clickhouse' ? `ProjectId = '${params.projectId}' AND ` : ''

        let sql: string
        if (fingerprintFilter) {
          sql = `SELECT FingerprintHash, Status, AssigneeMemberId, ResolvedAt, ResolvedByMemberId, UpdatedAt FROM otel_issue_state FINAL WHERE ${projectFilter}FingerprintHash = '${fingerprintFilter}' LIMIT 1 FORMAT JSON`
        } else {
          const where = projectFilter ? `WHERE ${projectFilter.replace(/ AND $/, '')}` : ''
          sql = `SELECT FingerprintHash, Status, AssigneeMemberId, ResolvedAt, ResolvedByMemberId, UpdatedAt FROM otel_issue_state FINAL ${where} ORDER BY UpdatedAt DESC LIMIT 500 FORMAT JSON`
        }

        const result = await queryIssueState({ dbConfig, proj, projectId: params.projectId, sql })
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
        let resolvedByMemberId = current.resolved_by_member_id
        if (body.status === 'resolved') {
          const member = await db.query.orgMember.findFirst({
            where: { orgId: proj.orgId, userId: session.userId },
          })
          resolvedByMemberId = member?.id ?? ''
        } else {
          // Clear resolved info when moving to non-resolved status
          resolvedByMemberId = ''
        }
        const resolvedAt = body.status === 'resolved' ? new Date(now).toISOString() : null

        await writeIssueState({
          dbConfig,
          row: {
            project_id: params.projectId,
            fingerprint_hash: params.fingerprintHash,
            status: body.status,
            assignee_member_id: current.assignee_member_id,
            resolved_at: resolvedAt,
            resolved_by_member_id: resolvedByMemberId,
            last_alerted_at: current.last_alerted_at,
            version: now,
            updated_at: new Date(now).toISOString(),
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
            project_id: current.project_id,
            fingerprint_hash: current.fingerprint_hash,
            status: current.status,
            assignee_member_id: body.assigneeMemberId ?? '',
            resolved_at: current.resolved_at,
            resolved_by_member_id: current.resolved_by_member_id,
            last_alerted_at: current.last_alerted_at,
            version: now,
            updated_at: new Date(now).toISOString(),
          },
        })

        return { ok: true }
      },
    })
    // ── Alert management ──────────────────────────────────────────────
    // Alert rules live in D1 (control plane). One rule per org with
    // multiple destinations. The cron handler in alert-check.ts reads
    // these rules to decide when and where to send notifications.
    .route({
      method: 'GET',
      path: '/api/v0/orgs/:orgId/alerts',
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const rule = await db.query.alertRule.findFirst({
          where: { orgId: params.orgId },
          with: { destinations: true },
        })

        if (!rule) {
          return { rule: null, destinations: [] }
        }

        return {
          rule: {
            id: rule.id,
            threshold: rule.threshold,
            windowMinutes: rule.windowMinutes,
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
        channel: z.enum(['email', 'webhook']),
        destination: z.string().min(1),
        threshold: z.number().int().min(1).optional(),
        windowMinutes: z.number().int().min(1).optional(),
        cooldownMinutes: z.number().int().min(1).optional(),
      }),
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const body = await request.json()

        // Upsert the alert rule for this org
        let rule = await db.query.alertRule.findFirst({
          where: { orgId: params.orgId },
        })

        if (!rule) {
          const [created] = await db.insert(schema.alertRule)
            .values({
              orgId: params.orgId,
              threshold: body.threshold ?? 1,
              windowMinutes: body.windowMinutes ?? 5,
              cooldownMinutes: body.cooldownMinutes ?? 60,
            })
            .returning()
          rule = created!
        } else if (body.threshold || body.windowMinutes || body.cooldownMinutes) {
          await db.update(schema.alertRule)
            .set({
              ...(body.threshold != null ? { threshold: body.threshold } : {}),
              ...(body.windowMinutes != null ? { windowMinutes: body.windowMinutes } : {}),
              ...(body.cooldownMinutes != null ? { cooldownMinutes: body.cooldownMinutes } : {}),
            })
            .where(orm.eq(schema.alertRule.id, rule.id))
        }

        // Upsert destination (unique constraint handles dedup)
        await db.insert(schema.alertDestination)
          .values({
            ruleId: rule.id,
            channel: body.channel,
            destination: body.destination,
          })
          .onConflictDoNothing()

        return { ok: true }
      },
    })
    .route({
      method: 'PUT',
      path: '/api/v0/orgs/:orgId/alerts',
      request: z.object({
        threshold: z.number().int().min(1).optional(),
        windowMinutes: z.number().int().min(1).optional(),
        cooldownMinutes: z.number().int().min(1).optional(),
      }),
      async handler({ request, params }) {
        const session = await requireSession(request)
        await requireOrgMember(session.userId, params.orgId)

        const db = getDb()
        const body = await request.json()

        const rule = await db.query.alertRule.findFirst({
          where: { orgId: params.orgId },
        })
        if (!rule) {
          throw json({ error: 'no alert rule configured, add a destination first' }, { status: 404 })
        }

        await db.update(schema.alertRule)
          .set({
            ...(body.threshold != null ? { threshold: body.threshold } : {}),
            ...(body.windowMinutes != null ? { windowMinutes: body.windowMinutes } : {}),
            ...(body.cooldownMinutes != null ? { cooldownMinutes: body.cooldownMinutes } : {}),
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

        const rule = await db.query.alertRule.findFirst({
          where: { orgId: params.orgId },
        })
        if (!rule) {
          throw json({ error: 'no alert rule found' }, { status: 404 })
        }

        const [deleted] = await db.delete(schema.alertDestination)
          .where(
            orm.and(
              orm.eq(schema.alertDestination.id, params.destinationId),
              orm.eq(schema.alertDestination.ruleId, rule.id),
            ),
          )
          .returning()

        if (!deleted) {
          throw json({ error: 'destination not found' }, { status: 404 })
        }

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
        const rule = await db.query.alertRule.findFirst({
          where: { orgId: params.orgId },
          with: { destinations: true, org: true },
        })

        if (!rule || !rule.destinations || rule.destinations.length === 0) {
          throw json({ error: 'no alert destinations configured' }, { status: 400 })
        }

        const { buildTestAlertEmailHtml } = await import('./alert-email.tsx')
        const orgName = rule.org?.name || 'Unknown'
        const results: Array<{ channel: string; destination: string; ok: boolean }> = []

        for (const dest of rule.destinations) {
          try {
            if (dest.channel === 'email') {
              const html = buildTestAlertEmailHtml(orgName)
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
