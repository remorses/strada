// Website API routes. Org/project management, database config, and query bridge under /api/v0.

import { json, Spiceflow } from 'spiceflow'
import { z } from 'zod'
import dedent from 'string-dedent'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { ulid } from 'ulid'
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
          throw json({ error: 'selfhost migrate only supports Tinybird backends' }, { status: 400 })
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
          return await res.json() as QueryResponse
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
          return await res.json() as QueryResponse
        }

        throw json({ error: 'unknown backend' }, { status: 500 })
      },
    })
