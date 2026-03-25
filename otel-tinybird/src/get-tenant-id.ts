// Extract tenant_id from the request hostname.
// Multi-tenant: {tenant}-ingest.{domain} → "acme"
// Self-hosted:  ingest.{domain}, localhost, IP → "" (empty string)

export function getTenantId(request: Request): string {
  const hostname = new URL(request.url).hostname
  const match = hostname.match(/^(.+)-ingest\./)
  if (match) return match[1]
  return ''
}
