// Worker-level database client, auth, and session helpers.
//
// getDb() creates a drizzle-orm/d1 client bound to env.DB.
// getAuth() creates a BetterAuth instance with Google social login + device flow.

import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { betterAuth } from 'better-auth'
import { deviceAuthorization, bearer } from 'better-auth/plugins'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { json } from 'spiceflow'
import { TinybirdClient, TINYBIRD_DATASOURCES } from 'strada/src/tinybird'

// ── Drizzle client via D1 ───────────────────────────────────────────

export function getDb() {
  return drizzle(env.DB, { schema, relations: schema.relations })
}

// ── BetterAuth ──────────────────────────────────────────────────────

export function getAuth() {
  const db = getDb()
  return betterAuth({
    baseURL: getBaseUrl(),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: 'select_account',
      },
    },
    plugins: [
      deviceAuthorization({ verificationUri: '/device' }),
      bearer(),
    ],
  })
}

function getBaseUrl(): string {
  // In production the URL comes from the custom domain route.
  // In dev, BETTER_AUTH_URL can be set as a var in wrangler.jsonc [vars] or via .dev.vars.
  const workerEnv: Cloudflare.Env = env
  const override = workerEnv.BETTER_AUTH_URL
  if (typeof override === 'string' && override) return override
  return 'https://strada.sh'
}

// ── Session helpers ─────────────────────────────────────────────────

type Session = { userId: string; user: { id: string; name: string; email: string } }

export async function getSession(request: Request): Promise<Session | null> {
  const hasCookie = request.headers.has('cookie')
  const hasAuthorization = request.headers.has('authorization')
  if (!hasCookie && !hasAuthorization) {
    return null
  }
  const auth = getAuth()
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return null
  return {
    userId: session.user.id,
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
  }
}

export async function requireSession(request: Request): Promise<Session> {
  const session = await getSession(request)
  if (!session) {
    throw json({ error: 'unauthorized' }, { status: 401 })
  }
  return session
}

export async function requireOrgMember(userId: string, orgId: string) {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { orgId, userId },
  })
  if (!member) {
    throw json({ error: 'forbidden' }, { status: 403 })
  }
  return member
}

// ── Token hashing ───────────────────────────────────────────────────

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateProjectToken(): { fullKey: string; prefix: string } {
  const raw = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  const fullKey = `str_${raw}`
  const prefix = raw.slice(0, 12)
  return { fullKey, prefix }
}

// ── Per-project Tinybird JWT ────────────────────────────────────────
// Each project gets a JWT with DATASOURCES:READ scopes filtered to its
// ProjectId. Tinybird enforces the filter server-side, so SQL queries
// never need WHERE ProjectId = '...'. The JWT is cached in the project
// table and regenerated when it expires (24h TTL, 5min early renewal buffer).

// 100 years in seconds. Tinybird requires exp but has no way to skip it.
const JWT_TTL_SEC = 100 * 365 * 24 * 60 * 60

interface ProjectJwtContext {
  projectId: string
  tinybirdEndpoint: string
  tinybirdAdminToken: string
  /** Existing cached JWT, if any */
  tinybirdJwt: string | null
  /** Comma-joined datasource names the cached JWT was created with */
  tinybirdJwtDatasources: string | null
}

/**
 * Get a valid Tinybird JWT for a project, generating one if missing or stale.
 * Regenerates when the datasource list changes (new table added to TINYBIRD_DATASOURCES).
 */
export async function getOrCreateProjectJwt(ctx: ProjectJwtContext): Promise<string> {
  const currentDatasources = TINYBIRD_DATASOURCES.join(',')

  // Return cached JWT if it covers the same datasources
  if (ctx.tinybirdJwt && ctx.tinybirdJwtDatasources === currentDatasources) {
    return ctx.tinybirdJwt
  }

  const client = new TinybirdClient({
    baseUrl: ctx.tinybirdEndpoint,
    token: ctx.tinybirdAdminToken,
  })

  const expirationTimeSec = Math.floor(Date.now() / 1000) + JWT_TTL_SEC

  const result = await client.createJwt({
    name: `project_${ctx.projectId}`,
    expirationTime: expirationTimeSec,
    scopes: TINYBIRD_DATASOURCES.map((resource) => ({
      type: "DATASOURCES:READ" as const,
      resource,
      filter: `ProjectId = '${ctx.projectId}'`,
    })),
  })
  if (result instanceof Error) throw result

  // Cache the JWT and datasource list in D1
  const db = getDb()
  await db.update(schema.project)
    .set({ tinybirdJwt: result.token, tinybirdJwtDatasources: currentDatasources, updatedAt: Date.now() })
    .where(orm.eq(schema.project.id, ctx.projectId))

  return result.token
}
