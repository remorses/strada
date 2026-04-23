// Strada website entry point. Thin API-first website for CLI and collector.
// Google social login, device flow for CLI, project management, query bridge.

import './globals.css'
import type { ReactNode } from 'react'
import { getActionRequest, json, parseFormData, Spiceflow, redirect } from 'spiceflow'
import { Head, router } from 'spiceflow/react'
import { z } from 'zod'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { ulid } from 'ulid'
import { Button } from './components/ui/button.tsx'
import { DeviceActionButtons } from './components/device-action-buttons.tsx'
import {
  getDb, getAuth, getSession, requireSession, requireOrgMember,
  hashToken, generateProjectToken, getOrCreateProjectJwt,
} from './db.ts'

const loginQuerySchema = z.object({ callbackURL: z.string().optional() })

const devicePageQuerySchema = z.object({
  user_code: z.string().optional(),
  status: z.enum(['approved', 'denied']).optional(),
})

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
const deviceUserCodeSchema = z.object({ userCode: z.string().min(1) })

function safeRedirectPath(value: string | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

async function createGoogleSignInRedirect(request: Request, callbackURL: string) {
  const auth = getAuth()
  const { response, headers } = await auth.api.signInSocial({
    body: { provider: 'google', callbackURL },
    headers: request.headers,
    returnHeaders: true,
  })
  if (!response?.url) {
    throw json({ error: 'failed to start google sign-in' }, { status: 500 })
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

function AuthPage({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Head>
        <Head.Title>{`${title} | Strada`}</Head.Title>
        <Head.Meta name="description" content={description} />
      </Head>
      <section className="flex w-full max-w-md flex-col gap-6 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
        {children}
      </section>
    </main>
  )
}

export const app = new Spiceflow()

  // ── BetterAuth middleware ──────────────────────────────────────
  .use(async ({ request }, next) => {
    if (request.parsedUrl.pathname.startsWith('/api/auth')) {
      const auth = getAuth()
      const res = await auth.handler(request)
      if (res.ok || res.status !== 404) return res
    }
    return next()
  })

  .layout('/*', async ({ children }) => {
    return (
      <html lang="en" className="h-full">
        <Head>
          <Head.Meta charSet="UTF-8" />
          <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <Head.Title>Strada</Head.Title>
          <Head.Meta
            name="description"
            content="OpenTelemetry-native observability with traces, logs, metrics, and error tracking."
          />
        </Head>
        <body>
          {children ?? (
            <AuthPage
              description="The page you requested does not exist."
              title="Page not found"
            >
              <div className="flex flex-col gap-2 text-center">
                <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
                <p className="text-sm text-muted-foreground">
                  Check the URL or go back to the app.
                </p>
              </div>
            </AuthPage>
          )}
        </body>
      </html>
    )
  })

  // ── Root ──────────────────────────────────────────────────────
  .get('/', () => {
    return { name: 'strada', version: '0.0.1' }
  })

  // ── Login page (minimal, for device flow approval) ────────────
  .page({
    path: '/login',
    query: loginQuerySchema,
    handler: async ({ request, query }) => {
      const session = await getSession(request)
      if (session) throw redirect('/')
      const callbackURL = safeRedirectPath(query.callbackURL)
      return (
        <AuthPage
          description="Sign in to manage observability projects and approve CLI logins."
          title="Sign in"
        >
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-3xl font-semibold tracking-tight">Strada</h1>
            <p className="text-sm text-muted-foreground">
              Sign in to manage your observability projects.
            </p>
          </div>
          <Button asChild className="w-full" size="lg">
            <a href={router.href('/login/google', { callbackURL })}>Sign in with Google</a>
          </Button>
        </AuthPage>
      )
    },
  })

  .route({
    method: 'GET',
    path: '/login/google',
    query: loginQuerySchema,
    async handler({ request, query }) {
      return createGoogleSignInRedirect(request, safeRedirectPath(query.callbackURL))
    },
  })

  // ── Device flow verification page ─────────────────────────────
  .page({
    path: '/device',
    query: devicePageQuerySchema,
    handler: async ({ request, query }) => {
      const userCode = query.user_code ?? ''
      const status = query.status
      const auth = getAuth()

      if (!userCode) {
        return (
          <AuthPage
            description="Open this page from the CLI login flow with a valid device code."
            title="CLI login"
          >
            <div className="flex flex-col gap-2 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">Strada CLI Login</h1>
              <p className="text-sm text-muted-foreground">
                Open this page from the CLI login flow with a valid device code.
              </p>
            </div>
          </AuthPage>
        )
      }

      const device = await auth.api.deviceVerify({ query: { user_code: userCode } }).catch(() => null)
      if (!device) {
        return (
          <AuthPage
            description="That CLI device code is invalid or expired."
            title="Invalid device code"
          >
            <div className="flex flex-col gap-2 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">Invalid device code</h1>
              <p className="text-sm text-muted-foreground">
                That device code is invalid or expired.
              </p>
            </div>
          </AuthPage>
        )
      }

      const session = await getSession(request)
      if (!session) {
        throw redirect(
          router.href('/login', {
            callbackURL: `${request.parsedUrl.pathname}${request.parsedUrl.search}`,
          }),
        )
      }

      async function approveDevice(formData: FormData) {
        'use server'
        const actionRequest = getActionRequest()
        await requireSession(actionRequest)
        const { userCode: parsedUserCode } = parseFormData(deviceUserCodeSchema, formData)
        const actionAuth = getAuth()
        await actionAuth.api.deviceApprove({ body: { userCode: parsedUserCode }, headers: actionRequest.headers })
        throw redirect(router.href('/device', { user_code: parsedUserCode, status: 'approved' }))
      }

      async function denyDevice(formData: FormData) {
        'use server'
        const actionRequest = getActionRequest()
        await requireSession(actionRequest)
        const { userCode: parsedUserCode } = parseFormData(deviceUserCodeSchema, formData)
        const actionAuth = getAuth()
        await actionAuth.api.deviceDeny({ body: { userCode: parsedUserCode }, headers: actionRequest.headers })
        throw redirect(router.href('/device', { user_code: parsedUserCode, status: 'denied' }))
      }

      return (
        <AuthPage
          description="Approve or deny the current Strada CLI login request."
          title="CLI login"
        >
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Strada CLI Login</h1>
            {status === 'approved'
              ? (
                  <>
                    <p className="text-sm text-foreground">The CLI was approved successfully.</p>
                    <p className="text-sm text-muted-foreground">
                      You can close this page and return to the terminal.
                    </p>
                  </>
                )
              : status === 'denied'
                ? (
                    <>
                      <p className="text-sm text-foreground">The CLI login was denied.</p>
                      <p className="text-sm text-muted-foreground">
                        You can close this page and start the login flow again.
                      </p>
                    </>
                  )
                : (
                    <>
                      <p className="text-sm text-foreground">
                        A CLI is requesting access to your account.
                      </p>
                      <p className="rounded-lg border bg-muted px-3 py-2 font-mono text-lg tracking-[0.24em] uppercase">
                        {userCode}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Current status: {device.status}. Approve to let the CLI finish logging in.
                      </p>
                    </>
                  )}
          </div>
          {status == null && <DeviceActionButtons approveAction={approveDevice} denyAction={denyDevice} userCode={userCode} />}
        </AuthPage>
      )
    },
  })

  // ── API: Create org ───────────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/orgs',
    request: createOrgRequestSchema,
    async handler({ request }) {
      const session = await requireSession(request)
      const body = await request.json()
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
      const body = await request.json()

      const existing = await db.query.database.findFirst({
        where: { orgId: params.orgId },
      })
      if (!existing) {
        throw json({ error: 'no database config for this org' }, { status: 404 })
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
      throw json({ error: 'no database config' }, { status: 404 })
    }
    // Redact admin token, only show read token
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

  // ── API: Create project ───────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/orgs/:orgId/projects',
    request: createProjectRequestSchema,
    async handler({ request, params }) {
      const session = await requireSession(request)
      await requireOrgMember(session.userId, params.orgId)
      const db = getDb()
      const body = await request.json()

      const dbRow = await db.query.database.findFirst({
        where: { orgId: params.orgId },
      })
      if (!dbRow) {
        throw json({ error: 'configure database first' }, { status: 400 })
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
        throw json({ error: 'project not found' }, { status: 404 })
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
        throw json({ error: 'project not found' }, { status: 404 })
      }
      await requireOrgMember(session.userId, proj.orgId)

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
      throw json({ error: 'project not found' }, { status: 404 })
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
        throw json({ error: 'token not found' }, { status: 404 })
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
        throw json({ error: 'project not found' }, { status: 404 })
      }
      await requireOrgMember(session.userId, proj.orgId)

      const dbConfig = proj.database
      if (!dbConfig) {
        throw json({ error: 'no database configured' }, { status: 400 })
      }

      const body = await request.json()

      // Scrub secrets from response text so tokens/passwords never leak to clients
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

      if (dbConfig.backend === 'tinybird') {
        if (!dbConfig.tinybirdEndpoint || !dbConfig.tinybirdAdminToken) {
          throw json({ error: 'tinybird not configured' }, { status: 400 })
        }
        // Get or create a per-project JWT with DATASOURCES:READ scopes filtered
        // to this project's ProjectId. Tinybird enforces the filter server-side,
        // so SQL queries never need WHERE ProjectId = '...'.
        const jwt = await getOrCreateProjectJwt({
          projectId: params.projectId,
          tinybirdEndpoint: dbConfig.tinybirdEndpoint,
          tinybirdAdminToken: dbConfig.tinybirdAdminToken,
          tinybirdJwt: proj.tinybirdJwt,
          tinybirdJwtDatasources: proj.tinybirdJwtDatasources,
        })
        const sql = body.sql.includes('FORMAT ') ? body.sql : `${body.sql} FORMAT JSON`
        const url = `${dbConfig.tinybirdEndpoint}/v0/sql`
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ q: sql }),
        })
        if (!res.ok) {
          // Forward Tinybird error as-is so clients get readable messages
          // (e.g. "mutation not allowed" when using a read-only token)
          const text = redact(await res.text())
          let parsed: unknown
          try { parsed = JSON.parse(text) } catch { parsed = null }
          throw json(parsed ?? { error: text }, { status: res.status })
        }
        return res.json()
      }

      if (dbConfig.backend === 'clickhouse') {
        if (!dbConfig.clickhouseUrl) {
          throw json({ error: 'clickhouse not configured' }, { status: 400 })
        }
        const endpoint = `${dbConfig.clickhouseUrl}/?database=${encodeURIComponent(dbConfig.clickhouseDatabase || 'default')}&query=${encodeURIComponent(body.sql + ' FORMAT JSON')}`
        const res = await fetch(endpoint, {
          headers: {
            'X-ClickHouse-User': dbConfig.clickhouseUser || 'default',
            'X-ClickHouse-Key': dbConfig.clickhousePassword || '',
          },
        })
        if (!res.ok) {
          // Forward ClickHouse error as-is for readable messages
          const text = redact(await res.text())
          let parsed: unknown
          try { parsed = JSON.parse(text) } catch { parsed = null }
          throw json(parsed ?? { error: text }, { status: res.status })
        }
        return res.json()
      }

      throw json({ error: 'unknown backend' }, { status: 500 })
    },
  })

export type App = typeof app

const handleFetch: ExportedHandlerFetchHandler<Env> = (request) => app.handle(request)

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}

export default {
  fetch: handleFetch,
} satisfies ExportedHandler<Env>
