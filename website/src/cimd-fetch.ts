import { connect } from 'cloudflare:sockets'
import { isPublicRoutableHost } from '@better-auth/core/utils/host'
import { mcpClientMetadataDocument, mcpClientMetadataUrl } from './mcp-resource.ts'

const MAX_BODY_BYTES = 64 * 1024
const HEADER_TERMINATOR = new TextEncoder().encode('\r\n\r\n')

function concat(chunks: Uint8Array[]) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function indexOf(haystack: Uint8Array, needle: Uint8Array) {
  if (needle.byteLength === 0) return 0
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

async function resolvePublicAddresses(hostname: string, signal?: AbortSignal) {
  const ipv4 = new URL('https://cloudflare-dns.com/dns-query')
  ipv4.searchParams.set('name', hostname)
  ipv4.searchParams.set('type', 'A')
  const ipv6 = new URL(ipv4)
  ipv6.searchParams.set('type', 'AAAA')
  const headers = { accept: 'application/dns-json' }
  const [aRes, aaaaRes] = await Promise.all([
    fetch(ipv4, { headers, signal }),
    fetch(ipv6, { headers, signal }),
  ])
  type DnsJson = { Answer?: Array<{ data: string; type: number }> }
  const [aBody, aaaaBody] = await Promise.all([
    aRes.json() as Promise<DnsJson>,
    aaaaRes.json() as Promise<DnsJson>,
  ])
  const addresses = [
    ...(aBody.Answer ?? []).filter((row) => row.type === 1).map((row) => row.data),
    ...(aaaaBody.Answer ?? []).filter((row) => row.type === 28).map((row) => row.data),
  ]
  if (addresses.length === 0) {
    throw new TypeError('metadata hostname returned no DNS addresses')
  }
  for (const address of addresses) {
    if (!isPublicRoutableHost(address)) {
      throw new TypeError('metadata hostname must resolve only to public-routable addresses')
    }
  }
  return addresses
}

function parseHeaders(raw: Uint8Array) {
  const text = new TextDecoder().decode(raw)
  const [statusLine, ...headerLines] = text.split('\r\n')
  const match = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine ?? '')
  if (!match) throw new TypeError('CIMD response missing HTTP status')
  const headers = new Headers()
  for (const line of headerLines) {
    const index = line.indexOf(':')
    if (index < 0) continue
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }
  return { status: Number(match[1]), headers }
}

function decodeChunked(raw: Uint8Array) {
  const chunks: Uint8Array[] = []
  let offset = 0
  while (offset < raw.byteLength) {
    const lineEnd = indexOf(raw.subarray(offset), new TextEncoder().encode('\r\n'))
    if (lineEnd < 0) throw new TypeError('CIMD chunked body is truncated')
    const size = Number.parseInt(new TextDecoder().decode(raw.subarray(offset, offset + lineEnd)), 16)
    if (!Number.isFinite(size) || size < 0) throw new TypeError('CIMD chunk size is invalid')
    offset += lineEnd + 2
    if (size === 0) break
    chunks.push(raw.subarray(offset, offset + size))
    offset += size + 2
  }
  return concat(chunks)
}

async function readCappedBody(opts: {
  reader: ReadableStreamDefaultReader<Uint8Array>
  prefix: Uint8Array
  signal?: AbortSignal
}) {
  const { reader, prefix, signal } = opts
  const chunks = prefix.byteLength ? [prefix] : []
  let size = prefix.byteLength
  while (true) {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) throw new TypeError('CIMD response exceeded 64 KiB')
    chunks.push(value)
  }
  return concat(chunks)
}

export async function fetchCimdOnWorkers(input: RequestInfo | URL, init?: RequestInit) {
  const webRequest = new Request(input, { ...init, redirect: 'manual' })
  const url = new URL(webRequest.url)
  if (url.href === mcpClientMetadataUrl()) {
    return Response.json(mcpClientMetadataDocument())
  }
  if (url.protocol !== 'https:') {
    throw new TypeError('CIMD Workers transport requires an HTTPS URL')
  }
  if (webRequest.method !== 'GET' && webRequest.method !== 'HEAD') {
    throw new TypeError('CIMD Workers transport supports only GET and HEAD')
  }

  const signal = init?.signal ?? (input instanceof Request ? input.signal : webRequest.signal)
  const addresses = await resolvePublicAddresses(url.hostname, signal)
  const pinnedAddress = addresses[0]!
  const port = url.port ? Number(url.port) : 443
  const socket = connect(
    { hostname: pinnedAddress, port },
    { secureTransport: 'starttls', allowHalfOpen: true },
  )
  const tls = socket.startTls({ expectedServerHostname: url.hostname })
  const abort = () => { void tls.close() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    abort()
    throw new DOMException('The operation was aborted.', 'AbortError')
  }

  try {
    const path = `${url.pathname}${url.search}` || '/'
    const headerLines = [
      `${webRequest.method} ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: close',
      'Accept: application/json',
      'Accept-Encoding: identity',
    ]
    for (const [name, value] of webRequest.headers) {
      if (name.toLowerCase() === 'host') continue
      headerLines.push(`${name}: ${value}`)
    }
    const writer = tls.writable.getWriter()
    await writer.write(new TextEncoder().encode(`${headerLines.join('\r\n')}\r\n\r\n`))
    await writer.close()

    const reader = tls.readable.getReader()
    const headerChunks: Uint8Array[] = []
    let headerBytes = 0
    let rest = new Uint8Array()
    while (true) {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      const { done, value } = await reader.read()
      if (done) throw new TypeError('CIMD response missing HTTP header terminator')
      headerChunks.push(value)
      headerBytes += value.byteLength
      if (headerBytes > MAX_BODY_BYTES) throw new TypeError('CIMD response exceeded 64 KiB')
      const buffered = concat(headerChunks)
      const separator = indexOf(buffered, HEADER_TERMINATOR)
      if (separator < 0) continue
      const { status, headers } = parseHeaders(buffered.subarray(0, separator))
      rest = buffered.subarray(separator + HEADER_TERMINATOR.byteLength)
      const rawBody = await readCappedBody({ reader, prefix: rest, signal })
      const transfer = headers.get('transfer-encoding')?.toLowerCase() ?? ''
      const body = transfer.includes('chunked') ? decodeChunked(rawBody) : rawBody
      if (body.byteLength > MAX_BODY_BYTES) throw new TypeError('CIMD response exceeded 64 KiB')
      return new Response(webRequest.method === 'HEAD' ? null : body, { status, headers })
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await tls.close().catch(() => undefined)
  }
}
