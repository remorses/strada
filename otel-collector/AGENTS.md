# otel-collector

Cloudflare Worker (Spiceflow) that receives OTLP HTTP/JSON from OTel SDKs and forwards to Tinybird or ClickHouse as NDJSON.

converted to ts from https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/tinybirdexporter

## Backend selection

Two storage backends, selected by environment variables at deploy time:

- **Tinybird**: set `TINYBIRD_ENDPOINT` + `TINYBIRD_TOKEN`. Sends snake_case NDJSON to Tinybird Events API. Tinybird's `json:$.field` mappings handle conversion to PascalCase columns.
- **ClickHouse**: set `CLICKHOUSE_URL` (+ `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`). Remaps NDJSON keys to PascalCase via `field-mapping.ts`, then sends via `INSERT INTO table FORMAT JSONEachLine`.

The backend factory is in `backend.ts`. Only one backend should be configured per deployment.

## JSON only

This collector only accepts **OTLP HTTP/JSON** (`Content-Type: application/json`). It does NOT support protobuf or gRPC. The worker parses incoming requests with `request.json()` and the types in `otlp-types.ts` match the JSON wire format of the OTLP spec.

Users must configure their OTel SDKs to export as JSON, not protobuf. For the JS SDK this means using the `-http` exporter packages (`@opentelemetry/exporter-trace-otlp-http`) or setting `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.

## Endpoints

- `POST /v1/traces` → transforms to NDJSON → writes to `otel_traces`
- `POST /v1/logs` → transforms to NDJSON → writes to `otel_logs`
- `POST /v1/metrics` → transforms to NDJSON → writes to `otel_metrics_gauge`, `otel_metrics_sum`, `otel_metrics_histogram`, `otel_metrics_exponential_histogram` (depending on metric type)

## Multi-tenancy

Tenant ID is extracted from the request hostname. See the root `AGENTS.md` for the full explanation. The function is in `get-tenant-id.ts`.

## Auth

No auth on writes. The hostname IS the tenant identity (like Sentry's DSN). Security is enforced on reads via Tinybird JWT (or ClickHouse auth for self-hosted), not on writes. If spam becomes a problem, add Cloudflare rate limiting per IP.

## Transform pipeline

Each signal has a transform module that converts OTLP JSON into NDJSON:

- `transform-traces.ts` — flattens `resourceSpans[].scopeSpans[].spans[]` into rows
- `transform-logs.ts` — flattens `resourceLogs[].scopeLogs[].logRecords[]` into rows
- `transform-metrics.ts` — flattens `resourceMetrics[].scopeMetrics[].metrics[]` into rows, splitting by metric type (gauge/sum/histogram/exponential histogram)
- `transform-attributes.ts` — shared utilities (attribute conversion, nanosecond timestamps, exemplars)

All transforms inject `tenant_id` into every row and output snake_case JSON keys. Row types are defined in `otel-row-types.ts`.

## Field mapping (ClickHouse backend only)

When using the ClickHouse backend, `field-mapping.ts` remaps snake_case JSON keys to PascalCase ClickHouse column names before INSERT. Most mappings are simple snake→Pascal, but some are non-trivial:

| JSON key            | ClickHouse column | Table(s)    |
| ------------------- | ----------------- | ----------- |
| `start_time`        | `Timestamp`       | traces      |
| `flags`             | `TraceFlags`      | logs        |
| `flags`             | `Flags`           | metrics     |
| `metric_attributes` | `Attributes`      | all metrics |
| `start_timestamp`   | `StartTimeUnix`   | all metrics |
| `timestamp`         | `TimeUnix`        | all metrics |

When the schema changes, update both the Tinybird `.datasource` files AND `field-mapping.ts`.

## Error extraction

`extract-errors.ts` scans incoming logs and traces for exceptions:

- From logs: log records with `exception.type` or `exception.message` in `LogAttributes`
- From traces: span events named `exception`

Extracted errors are written to `otel_errors` with fingerprinting for issue grouping. See root `AGENTS.md` for the full error tracking documentation.

## Testing

Run tests with `vitest run` (not `vitest` which starts watch mode and never exits):

```bash
bun run vitest run                           # all tests
bun run vitest run src/extract-errors.test.ts # single file
```
