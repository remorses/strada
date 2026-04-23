// Tinybird browser OAuth flow for the database create CLI command.

import { createServer } from 'node:http'
import { once } from 'node:events'
import { openInBrowser } from 'goke'
import { exchangeTinybirdCliCode } from './tinybird.ts'

const authServerPort = 49160
const authHost = 'https://cloud.tinybird.co'
const authTimeoutSeconds = 180

export interface TinybirdAuthResult {
  token: string
  baseUrl: string
  workspaceName?: string
  userEmail?: string
}

function getCallbackHtml({ title, message, success }: { title: string; message: string; success: boolean }) {
  const icon = success
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Strada</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg: #fafafa; --fg: #171717; --muted: #737373; --border: #e5e5e5; --success: #22c55e; --error: #ef4444; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #ededed; --muted: #a3a3a3; --border: #262626; --success: #4ade80; --error: #f87171; } }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); display: flex; align-items: center; justify-content: center; min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .container { text-align: center; max-width: 380px; padding: 2rem; }
    .icon { width: 48px; height: 48px; margin: 0 auto 1.5rem; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); background: var(--bg); }
    .icon.success { border-color: var(--success); background: color-mix(in srgb, var(--success) 10%, var(--bg)); }
    .icon.error { border-color: var(--error); background: color-mix(in srgb, var(--error) 10%, var(--bg)); }
    .icon svg { width: 24px; height: 24px; }
    .icon.success svg { color: var(--success); }
    .icon.error svg { color: var(--error); }
    h1 { font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem; letter-spacing: -0.01em; }
    p { font-size: 0.875rem; color: var(--muted); line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon ${success ? 'success' : 'error'}">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
}

async function startCallbackServer({ onCode }: { onCode: (code: string) => void }) {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${authServerPort}`)
    const code = requestUrl.searchParams.get('code')

    res.setHeader('content-type', 'text/html; charset=utf-8')

    if (!code) {
      res.statusCode = 400
      res.end(getCallbackHtml({
        title: 'Authentication failed',
        message: 'Missing authorization code. Please try again from the CLI.',
        success: false,
      }))
      return
    }

    onCode(code)
    res.statusCode = 200
    res.end(getCallbackHtml({
      title: 'Authenticated',
      message: 'You can close this tab and return to the terminal.',
      success: true,
    }))
  })

  server.listen(authServerPort, '127.0.0.1')
  await once(server, 'listening')

  return () => {
    server.close()
  }
}

export async function browserLogin() {
  let closeServer: (() => void) | null = null
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const timeout = setTimeout(() => rejectCode(new Error(`Authentication timed out after ${authTimeoutSeconds}s`)), authTimeoutSeconds * 1000)

  const close = await startCallbackServer({ onCode: (code) => resolveCode(code) }).catch((cause) => new Error(String(cause instanceof Error ? cause.message : cause)))
  if (close instanceof Error) {
    clearTimeout(timeout)
    return close
  }
  closeServer = close

  const authUrl = new URL('/api/cli-login', authHost)
  authUrl.searchParams.set('origin', 'ts-sdk')
  console.log(authUrl.toString())
  void openInBrowser(authUrl.toString())

  const code = await codePromise.catch((cause) => new Error(String(cause instanceof Error ? cause.message : cause)))
  if (code instanceof Error) {
    clearTimeout(timeout)
    closeServer()
    return code
  }

  const tokens = await exchangeTinybirdCliCode({ authHost, code })
  clearTimeout(timeout)
  closeServer()
  if (tokens instanceof Error) return tokens

  return {
    token: tokens.workspace_token,
    baseUrl: tokens.api_host,
    ...(tokens.workspace_name !== undefined ? { workspaceName: tokens.workspace_name } : undefined),
    ...(tokens.user_email !== undefined ? { userEmail: tokens.user_email } : undefined),
  } satisfies TinybirdAuthResult
}
