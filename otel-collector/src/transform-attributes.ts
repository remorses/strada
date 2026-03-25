// Attribute conversion utilities matching the Go exporter's internal/utils.go.
// The Go exporter converts all attribute values to strings.

import type { AnyValue, KeyValue, Exemplar } from './otlp-types.ts'

export function anyValueToString(v: AnyValue | undefined): string {
  if (!v) return ''
  if (v.stringValue !== undefined) return v.stringValue
  if (v.intValue !== undefined) return v.intValue // already a string in JSON
  if (v.doubleValue !== undefined) return String(v.doubleValue)
  if (v.boolValue !== undefined) return String(v.boolValue)
  if (v.arrayValue) {
    return JSON.stringify((v.arrayValue.values ?? []).map(anyValueToString))
  }
  if (v.kvlistValue) {
    return JSON.stringify(convertAttributes(v.kvlistValue.values ?? []))
  }
  if (v.bytesValue !== undefined) return v.bytesValue // base64 string
  return ''
}

export function convertAttributes(
  kvs: KeyValue[] | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  if (!kvs) return result
  for (const kv of kvs) {
    result[kv.key] = anyValueToString(kv.value)
  }
  return result
}

export function getServiceName(kvs: KeyValue[] | undefined): string {
  if (!kvs) return ''
  const attr = kvs.find((kv) => kv.key === 'service.name')
  return attr ? anyValueToString(attr.value) : ''
}

export function nanosToRFC3339(nanos: string): string {
  const ns = BigInt(nanos)
  const ms = Number(ns / 1_000_000n)
  const remainderNs = Number(ns % 1_000_000_000n)
  const date = new Date(ms)
  const iso = date.toISOString()
  const dotIndex = iso.lastIndexOf('.')
  const prefix = iso.substring(0, dotIndex)
  const nsFraction = remainderNs.toString().padStart(9, '0')
  return `${prefix}.${nsFraction}Z`
}

export function convertExemplars(exemplars: Exemplar[] | undefined): {
  exemplars_filtered_attributes: Record<string, string>[]
  exemplars_timestamp: string[]
  exemplars_value: number[]
  exemplars_span_id: string[]
  exemplars_trace_id: string[]
} {
  if (!exemplars || exemplars.length === 0) {
    return {
      exemplars_filtered_attributes: [],
      exemplars_timestamp: [],
      exemplars_value: [],
      exemplars_span_id: [],
      exemplars_trace_id: [],
    }
  }

  return {
    exemplars_filtered_attributes: exemplars.map((e) =>
      convertAttributes(e.filteredAttributes),
    ),
    exemplars_timestamp: exemplars.map((e) => nanosToRFC3339(e.timeUnixNano)),
    exemplars_value: exemplars.map((e) => {
      if (e.asInt !== undefined) return Number(e.asInt)
      if (e.asDouble !== undefined) return e.asDouble
      return 0
    }),
    exemplars_span_id: exemplars.map((e) => e.spanId ?? ''),
    exemplars_trace_id: exemplars.map((e) => e.traceId ?? ''),
  }
}

export function getNumberValue(dp: {
  asDouble?: number
  asInt?: string
}): number {
  if (dp.asInt !== undefined) return Number(dp.asInt)
  if (dp.asDouble !== undefined) return dp.asDouble
  return 0
}
