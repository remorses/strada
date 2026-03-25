import { describe, it, expect } from 'vitest'
import { getTenantId } from './get-tenant-id.ts'

describe('getTenantId', () => {
  it('extracts tenant from standard ingest subdomain', () => {
    const req = new Request('https://acme-ingest.stradametrics.com/v1/traces')
    expect(getTenantId(req)).toBe('acme')
  })

  it('extracts tenant with hyphens in name', () => {
    const req = new Request('https://my-company-ingest.stradametrics.com/v1/logs')
    expect(getTenantId(req)).toBe('my-company')
  })

  it('returns empty string for plain ingest subdomain (self-hosted)', () => {
    const req = new Request('https://ingest.mycompany.com/v1/traces')
    expect(getTenantId(req)).toBe('')
  })

  it('returns empty string for ingest.stradametrics.com', () => {
    const req = new Request('https://ingest.stradametrics.com/v1/logs')
    expect(getTenantId(req)).toBe('')
  })

  it('returns empty string for localhost', () => {
    const req = new Request('http://localhost:8080/v1/traces')
    expect(getTenantId(req)).toBe('')
  })

  it('returns empty string for plain domain', () => {
    const req = new Request('https://stradametrics.com/v1/traces')
    expect(getTenantId(req)).toBe('')
  })

  it('returns empty string for IP address', () => {
    const req = new Request('http://127.0.0.1:3000/v1/traces')
    expect(getTenantId(req)).toBe('')
  })
})
