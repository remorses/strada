// Strada website entry point. Thin API-first website for CLI and collector.
// Google social login, device flow for CLI, project management, query bridge.

import './globals.css'
import type { ReactNode } from 'react'
import { getActionRequest, json, parseFormData, Spiceflow, redirect } from 'spiceflow'
import { Head, router } from 'spiceflow/react'
import { z } from 'zod'
import dedent from 'string-dedent'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { ulid } from 'ulid'
import { Button } from './components/ui/button.tsx'
import { DeviceActionButtons } from './components/device-action-buttons.tsx'
import { deployTinybirdResources, getDeploymentManagedReadToken, TinybirdClient } from 'strada/src/tinybird'
import { bundledTinybirdResources } from './tinybird-bundled-resources.ts'
import {
  getAccessibleOrgDatabase,
  getAccessibleProject,
  getAccessibleProjectToken,
  getDb,
  getAuth,
  getOrCreateProjectJwt,
  getSession,
  hashToken,
  generateProjectToken,
  requireOrgMember,
  requireSession,
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

/**
 * ClickHouse FORMAT JSON response shape.
 *
 * When the user's SQL has no FORMAT clause, the website appends FORMAT JSON and
 * returns this structured shape (used by errors commands and the default query path).
 *
 * When the user's SQL already contains a FORMAT clause, the website passes the SQL
 * through and returns raw: the response body as a string plus the Content-Type
 * header that Tinybird/ClickHouse sent back (e.g. "text/csv; charset=UTF-8;
 * header=present"). The CLI prints raw directly to stdout, making it pipeable.
 *
 * NOTE: Tinybird's default format (no FORMAT clause) is TSV, not JSON. That is
 * why we must always inject FORMAT JSON when no format is specified — without it
 * the errors commands and table rendering would receive tab-separated text.
 */
export interface QueryResponse {
  // Structured path (no FORMAT in SQL — website injects FORMAT JSON)
  data?: Record<string, unknown>[]
  rows?: number
  meta?: { name: string; type: string }[]
  statistics?: { elapsed: number; rows_read: number; bytes_read: number }
  // Passthrough path (FORMAT present in SQL — website forwards raw response)
  raw?: string
  contentType?: string
}

/** Strip trailing semicolons from SQL. ClickHouse HTTP interface rejects them. */
function stripSemicolons(sql: string) {
  return sql.trim().replace(/;+\s*$/, '').trimEnd()
}

/**
 * Detect a trailing FORMAT clause in a SQL string.
 * Returns the format name (e.g. "CSV", "JSON", "PrettyCompact") or null.
 * Handles trailing semicolons and whitespace after the format name.
 */
function detectFormat(sql: string): string | null {
  // Strip semicolons before checking — Tinybird accepts "FORMAT JSON;" but we
  // normalise first so the regex stays simple.
  const normalized = stripSemicolons(sql)
  const match = normalized.match(/\bFORMAT\s+(\w+)\s*$/i)
  return match ? match[1]! : null
}

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

      const auth = getAuth()
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
    const orgs = members.flatMap((m) =>
      m.org ? [{ id: m.org.id, name: m.org.name, role: m.role }] : [],
    )
    return { orgs }
  })

  // ── API: Configure database ───────────────────────────────────
  .route({
    method: 'PUT',
    path: '/api/orgs/:orgId/database',
    request: updateDatabaseRequestSchema,
    async handler({ request, params }) {
      const session = await requireSession(request)
      const access = await getAccessibleOrgDatabase({ userId: session.userId, orgId: params.orgId })
      if (!access) {
        throw json({ error: 'forbidden' }, { status: 403 })
      }
      if (access.member.role !== 'admin') {
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

      // Invalidate cached project JWTs when database config changes.
      // JWTs are signed with the admin token, so changing the token,
      // endpoint, or backend makes all existing JWTs invalid.
      await db.batch([
        updateDatabase,
        db.update(schema.project)
          .set({ tinybirdJwt: null, tinybirdJwtDatasources: null, updatedAt })
          .where(orm.eq(schema.project.orgId, params.orgId)),
      ])

      return { ok: true }
    },
  })

  // ── API: Get database config ──────────────────────────────────
  .get('/api/orgs/:orgId/database', async ({ request, params }) => {
    const session = await requireSession(request)
    const access = await getAccessibleOrgDatabase({ userId: session.userId, orgId: params.orgId })
    if (!access || access.member.role !== 'admin') {
      throw json({ error: 'forbidden' }, { status: 403 })
    }
    const row = access.database
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

  // ── API: Migrate Tinybird database schema ─────────────────────
  .route({
    method: 'POST',
    path: '/api/orgs/:orgId/database/migrate',
    async handler({ request, params }) {
      const session = await requireSession(request)
      const access = await getAccessibleOrgDatabase({ userId: session.userId, orgId: params.orgId })
      if (!access) {
        throw json({ error: 'forbidden' }, { status: 403 })
      }
      if (access.member.role !== 'admin') {
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
          .set({
            tinybirdReadToken: readToken.token,
            updatedAt,
          })
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

  // ── API: Create project ───────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/orgs/:orgId/projects',
    request: createProjectRequestSchema,
    async handler({ request, params }) {
      const session = await requireSession(request)
      const access = await getAccessibleOrgDatabase({ userId: session.userId, orgId: params.orgId })
      if (!access) {
        throw json({ error: 'forbidden' }, { status: 403 })
      }
      if (access.member.role !== 'admin') {
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

  // ── API: Create project token ─────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/projects/:projectId/tokens',
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

      // Full key shown only once
      return { key: fullKey, prefix: `str_${prefix}...`, name: body.name, scope: body.scope }
    },
  })

  // ── API: List project tokens ──────────────────────────────────
  .get('/api/projects/:projectId/tokens', async ({ request, params }) => {
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

  // ── API: Query bridge ─────────────────────────────────────────
  // Proxies SQL queries to Tinybird or ClickHouse with project-scoped auth.
  .route({
    method: 'POST',
    path: '/api/projects/:projectId/query',
    request: queryProjectRequestSchema,
    detail: {
      summary: 'Run a SQL query against a project',
      tags: ['query'],
      description: dedent`
        Proxies a ClickHouse SQL \`SELECT\` statement to the project's configured
        backend (Tinybird or self-hosted ClickHouse) with project-scoped auth.

        ## Output format

        The output format is controlled by a \`FORMAT\` clause at the end of the SQL.
        There is no separate format parameter.

        **No \`FORMAT\` clause (default)**

        The server injects \`FORMAT JSON\` automatically and returns a structured JSON
        envelope. Note: Tinybird's own default format is TSV — the injection is required
        to get JSON back.

        \`\`\`json
        {
          "data": [{ "col": "value" }],
          "meta": [{ "name": "col", "type": "String" }],
          "rows": 1,
          "statistics": { "elapsed": 0.001, "rows_read": 1, "bytes_read": 8 }
        }
        \`\`\`

        **\`FORMAT\` clause present**

        The SQL is sent to the backend unchanged and the raw response body is returned
        as \`{ raw: string, contentType: string }\`. The \`contentType\` field mirrors the
        \`Content-Type\` header that Tinybird/ClickHouse sent back (e.g.
        \`"text/csv; charset=UTF-8; header=present"\`).

        ## Supported FORMAT values

        | FORMAT | Content-Type | Description |
        |--------|--------------|-------------|
        | \`JSON\` | \`application/json\` | Full JSON envelope with data, meta, rows, statistics |
        | \`JSONEachRow\` | \`application/x-ndjson\` | One JSON object per line (NDJSON) |
        | \`CSV\` | \`text/csv; header=absent\` | Comma-separated values, no header row |
        | \`CSVWithNames\` | \`text/csv; header=present\` | Comma-separated values with a header row |
        | \`TSV\` | \`text/tab-separated-values\` | Tab-separated values, no header row |
        | \`TSVWithNames\` | \`text/tab-separated-values\` | Tab-separated values with a header row |
        | \`PrettyCompact\` | \`text/plain\` | Unicode box-drawing table for human reading |
        | \`Parquet\` | \`application/octet-stream\` | Binary columnar format |
        | \`Prometheus\` | \`text/plain\` | Prometheus text-based exposition format |

        ## Semicolons

        Trailing semicolons are stripped before the query is forwarded. Both
        \`SELECT 1 FORMAT JSON;\` and \`SELECT 1;\` are accepted.

        ## Examples

        \`\`\`bash
        # Default — structured JSON envelope
        curl -X POST .../query -d '{"sql":"SELECT count() FROM otel_errors"}'

        # CSV export
        curl -X POST .../query -d '{"sql":"SELECT * FROM otel_errors FORMAT CSVWithNames"}'

        # NDJSON for streaming consumers
        curl -X POST .../query -d '{"sql":"SELECT * FROM otel_logs LIMIT 100 FORMAT JSONEachRow"}'
        \`\`\`
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

      // Normalise SQL: strip trailing semicolons, detect explicit FORMAT clause.
      // If no FORMAT is present we inject FORMAT JSON so both backends return the
      // structured { data, meta, rows, statistics } envelope (Tinybird's default
      // format is TSV — without this injection errors commands would get raw text).
      // If a FORMAT clause is already in the SQL we pass it through unchanged and
      // forward the raw response body + Content-Type header back to the caller.
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
          tinybirdEndpoint: dbConfig.tinybirdEndpoint!,
          tinybirdAdminToken: dbConfig.tinybirdAdminToken!,
          tinybirdJwt: proj.tinybirdJwt,
          tinybirdJwtDatasources: proj.tinybirdJwtDatasources,
        }

        let jwt = await getOrCreateProjectJwt(jwtCtx)
        let res = await queryWithJwt(jwt)

        // If 403, the JWT may be stale (admin token rotated, workspace changed).
        // Force-regenerate once and retry before giving up.
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

export type App = typeof app

const handleFetch: ExportedHandlerFetchHandler<Env> = (request) => app.handle(request)

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}

export default {
  fetch: handleFetch,
} satisfies ExportedHandler<Env>
