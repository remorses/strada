import { describe, it, expect } from 'vitest'
import { transformLogs } from './transform-logs.ts'
import type { ExportLogsServiceRequest } from './otlp-types.ts'

describe('transformLogs', () => {
  it('returns empty string for empty request', () => {
    expect(transformLogs({})).toBe('')
    expect(transformLogs({ resourceLogs: [] })).toBe('')
  })

  it('transforms a complete log record', () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'my-api' } },
            ],
          },
          schemaUrl: 'https://opentelemetry.io/schemas/1.0.0',
          scopeLogs: [
            {
              scope: {
                name: 'my-logger',
                version: '2.0.0',
                attributes: [
                  { key: 'scope.key', value: { stringValue: 'scope-val' } },
                ],
              },
              schemaUrl: 'https://scope.schema',
              logRecords: [
                {
                  timeUnixNano: '1544712660123456789',
                  observedTimeUnixNano: '1544712660200000000',
                  severityNumber: 9,
                  severityText: 'INFO',
                  body: { stringValue: 'User logged in' },
                  attributes: [
                    {
                      key: 'user.id',
                      value: { stringValue: '12345' },
                    },
                  ],
                  traceId: 'abc123',
                  spanId: 'def456',
                  flags: 1,
                },
              ],
            },
          ],
        },
      ],
    }

    const ndjson = transformLogs(input)
    const row = JSON.parse(ndjson.trim())

    expect(row).toMatchInlineSnapshot(`
      {
        "body": "User logged in",
        "flags": 1,
        "log_attributes": {
          "user.id": "12345",
        },
        "resource_attributes": {
          "service.name": "my-api",
        },
        "resource_schema_url": "https://opentelemetry.io/schemas/1.0.0",
        "scope_attributes": {
          "scope.key": "scope-val",
        },
        "scope_name": "my-logger",
        "scope_schema_url": "https://scope.schema",
        "scope_version": "2.0.0",
        "service_name": "my-api",
        "severity_number": 9,
        "severity_text": "INFO",
        "span_id": "def456",
        "timestamp": "2018-12-13T14:51:00.123456789Z",
        "trace_id": "abc123",
      }
    `)
  })

  it('falls back to observedTimeUnixNano when timeUnixNano is missing', () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  observedTimeUnixNano: '1544712660200000000',
                  body: { stringValue: 'test' },
                },
              ],
            },
          ],
        },
      ],
    }

    const ndjson = transformLogs(input)
    const row = JSON.parse(ndjson.trim())
    expect(row.timestamp).toBe('2018-12-13T14:51:00.200000000Z')
  })

  it('falls back to observedTimeUnixNano when timeUnixNano is zero', () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '0',
                  observedTimeUnixNano: '1544712660300000000',
                  body: { stringValue: 'test' },
                },
              ],
            },
          ],
        },
      ],
    }

    const ndjson = transformLogs(input)
    const row = JSON.parse(ndjson.trim())
    expect(row.timestamp).toBe('2018-12-13T14:51:00.300000000Z')
  })

  it('handles missing optional fields gracefully', () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1000000000',
                },
              ],
            },
          ],
        },
      ],
    }

    const ndjson = transformLogs(input)
    const row = JSON.parse(ndjson.trim())

    expect(row.service_name).toBe('')
    expect(row.trace_id).toBe('')
    expect(row.span_id).toBe('')
    expect(row.severity_text).toBe('')
    expect(row.severity_number).toBe(0)
    expect(row.body).toBe('')
    expect(row.flags).toBe(0)
  })
})
