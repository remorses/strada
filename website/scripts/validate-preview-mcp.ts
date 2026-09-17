import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

const MCP_URL = 'https://preview.strada.sh/mcp'
const CLIENT_METADATA_URL = 'https://preview.strada.sh/.well-known/oauth-client'
const REDIRECT_URI = 'http://127.0.0.1:8765/callback'
const OUT_DIR = path.resolve(import.meta.dirname, '../../tmp')
const AUTH_URL_FILE = path.join(OUT_DIR, 'preview-mcp-auth-url.txt')
const STATE_FILE = path.join(OUT_DIR, 'preview-mcp-oauth-state.json')
const TOKEN_FILE = path.join(OUT_DIR, 'preview-mcp-token.json')
const RESULT_FILE = path.join(OUT_DIR, 'preview-mcp-result.json')

class PreviewMcpOAuthProvider implements OAuthClientProvider {
  clientMetadataUrl = CLIENT_METADATA_URL
  redirectStartAuthUrl: URL | undefined
  private tokensValue: OAuthTokens | undefined
  private clientInformationValue: OAuthClientInformation | undefined
  private codeVerifierValue: string | undefined

  get redirectUrl() {
    return REDIRECT_URI
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Strada MCP preview client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }
  }

  clientInformation() {
    return this.clientInformationValue
  }

  saveClientInformation(info: OAuthClientInformation) {
    this.clientInformationValue = info
  }

  tokens() {
    return this.tokensValue
  }

  saveTokens(tokens: OAuthTokens) {
    this.tokensValue = tokens
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.redirectStartAuthUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string) {
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier() {
    if (!this.codeVerifierValue) throw new Error('Code verifier not set')
    return this.codeVerifierValue
  }
}

function waitForCallback() {
  return new Promise<{ code: string; state: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', REDIRECT_URI)
      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state') || ''
      if (error || !code) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(`<p>OAuth failed: ${error || 'missing code'}</p>`)
        server.close()
        reject(new Error(error || 'missing code'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<p>MCP OAuth complete. You can close this tab.</p>')
      server.close()
      resolve({ code, state })
    })
    server.listen(8765, '127.0.0.1')
    setTimeout(() => {
      server.close()
      reject(new Error('OAuth callback timed out'))
    }, 5 * 60 * 1000)
  })
}

const step = process.argv[2] ?? 'start'
await mkdir(OUT_DIR, { recursive: true })

if (step === 'start') {
  const provider = new PreviewMcpOAuthProvider()
  const first = await auth(provider, { serverUrl: MCP_URL })
  if (first !== 'REDIRECT' || !provider.redirectStartAuthUrl) {
    throw new Error('expected OAuth redirect')
  }
  const authUrl = provider.redirectStartAuthUrl.toString()
  await writeFile(AUTH_URL_FILE, authUrl)
  await writeFile(STATE_FILE, JSON.stringify({
    authUrl,
    clientInformation: provider.clientInformation(),
    codeVerifier: provider.codeVerifier(),
  }, null, 2))
  console.log(authUrl)
  const callback = await waitForCallback()
  const second = await auth(provider, {
    serverUrl: MCP_URL,
    authorizationCode: callback.code,
  })
  if (second === 'REDIRECT' || !provider.tokens()?.access_token) {
    throw new Error('token exchange failed')
  }
  await writeFile(TOKEN_FILE, JSON.stringify({
    tokens: provider.tokens(),
    clientInformation: provider.clientInformation(),
  }, null, 2))
  console.log('oauth-complete')
  process.exit(0)
}

if (step === 'tools') {
  const state = JSON.parse(await readFile(TOKEN_FILE, 'utf8')) as {
    tokens?: { access_token?: string }
  }
  const token = state.tokens?.access_token
  if (!token) throw new Error('missing access token')
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'strada-preview-validator', version: '0.0.0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)
    const org = 'Personal'
    const project = 'mcp-preview'
    const whoami = await client.callTool({ name: 'whoami', arguments: {} })
    const orgs = await client.callTool({ name: 'orgs_list', arguments: {} })
    const projects = await client.callTool({ name: 'projects_list', arguments: { org } })
    const query = await client.callTool({
      name: 'query',
      arguments: { sql: 'SELECT 1 AS ok LIMIT 1', json: true, org, project },
    })
    const payload = {
      names,
      hasIssuesList: names.includes('issues_list'),
      hasLogs: names.includes('logs'),
      hasQuery: names.includes('query'),
      hasLogin: names.includes('login'),
      hasMcp: names.includes('mcp'),
      whoami,
      orgs,
      projects,
      query,
    }
    await writeFile(RESULT_FILE, JSON.stringify(payload, null, 2))
    console.log(JSON.stringify(payload, null, 2))
  } finally {
    await client.close()
  }
  process.exit(0)
}

throw new Error(`unknown step ${step}`)
