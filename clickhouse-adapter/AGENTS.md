# clickhouse-adapter

Implements the Tinybird Events API and Query API against a generic ClickHouse server. This lets the `otel-collector` worker (and any future Strada services) work with self-hosted ClickHouse without any changes — just point `TINYBIRD_ENDPOINT` at this adapter instead of Tinybird.

## Architecture

```
otel-collector → clickhouse-adapter → ClickHouse
  (unchanged)    (this package)        (self-hosted)
```

The otel-collector always speaks Tinybird's protocol. For hosted Tinybird, it talks directly to `api.us-east.aws.tinybird.co`. For self-hosted ClickHouse, it talks to this adapter which translates and forwards.

## Auth

No auth on incoming requests. ClickHouse credentials are wrangler secrets on the adapter itself:

```env
CLICKHOUSE_URL=http://localhost:8123    # ClickHouse HTTP interface
CLICKHOUSE_DATABASE=default             # Target database
CLICKHOUSE_USER=default                 # ClickHouse user (wrangler var)
CLICKHOUSE_PASSWORD=mypassword          # ClickHouse password (wrangler secret)
```

The adapter reads these from env and uses them for every ClickHouse request. No Bearer tokens, no base64 encoding.

## Field name remapping

The otel-collector produces NDJSON with snake_case keys (matching Go conventions). ClickHouse columns use PascalCase (OTel community convention). The adapter remaps field names per-table before inserting.

The mappings are defined in `src/field-mapping.ts`, derived from the Tinybird `.datasource` files' `json:$.field_name` → `ColumnName` definitions.

Most mappings are simple snake_to_Pascal, but some are non-trivial:

| Table | JSON key | ClickHouse column |
|-------|----------|------------------|
| otel_traces | `start_time` | `Timestamp` |
| otel_logs | `flags` | `TraceFlags` |
| otel_metrics_* | `metric_attributes` | `Attributes` |
| otel_metrics_* | `start_timestamp` | `StartTimeUnix` |
| otel_metrics_* | `timestamp` | `TimeUnix` |

When the schema changes, update both the Tinybird `.datasource` files AND `field-mapping.ts`.

## Endpoints

**`POST /v0/events?name={table}`** — Tinybird Events API (ingestion)
- Accepts `application/x-ndjson` body
- Remaps field names snake_case → PascalCase
- Inserts via ClickHouse HTTP interface with `FORMAT JSONEachLine`
- Returns `{"successful_rows": N, "quarantined_rows": 0}` matching Tinybird's response format

**`POST /v0/sql`** and **`GET /v0/sql?q={sql}`** — Tinybird Query API (reads)
- Passes SQL through to ClickHouse HTTP interface
- Appends `FORMAT JSON` if not already specified
- Returns ClickHouse's JSON response directly

## Config

```env
CLICKHOUSE_URL=http://localhost:8123    # ClickHouse HTTP interface
CLICKHOUSE_DATABASE=default             # Target database
CLICKHOUSE_USER=default                 # Wrangler var
CLICKHOUSE_PASSWORD=mypassword          # Wrangler secret (set via `wrangler secret put`)
```

## Setup for self-hosted ClickHouse

1. Run `clickhouse.sql` against your ClickHouse server to create tables
2. Deploy this adapter (Cloudflare Worker or Node.js)
3. Set secrets: `wrangler secret put CLICKHOUSE_PASSWORD`
4. Configure otel-collector:
   ```env
   TINYBIRD_ENDPOINT=https://your-adapter-url.com
   ```
