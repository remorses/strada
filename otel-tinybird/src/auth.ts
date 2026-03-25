// Auth middleware for the OTLP-to-Tinybird proxy.
// Supports two key types:
//   sk_... (server key)  — no origin check, used by backend SDKs
//   pk_... (browser key) — origin checked against allowlist, used by browser SDKs

import { env } from 'cloudflare:workers'

interface Env {
  SERVER_API_KEY: string
  BROWSER_API_KEY: string
  ALLOWED_ORIGINS: string
}

export async function authMiddleware(
  { request }: { request: Request },
  next: () => Promise<Response>,
) {
  const apiKey = request.headers.get('x-api-key')

  if (!apiKey) {
    throw new Response('Missing x-api-key header', { status: 401 })
  }

  const { SERVER_API_KEY, BROWSER_API_KEY, ALLOWED_ORIGINS } =
    env as unknown as Env

  if (apiKey === SERVER_API_KEY) {
    return next()
  }

  if (apiKey === BROWSER_API_KEY) {
    const origin = request.headers.get('origin')
    if (!origin) {
      throw new Response('Browser key requires Origin header', { status: 403 })
    }
    const allowed = ALLOWED_ORIGINS.split(',').map((o: string) => o.trim())
    if (!allowed.includes(origin) && !allowed.includes('*')) {
      throw new Response('Origin not allowed', { status: 403 })
    }
    return next()
  }

  throw new Response('Invalid API key', { status: 401 })
}
