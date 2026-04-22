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
import { redirect } from 'spiceflow'

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
  const workerEnv: Env & { BETTER_AUTH_URL?: string } = env
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
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  return session
}

export async function requireOrgMember(userId: string, orgId: string) {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { orgId, userId },
  })
  if (!member) {
    throw new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
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
