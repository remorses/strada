// Strada website entry point. Thin API-first website for CLI and collector.
// Google social login, device flow for CLI, project management, query bridge.

import { Spiceflow, redirect } from 'spiceflow'
import type { SpiceflowRegister } from 'spiceflow/react'
import { z } from 'zod'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { ulid } from 'ulid'
import {
  getDb, getAuth, getSession, requireSession, requireOrgMember,
  hashToken, generateProjectToken,
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

async function parseJsonBody<TSchema extends z.ZodTypeAny>(
  request: Request,
  bodySchema: TSchema,
): Promise<z.infer<TSchema>> {
  return bodySchema.parse(await request.json())
}

function buildGoogleSignInHref(callbackURL: string) {
  const url = new URL('/login/google', 'https://strada.sh')
  url.searchParams.set('callbackURL', callbackURL)
  return `${url.pathname}${url.search}`
}

async function createGoogleSignInRedirect(request: Request, callbackURL: string) {
  const auth = getAuth()
  const { response, headers } = await auth.api.signInSocial({
    body: { provider: 'google', callbackURL },
    headers: request.headers,
    returnHeaders: true,
  })
  if (!response?.url) {
    throw new Response(JSON.stringify({ error: 'failed to start google sign-in' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const redirectResponse = new Response(null, {
    status: 302,
    headers: { Location: response.url },
  })
  for (const cookie of headers.getSetCookie()) {
    redirectResponse.headers.append('Set-Cookie', cookie)
  }
  return redirectResponse
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

export const app = new Spiceflow()

  // ── BetterAuth middleware ──────────────────────────────────────
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const auth = getAuth()
      const res = await auth.handler(request)
      if (res.ok || res.status !== 404) return res
    }
    return next()
  })

  // ── Root ──────────────────────────────────────────────────────
  .get('/', () => {
    return { name: 'strada', version: '0.0.1' }
  })

  // ── Login page (minimal, for device flow approval) ────────────
  .page('/login', async ({ request }) => {
    const session = await getSession(request)
    if (session) return redirect('/')
    const url = new URL(request.url)
    const callbackURL = url.searchParams.get('callbackURL') || '/'
    return (
      <html lang="en">
        <body style={{ fontFamily: 'system-ui', maxWidth: 400, margin: '100px auto', textAlign: 'center' }}>
          <h1>Strada</h1>
          <p>Sign in to manage your observability projects</p>
          <a href={buildGoogleSignInHref(callbackURL)} style={{
            display: 'inline-block', padding: '12px 24px',
            background: '#000', color: '#fff', borderRadius: 8,
            textDecoration: 'none', fontWeight: 600,
          }}>
            Sign in with Google
          </a>
        </body>
      </html>
    )
  })

  .get('/login/google', async ({ request }) => {
    const url = new URL(request.url)
    const callbackURL = url.searchParams.get('callbackURL') || '/'
    return createGoogleSignInRedirect(request, callbackURL)
  })

  // ── Device flow verification page ─────────────────────────────
  .page('/device', async ({ request }) => {
    const url = new URL(request.url)
    const userCode = url.searchParams.get('user_code') ?? ''
    const status = url.searchParams.get('status') ?? ''
    const auth = getAuth()

    if (!userCode) {
      return (
        <html lang="en">
          <body style={{ fontFamily: 'system-ui', maxWidth: 400, margin: '100px auto', textAlign: 'center' }}>
            <h1>Strada CLI Login</h1>
            <p>Open this page from the CLI login flow with a valid device code.</p>
          </body>
        </html>
      )
    }

    const device = await auth.api.deviceVerify({ query: { user_code: userCode } }).catch(() => null)
    if (!device) {
      return (
        <html lang="en">
          <body style={{ fontFamily: 'system-ui', maxWidth: 400, margin: '100px auto', textAlign: 'center' }}>
            <h1>Strada CLI Login</h1>
            <p>That device code is invalid or expired.</p>
          </body>
        </html>
      )
    }

    const session = await getSession(request)
    if (!session) return redirect(`/login?callbackURL=${encodeURIComponent(url.pathname + url.search)}`)

    return (
      <html lang="en">
        <body style={{ fontFamily: 'system-ui', maxWidth: 400, margin: '100px auto', textAlign: 'center' }}>
          <h1>Strada CLI Login</h1>
          {status === 'approved'
            ? (
                <>
                  <p>The CLI was approved successfully.</p>
                  <p style={{ color: '#666', fontSize: 14 }}>You can close this page and return to the terminal.</p>
                </>
              )
            : status === 'denied'
              ? (
                  <>
                    <p>The CLI login was denied.</p>
                    <p style={{ color: '#666', fontSize: 14 }}>You can close this page and start the login flow again.</p>
                  </>
                )
              : (
                  <>
                    <p>A CLI is requesting access to your account.</p>
                    <p>Code: <strong>{userCode}</strong></p>
                    <p style={{ color: '#666', fontSize: 14 }}>
                      Current status: {device.status}. Approve to let the CLI finish logging in.
                    </p>
                    <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24 }}>
                      <form method="post" action="/device/approve">
                        <input type="hidden" name="userCode" value={userCode} />
                        <button type="submit" style={{ padding: '12px 24px', background: '#000', color: '#fff', borderRadius: 8, border: 'none', fontWeight: 600, cursor: 'pointer' }}>
                          Approve CLI
                        </button>
                      </form>
                      <form method="post" action="/device/deny">
                        <input type="hidden" name="userCode" value={userCode} />
                        <button type="submit" style={{ padding: '12px 24px', background: '#fff', color: '#000', borderRadius: 8, border: '1px solid #ccc', fontWeight: 600, cursor: 'pointer' }}>
                          Deny
                        </button>
                      </form>
                    </div>
                  </>
                )}
        </body>
      </html>
    )
  })

  .route({
    method: 'POST',
    path: '/device/approve',
    async handler({ request }) {
      await requireSession(request)
      const formData = await request.formData()
      const userCode = String(formData.get('userCode') || '')
      const auth = getAuth()
      await auth.api.deviceApprove({ body: { userCode }, headers: request.headers })
      return redirect(`/device?user_code=${encodeURIComponent(userCode)}&status=approved`)
    },
  })

  .route({
    method: 'POST',
    path: '/device/deny',
    async handler({ request }) {
      await requireSession(request)
      const formData = await request.formData()
      const userCode = String(formData.get('userCode') || '')
      const auth = getAuth()
      await auth.api.deviceDeny({ body: { userCode }, headers: request.headers })
      return redirect(`/device?user_code=${encodeURIComponent(userCode)}&status=denied`)
    },
  })

  // ── API: Create org ───────────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/orgs',
    request: createOrgRequestSchema,
    async handler({ request }) {
      const session = await requireSession(request)
      const body = await parseJsonBody(request, createOrgRequestSchema)
      const org = await createOrgForUser(session.userId, body.name)
      return { id: org.id, name: org.name, databaseId: org.databaseId }
    },
  })

  // ── API: Ensure default org for current user ───────────────────
  .route({
    method: 'POST',
    path: '/api/orgs/ensure-default',
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

  // ── API: List orgs for current user ───────────────────────────
  .get('/api/orgs', async ({ request }) => {
    const session = await requireSession(request)
    const db = getDb()
    const members = await db.query.orgMember.findMany({
      where: { userId: session.userId },
      with: { org: true },
    })
    return {
      orgs: members.filter((m) => m.org != null).map((m) => ({
        id: m.org!.id, name: m.org!.name, role: m.role,
      })),
    }
  })

  // ── API: Configure database ───────────────────────────────────
  .route({
    method: 'PUT',
    path: '/api/orgs/:orgId/database',
    request: updateDatabaseRequestSchema,
    async handler({ request, params }) {
      const session = await requireSession(request)
      await requireOrgMember(session.userId, params.orgId)
      const db = getDb()
      const body = await parseJsonBody(request, updateDatabaseRequestSchema)

      const existing = await db.query.database.findFirst({
        where: { orgId: params.orgId },
      })
      if (!existing) {
        throw new Response(JSON.stringify({ error: 'no database config for this org' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }

      if (body.backend === 'tinybird') {
        await db.update(schema.database)
          .set({
            backend: 'tinybird',
            tinybirdEndpoint: body.tinybirdEndpoint,
            tinybirdAdminToken: body.tinybirdAdminToken,
            tinybirdReadToken: body.tinybirdReadToken,
            clickhouseUrl: null,
            clickhouseDatabase: null,
            clickhouseUser: null,
            clickhousePassword: null,
            updatedAt: Date.now(),
          })
          .where(orm.eq(schema.database.id, existing.id))
      } else {
        await db.update(schema.database)
          .set({
            backend: 'clickhouse',
            clickhouseUrl: body.clickhouseUrl,
            clickhouseDatabase: body.clickhouseDatabase || 'default',
            clickhouseUser: body.clickhouseUser || 'default',
            clickhousePassword: body.clickhousePassword || '',
            tinybirdEndpoint: null,
            tinybirdAdminToken: null,
            tinybirdReadToken: null,
            updatedAt: Date.now(),
          })
          .where(orm.eq(schema.database.id, existing.id))
      }

      return { ok: true }
    },
  })

  // ── API: Get database config ──────────────────────────────────
  .get('/api/orgs/:orgId/database', async ({ request, params }) => {
    const session = await requireSession(request)
    await requireOrgMember(session.userId, params.orgId)
    const db = getDb()
    const row = await db.query.database.findFirst({
      where: { orgId: params.orgId },
    })
    if (!row) {
      throw new Response(JSON.stringify({ error: 'no database config' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })
    }
    // Redact admin token, only show read token
    return {
      id: row.id,
      backend: row.backend,
      tinybirdEndpoint: row.tinybirdEndpoint,
      tinybirdReadToken: row.tinybirdReadToken,
      hasAdminToken: !!row.tinybirdAdminToken,
      clickhouseUrl: row.clickhouseUrl,
      clickhouseDatabase: row.clickhouseDatabase,
      clickhouseUser: row.clickhouseUser,
      hasClickhousePassword: !!row.clickhousePassword,
    }
  })

  // ── API: Create project ───────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/orgs/:orgId/projects',
    request: createProjectRequestSchema,
    async handler({ request, params }) {
      const session = await requireSession(request)
      await requireOrgMember(session.userId, params.orgId)
      const db = getDb()
      const body = await parseJsonBody(request, createProjectRequestSchema)

      const dbRow = await db.query.database.findFirst({
        where: { orgId: params.orgId },
      })
      if (!dbRow) {
        throw new Response(JSON.stringify({ error: 'configure database first' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        })
      }

      const [proj] = await db.insert(schema.project)
        .values({ slug: body.slug, orgId: params.orgId, databaseId: dbRow.id })
        .returning()

      return {
        id: proj!.id,
        slug: proj!.slug,
        ingestEndpoint: `https://${proj!.id}-ingest.strada.sh`,
      }
    },
  })

  // ── API: List projects ────────────────────────────────────────
  .get('/api/orgs/:orgId/projects', async ({ request, params }) => {
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

  // ── API: Delete project ───────────────────────────────────────
  .route({
    method: 'DELETE',
    path: '/api/projects/:id',
    async handler({ request, params }) {
      const session = await requireSession(request)
      const db = getDb()
      const proj = await db.query.project.findFirst({
        where: { id: params.id },
      })
      if (!proj) {
        throw new Response(JSON.stringify({ error: 'project not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      await requireOrgMember(session.userId, proj.orgId)
      await db.delete(schema.project).where(orm.eq(schema.project.id, params.id))
      return { ok: true }
    },
  })

  // ── API: Create project token ─────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/projects/:projectId/tokens',
    request: createProjectTokenRequestSchema,
    async handler({ request, params }) {
      const session = await requireSession(request)
      const db = getDb()
      const proj = await db.query.project.findFirst({
        where: { id: params.projectId },
      })
      if (!proj) {
        throw new Response(JSON.stringify({ error: 'project not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      await requireOrgMember(session.userId, proj.orgId)

      const body = await parseJsonBody(request, createProjectTokenRequestSchema)
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

      // Full key shown only once
      return { key: fullKey, prefix: `str_${prefix}...`, name: body.name, scope: body.scope }
    },
  })

  // ── API: List project tokens ──────────────────────────────────
  .get('/api/projects/:projectId/tokens', async ({ request, params }) => {
    const session = await requireSession(request)
    const db = getDb()
    const proj = await db.query.project.findFirst({
      where: { id: params.projectId },
    })
    if (!proj) {
      throw new Response(JSON.stringify({ error: 'project not found' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })
    }
    await requireOrgMember(session.userId, proj.orgId)

    const tokens = await db.query.projectToken.findMany({
      where: { projectId: params.projectId },
      with: { creator: { columns: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return {
      tokens: tokens.map((t) => ({
        id: t.id, name: t.name, prefix: `str_${t.prefix}...`,
        scope: t.scope, createdBy: t.creator?.name ?? 'unknown',
        createdAt: t.createdAt,
      })),
    }
  })

  // ── API: Delete project token ─────────────────────────────────
  .route({
    method: 'DELETE',
    path: '/api/project-tokens/:id',
    async handler({ request, params }) {
      const session = await requireSession(request)
      const db = getDb()
      const token = await db.query.projectToken.findFirst({
        where: { id: params.id },
        with: { project: true },
      })
      if (!token) {
        throw new Response(JSON.stringify({ error: 'token not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      await requireOrgMember(session.userId, token.project!.orgId)
      await db.delete(schema.projectToken).where(orm.eq(schema.projectToken.id, params.id))
      return { ok: true }
    },
  })

  // ── API: Query bridge ─────────────────────────────────────────
  // Proxies SQL queries to Tinybird or ClickHouse with project-scoped auth.
  .route({
    method: 'POST',
    path: '/api/projects/:projectId/query',
    request: queryProjectRequestSchema,
    async handler({ request, params }) {
      const session = await requireSession(request)
      const db = getDb()
      const proj = await db.query.project.findFirst({
        where: { id: params.projectId },
        with: { database: true },
      })
      if (!proj) {
        throw new Response(JSON.stringify({ error: 'project not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      }
      await requireOrgMember(session.userId, proj.orgId)

      const dbConfig = proj.database
      if (!dbConfig) {
        throw new Response(JSON.stringify({ error: 'no database configured' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        })
      }

      const body = await parseJsonBody(request, queryProjectRequestSchema)

      if (dbConfig.backend === 'tinybird') {
        if (!dbConfig.tinybirdEndpoint || !dbConfig.tinybirdReadToken) {
          throw new Response(JSON.stringify({ error: 'tinybird not configured' }), {
            status: 400, headers: { 'content-type': 'application/json' },
          })
        }
        const url = `${dbConfig.tinybirdEndpoint}/v0/sql`
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            Authorization: `Bearer ${dbConfig.tinybirdReadToken}`,
          },
          body: body.sql,
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Response(JSON.stringify({ error: text }), {
            status: res.status, headers: { 'content-type': 'application/json' },
          })
        }
        return res.json()
      }

      if (dbConfig.backend === 'clickhouse') {
        if (!dbConfig.clickhouseUrl) {
          throw new Response(JSON.stringify({ error: 'clickhouse not configured' }), {
            status: 400, headers: { 'content-type': 'application/json' },
          })
        }
        const endpoint = `${dbConfig.clickhouseUrl}/?database=${encodeURIComponent(dbConfig.clickhouseDatabase || 'default')}&query=${encodeURIComponent(body.sql + ' FORMAT JSON')}`
        const res = await fetch(endpoint, {
          headers: {
            'X-ClickHouse-User': dbConfig.clickhouseUser || 'default',
            'X-ClickHouse-Key': dbConfig.clickhousePassword || '',
          },
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Response(JSON.stringify({ error: text }), {
            status: res.status, headers: { 'content-type': 'application/json' },
          })
        }
        return res.json()
      }

      throw new Response(JSON.stringify({ error: 'unknown backend' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      })
    },
  })

export type App = typeof app

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>
