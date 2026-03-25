import { describe, it, expect } from 'vitest'
import { transformTraces } from './transform-traces.ts'
import type { ExportTraceServiceRequest } from './otlp-types.ts'

describe('transformTraces', () => {
  it('returns empty string for empty request', () => {
    expect(transformTraces({}, 'test-tenant')).toBe('')
    expect(transformTraces({ resourceSpans: [] }, 'test-tenant')).toBe('')
  })

  it('transforms a complete trace span', () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'my-api' } },
              { key: 'deployment', value: { stringValue: 'prod' } },
            ],
          },
          schemaUrl: 'https://opentelemetry.io/schemas/1.0.0',
          scopeSpans: [
            {
              scope: {
                name: 'my-tracer',
                version: '1.0.0',
                attributes: [
                  { key: 'scope.attr', value: { stringValue: 'val' } },
                ],
              },
              schemaUrl: 'https://scope.schema',
              spans: [
                {
                  traceId: '5B8EFFF798038103D269B633813FC60C',
                  spanId: 'EEE19B7EC3C1B174',
                  parentSpanId: 'EEE19B7EC3C1B173',
                  traceState: 'key=value',
                  name: 'GET /users',
                  kind: 2, // SERVER
                  startTimeUnixNano: '1544712660000000000',
                  endTimeUnixNano: '1544712661000000000',
                  attributes: [
                    {
                      key: 'http.method',
                      value: { stringValue: 'GET' },
                    },
                    {
                      key: 'http.status_code',
                      value: { intValue: '200' },
                    },
                  ],
                  status: { code: 1, message: '' },
                  flags: 1,
                  events: [
                    {
                      timeUnixNano: '1544712660500000000',
                      name: 'cache.hit',
                      attributes: [
                        {
                          key: 'cache.key',
                          value: { stringValue: 'users:all' },
                        },
                      ],
                    },
                  ],
                  links: [
                    {
                      traceId: 'AAAA',
                      spanId: 'BBBB',
                      traceState: 'linked=true',
                      attributes: [
                        {
                          key: 'link.type',
                          value: { stringValue: 'parent' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const ndjson = transformTraces(input, 'acme')
    const lines = ndjson.trim().split('\n')
    expect(lines).toHaveLength(1)

    const row = JSON.parse(lines[0]!)
    expect(row).toMatchInlineSnapshot(`
      {
        "duration": 1000000000,
        "end_time": "2018-12-13T14:51:01.000000000Z",
        "events_attributes": [
          {
            "cache.key": "users:all",
          },
        ],
        "events_name": [
          "cache.hit",
        ],
        "events_timestamp": [
          "2018-12-13T14:51:00.500000000Z",
        ],
        "links_attributes": [
          {
            "link.type": "parent",
          },
        ],
        "links_span_id": [
          "BBBB",
        ],
        "links_trace_id": [
          "AAAA",
        ],
        "links_trace_state": [
          "linked=true",
        ],
        "parent_span_id": "EEE19B7EC3C1B173",
        "resource_attributes": {
          "deployment": "prod",
          "service.name": "my-api",
        },
        "resource_schema_url": "https://opentelemetry.io/schemas/1.0.0",
        "scope_attributes": {
          "scope.attr": "val",
        },
        "scope_name": "my-tracer",
        "scope_schema_url": "https://scope.schema",
        "scope_version": "1.0.0",
        "service_name": "my-api",
        "span_attributes": {
          "http.method": "GET",
          "http.status_code": "200",
        },
        "span_id": "EEE19B7EC3C1B174",
        "span_kind": "Server",
        "span_name": "GET /users",
        "start_time": "2018-12-13T14:51:00.000000000Z",
        "status_code": "Ok",
        "status_message": "",
        "tenant_id": "acme",
        "trace_flags": 1,
        "trace_id": "5B8EFFF798038103D269B633813FC60C",
        "trace_state": "key=value",
      }
    `)
  })

  it('handles minimal span with missing optional fields', () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abc123',
                  spanId: 'def456',
                  name: 'simple-span',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    }

    const ndjson = transformTraces(input, 'acme')
    const row = JSON.parse(ndjson.trim())

    expect(row.tenant_id).toBe('acme')
    expect(row.trace_id).toBe('abc123')
    expect(row.span_id).toBe('def456')
    expect(row.parent_span_id).toBe('')
    expect(row.span_kind).toBe('Unspecified')
    expect(row.status_code).toBe('Unset')
    expect(row.service_name).toBe('')
    expect(row.events_timestamp).toEqual([])
    expect(row.links_trace_id).toEqual([])
    expect(row.duration).toBe(1000000000)
  })

  it('transforms multiple spans across resources', () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't1',
                  spanId: 's1',
                  name: 'span-1',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
                {
                  traceId: 't1',
                  spanId: 's2',
                  name: 'span-2',
                  startTimeUnixNano: '2000000000',
                  endTimeUnixNano: '3000000000',
                },
              ],
            },
          ],
        },
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-b' } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't2',
                  spanId: 's3',
                  name: 'span-3',
                  startTimeUnixNano: '3000000000',
                  endTimeUnixNano: '4000000000',
                },
              ],
            },
          ],
        },
      ],
    }

    const ndjson = transformTraces(input, 'acme')
    const lines = ndjson.trim().split('\n')
    expect(lines).toHaveLength(3)

    const rows = lines.map((l) => JSON.parse(l))
    expect(rows[0]!.tenant_id).toBe('acme')
    expect(rows[0]!.service_name).toBe('svc-a')
    expect(rows[0]!.span_name).toBe('span-1')
    expect(rows[1]!.service_name).toBe('svc-a')
    expect(rows[1]!.span_name).toBe('span-2')
    expect(rows[2]!.service_name).toBe('svc-b')
    expect(rows[2]!.span_name).toBe('span-3')
  })
})
