import { env } from 'cloudflare:workers'

export function mcpResourceUrl() {
  return new URL('/mcp', env.BETTER_AUTH_URL).href
}

export function mcpClientMetadataUrl() {
  return new URL('/.well-known/oauth-client', env.BETTER_AUTH_URL).href
}

export function isAllowedMcpOrigin(origin: string) {
  return origin === new URL(env.BETTER_AUTH_URL).origin
}

export function mcpClientMetadataDocument() {
  return {
    client_id: mcpClientMetadataUrl(),
    client_name: 'Strada MCP preview client',
    redirect_uris: [
      'http://127.0.0.1:8765/callback',
      'http://localhost:8765/callback',
    ],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  }
}
