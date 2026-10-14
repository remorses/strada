// CIMD metadata transport for Workers: fetches MCP clients' metadata documents
// (e.g. https://claude.ai/oauth/mcp-oauth-client-metadata) for @better-auth/cimd.
//
// @better-auth/cimd asks the transport to pin a public address and refuse redirects, so
// a client_id URL cannot reach private hosts (SSRF). On Workers, subrequests leave from
// Cloudflare's edge, which has no private network and refuses special-use addresses.
// So this is plain fetch with redirects refused and the body capped.
// Not `connect()` with a pinned IP: Workers sockets cannot reach Cloudflare IP ranges,
// and most client metadata (claude.ai, trycloudflare) is behind Cloudflare.
// https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

import { mcpClientMetadataDocument, mcpClientMetadataUrl } from './mcp-resource.ts'

const MAX_BODY_BYTES = 64 * 1024

export async function fetchCimdOnWorkers(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, { ...init, redirect: 'manual' })
  const url = new URL(request.url)
  if (url.href === mcpClientMetadataUrl()) {
    return Response.json(mcpClientMetadataDocument())
  }
  if (url.protocol !== 'https:') throw new TypeError('CIMD metadata URL must be HTTPS')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new TypeError('CIMD transport supports only GET and HEAD')
  }

  const response = await fetch(request)
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new TypeError('CIMD metadata redirects are not followed')
  }
  if (request.method === 'HEAD' || !response.body) {
    return new Response(null, { status: response.status, headers: response.headers })
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new TypeError('CIMD response exceeded 64 KiB')
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  // The body is decoded already: drop headers that describe the wire encoding.
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(body, { status: response.status, headers })
}
