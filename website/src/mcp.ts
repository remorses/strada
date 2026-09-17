import { requireMcpAuth } from '@better-auth/mcp'
import { addCliToolsToMcp } from '@goke/mcp'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { env } from 'cloudflare:workers'
import { buildCli, isMcpCommand } from 'strada/src/command-tree'
import { inProcessMcp } from 'strada/src/mcp-request'
import { api } from './api.ts'
import { getAuth, getDb } from './db.ts'
import { isAllowedMcpOrigin, mcpResourceUrl } from './mcp-resource.ts'
import packageJson from '../package.json' with { type: 'json' }

const mcpCli = buildCli()

async function inProcessFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
  const url = new URL(request.url, env.BETTER_AUTH_URL)
  const headers = new Headers(request.headers)
  headers.delete('authorization')
  return api.handle(new Request(url, { method: request.method, headers, body: request.body }))
}

async function handleAuthenticatedMcp(request: Request, sub: string) {
  const db = getDb()
  const user = await db.query.user.findFirst({ where: { id: sub } })
  if (!user) return new Response('unauthorized', { status: 401 })

  const parsedBody = await request.clone().json().catch(() => undefined)
  const tenantCli = mcpCli.clone({
    cwd: '/',
    env: { STRADA_API_URL: env.BETTER_AUTH_URL },
  })
  const mcpServer = new McpServer(
    { name: 'strada', version: packageJson.version },
    { capabilities: {} },
  )
  addCliToolsToMcp({ cli: tenantCli, server: mcpServer, commandFilter: isMcpCommand })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await mcpServer.connect(transport)
  try {
    return await inProcessMcp.run(
      {
        userId: user.id,
        user: { name: user.name, email: user.email },
        baseUrl: env.BETTER_AUTH_URL,
        fetch: inProcessFetch,
      },
      () => transport.handleRequest(request, { parsedBody }),
    )
  } finally {
    await transport.close()
    await mcpServer.close()
  }
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin && !isAllowedMcpOrigin(origin)) {
    return new Response(null, { status: 403 })
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  const auth = getAuth()
  const resource = mcpResourceUrl()
  return requireMcpAuth(
    auth,
    async (authenticatedRequest, accessTokenClaims) => {
      const sub = accessTokenClaims.sub
      if (typeof sub !== 'string' || sub.length === 0) {
        return new Response('unauthorized', { status: 401 })
      }
      return handleAuthenticatedMcp(authenticatedRequest, sub)
    },
    { resource },
  )(request)
}
