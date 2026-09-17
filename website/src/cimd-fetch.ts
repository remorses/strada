import { connect } from 'cloudflare:sockets'
import { env } from 'cloudflare:workers'

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
  /^198\.1[89]\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^255\.255\.255\.255$/,
]

function isPublicIp(ip: string) {
  const normalized = ip.toLowerCase()
  if (normalized.includes(':')) {
    return !(
      normalized === '::1'
      || normalized.startsWith('fe80:')
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('::ffff:')
    )
  }
  return !PRIVATE_IPV4.some((re) => re.test(ip))
}

async function resolvePublicAddresses(hostname: string) {
  const ipv4 = new URL('https://cloudflare-dns.com/dns-query')
  ipv4.searchParams.set('name', hostname)
  ipv4.searchParams.set('type', 'A')
  const ipv6 = new URL(ipv4)
  ipv6.searchParams.set('type', 'AAAA')
  const headers = { accept: 'application/dns-json' }
  const [aRes, aaaaRes] = await Promise.all([
    fetch(ipv4, { headers }),
    fetch(ipv6, { headers }),
  ])
  const [aBody, aaaaBody] = await Promise.all([
    aRes.json() as { Answer?: Array<{ data: string; type: number }> },
    aaaaRes.json() as { Answer?: Array<{ data: string; type: number }> },
  ])
  const addresses = [
    ...(aBody.Answer ?? []).filter((row) => row.type === 1).map((row) => row.data),
    ...(aaaaBody.Answer ?? []).filter((row) => row.type === 28).map((row) => row.data),
  ]
  if (addresses.length === 0) {
    throw new TypeError('metadata hostname returned no DNS addresses')
  }
  for (const address of addresses) {
    if (!isPublicIp(address)) {
      throw new TypeError('metadata hostname must resolve only to public-routable addresses')
    }
  }
  return addresses
}

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

function parseHttpResponse(raw: Uint8Array) {
  const text = new TextDecoder().decode(raw)
  const separator = text.indexOf('\r\n\r\n')
  if (separator < 0) throw new TypeError('CIMD response missing HTTP header terminator')
  const [statusLine, ...headerLines] = text.slice(0, separator).split('\r\n')
  const match = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine ?? '')
  if (!match) throw new TypeError('CIMD response missing HTTP status')
  const headers = new Headers()
  for (const line of headerLines) {
    const index = line.indexOf(':')
    if (index < 0) continue
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }
  return new Response(text.slice(separator + 4), {
    status: Number(match[1]),
    headers,
  })
}

export async function fetchCimdOnWorkers(input: RequestInfo | URL, init?: RequestInit) {
  const webRequest = new Request(input, { ...init, redirect: 'manual' })
  const url = new URL(webRequest.url)
  if (url.protocol !== 'https:') {
    throw new TypeError('CIMD Workers transport requires an HTTPS URL')
  }
  if (webRequest.method !== 'GET' && webRequest.method !== 'HEAD') {
    throw new TypeError('CIMD Workers transport supports only GET and HEAD')
  }

  await resolvePublicAddresses(url.hostname)
  const origin = new URL(env.BETTER_AUTH_URL).origin
  if (url.origin === origin) {
    return fetch(webRequest)
  }

  const addresses = await resolvePublicAddresses(url.hostname)
  const pinnedAddress = addresses[0]!
  const port = url.port ? Number(url.port) : 443
  const socket = connect(
    { hostname: pinnedAddress, port },
    { secureTransport: 'starttls', allowHalfOpen: true },
  )
  const tls = socket.startTls({ expectedServerHostname: url.hostname })
  const path = `${url.pathname}${url.search}` || '/'
  const headerLines = [
    `${webRequest.method} ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    'Connection: close',
    'Accept: application/json',
  ]
  for (const [name, value] of webRequest.headers) {
    if (name.toLowerCase() === 'host') continue
    headerLines.push(`${name}: ${value}`)
  }
  const writer = tls.writable.getWriter()
  await writer.write(new TextEncoder().encode(`${headerLines.join('\r\n')}\r\n\r\n`))
  await writer.close()
  const reader = tls.readable.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  await tls.close()
  return parseHttpResponse(concat(chunks))
}
