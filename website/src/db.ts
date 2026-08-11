// Worker-level database client, auth, and session helpers.
//
// getDb() creates a drizzle-orm/sqlite-proxy client bound to env.DB.
// Uses sqlite-proxy instead of drizzle-orm/d1 to avoid the batch findFirst
// crash (drizzle-team/drizzle-orm#2721).
// getAuth() creates a BetterAuth instance with Google social login + device flow.

import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/schema.ts'
import { betterAuth } from 'better-auth/minimal'
import { deviceAuthorization, bearer } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth-drizzle-adapter'
import { strataBetterAuth } from '@strada.sh/sdk/better-auth'
import { json } from 'spiceflow'
import { TinybirdClient, TINYBIRD_DATASOURCES } from 'strada/src/tinybird'

// ── Drizzle client via D1 ───────────────────────────────────────────

function d1ToRawRows(results: Record<string, unknown>[]) {
  return results.map((row) => Object.keys(row).map((k) => row[k]))
}

export function getDb() {
  return drizzle(
    async (sql, params, method) => {
      const stmt = env.DB.prepare(sql).bind(...params)
      if (method === 'run') { await stmt.run(); return { rows: [] as any[] } }
      const rows = await stmt.raw()
      if (method === 'get') return { rows: rows[0] as any }
      return { rows: rows as any[] }
    },
    async (queries) => {
      const stmts = queries.map((q) => env.DB.prepare(q.sql).bind(...q.params))
      const results = await env.DB.batch(stmts)
      return results.map((r, i) => {
        const rows = d1ToRawRows(r.results as Record<string, unknown>[])
        if (queries[i]!.method === 'get') return { rows: rows[0] as any }
        return { rows: rows as any[] }
      })
    },
    { schema, relations: schema.relations },
  )
}

// ── BetterAuth ──────────────────────────────────────────────────────

export function getAuth() {
  const db = getDb()
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    session: {
      expiresIn: 60 * 60 * 24 * 365,
      updateAge: 60 * 60 * 24,
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
    experimental: { joins: true },
    plugins: [
      strataBetterAuth(),
      deviceAuthorization({ verificationUri: '/device', schema: {} }),
      bearer(),
    ],
  })
}

// ── Session helpers ─────────────────────────────────────────────────

type Session = { userId: string; user: { id: string; name: string; email: string } }

type RequestHeaders = Pick<Request, 'headers'>

export async function getSession(request: RequestHeaders): Promise<Session | null> {
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

export async function requireSession(request: RequestHeaders): Promise<Session> {
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

export async function getAccessibleOrgDatabase({
  userId,
  orgId,
}: {
  userId: string
  orgId: string
}) {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { userId, orgId },
    with: {
      org: {
        columns: {},
        with: {
          database: true,
        },
      },
    },
  })

  if (!member) return null

  return {
    member,
    database: member.org?.database ?? null,
  }
}

export async function getAccessibleProject({
  userId,
  projectId,
}: {
  userId: string
  projectId: string
}) {
  const db = getDb()
  const project = await db.query.project.findFirst({
    where: {
      id: projectId,
      org: {
        members: {
          userId,
        },
      },
    },
    with: {
      database: true,
      org: {
        columns: {},
        with: {
          members: {
            columns: { role: true },
            where: { userId },
            limit: 1,
          },
        },
      },
    },
  })

  if (!project) return null

  return Object.assign(project, {
    accessRole: project.org?.members[0]?.role ?? null,
  })
}

export async function getAccessibleOrgToken(userId: string, tokenId: string) {
  const db = getDb()
  const token = await db.query.orgToken.findFirst({
    where: {
      id: tokenId,
      org: {
        members: {
          userId,
        },
      },
    },
    with: {
      org: {
        columns: {},
        with: {
          members: {
            columns: { role: true },
            where: { userId },
            limit: 1,
          },
        },
      },
    },
  })

  if (!token) return null

  return token
}

// ── Token hashing ───────────────────────────────────────────────────

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateIngestToken(): { fullKey: string; prefix: string } {
  const raw = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  const fullKey = `str_${raw}`
  const prefix = raw.slice(0, 12)
  return { fullKey, prefix }
}

// ── Per-project Tinybird JWT ────────────────────────────────────────
// Each project gets a JWT with DATASOURCES:READ scopes filtered to its
// ProjectId. Tinybird enforces the filter server-side, so SQL queries
// never need WHERE ProjectId = '...'.
//
// JWTs are only regenerated when null (after `strada database upgrade`
// clears them) or on first project creation. They are NOT regenerated
// when the code's TINYBIRD_DATASOURCES list changes. This prevents
// deploying new code with new tables from breaking existing users who
// haven't run `database upgrade` yet. Users who want access to new
// tables must run `database upgrade`, which deploys the tables to
// Tinybird and clears cached JWTs so the next query creates a fresh
// one with the full datasource list.

// 100 years in seconds. Tinybird requires exp but has no way to skip it.
const JWT_TTL_SEC = 100 * 365 * 24 * 60 * 60

export interface ProjectJwtContext {
  projectId: string
  tinybirdEndpoint: string
  tinybirdAdminToken: string
  /** Existing cached JWT, if any */
  tinybirdJwt: string | null
  /** Comma-joined datasource names the cached JWT was created with */
  tinybirdJwtDatasources: string | null
}

/**
 * Get a valid Tinybird JWT for a project, generating one if missing.
 * Never regenerates based on code changes to TINYBIRD_DATASOURCES.
 * Only `strada database upgrade` clears cached JWTs to trigger regeneration.
 */
export async function getOrCreateProjectJwt(ctx: ProjectJwtContext): Promise<string> {
  // Use cached JWT if it exists, regardless of whether the code's datasource
  // list has changed. This prevents new code deploys from breaking queries
  // when new tables haven't been deployed to Tinybird yet.
  if (ctx.tinybirdJwt) {
    return ctx.tinybirdJwt
  }

  // No cached JWT: create one. Use the datasource list stored in D1 (set by
  // database upgrade) if available, otherwise fall back to the code's list
  // for first-ever JWT creation (database create flow).
  const datasources = ctx.tinybirdJwtDatasources
    ? ctx.tinybirdJwtDatasources.split(',')
    : [...TINYBIRD_DATASOURCES]

  const client = new TinybirdClient({
    baseUrl: ctx.tinybirdEndpoint,
    token: ctx.tinybirdAdminToken,
  })

  const expirationTimeSec = Math.floor(Date.now() / 1000) + JWT_TTL_SEC

  const result = await client.createJwt({
    name: `project_${ctx.projectId}`,
    expirationTime: expirationTimeSec,
    scopes: datasources.map((resource) => ({
      type: "DATASOURCES:READ" as const,
      resource,
      filter: `ProjectId = '${ctx.projectId}'`,
    })),
  })
  if (result instanceof Error) throw result

  // Cache the JWT and datasource list in D1
  const db = getDb()
  const currentDatasources = datasources.join(',')
  await db.update(schema.project)
    .set({ tinybirdJwt: result.token, tinybirdJwtDatasources: currentDatasources, updatedAt: Date.now() })
    .where(orm.eq(schema.project.id, ctx.projectId))

  return result.token
}
