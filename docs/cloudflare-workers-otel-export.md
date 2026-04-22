---
title: Cloudflare Workers OTel Export via Destinations
description: How Cloudflare Workers exports traces and logs to OTLP destinations, how uncaught errors show up, and what Strada needs to ingest them.
---

# Cloudflare Workers OTel export via destinations

Cloudflare Workers can export **OpenTelemetry traces and logs** to any **OTLP HTTP endpoint** configured as a destination in the Cloudflare dashboard.

For Strada, this is a very good fit because the current collector already exposes standard OTLP endpoints:

- `POST /v1/traces`
- `POST /v1/logs`

The main caveat is simple:

- **Cloudflare exports traces and logs, not metrics**
- **Strada currently accepts OTLP HTTP/JSON only**
- **Cloudflare docs clearly describe OTLP destinations, but do not document the exact exported log payload shape for uncaught exceptions**

## Short version

If a user configures these destinations:

- `https://<project>-ingest.strada.sh/v1/traces`
- `https://<project>-ingest.strada.sh/v1/logs`

then Strada should be able to ingest Cloudflare Workers telemetry without adding a new endpoint.

The most reliable error signal documented by Cloudflare is on **traces**, not logs:

- root spans include `cloudflare.outcome`
- uncaught exceptions set `cloudflare.outcome = "exception"`

That means Strada can detect Worker failures from traces even if the exported log schema for uncaught exceptions is not fully documented.

## How Cloudflare destinations work

Cloudflare has a built-in observability pipeline for Workers.

1. You create a **destination** in the Cloudflare dashboard.
2. The destination has:
   - a type, `Traces` or `Logs`
   - an OTLP endpoint URL
   - optional custom headers
3. You enable export in `wrangler.json`.
4. Cloudflare sends telemetry from the Worker runtime to the configured OTLP endpoint.

Example `wrangler.json`:

```json
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-22",
  "observability": {
    "traces": {
      "enabled": true,
      "destinations": ["strada-traces"]
    },
    "logs": {
      "enabled": true,
      "destinations": ["strada-logs"]
    }
  }
}
```

Example destination setup for Strada:

- **Traces destination**
  - type: `Traces`
  - endpoint: `https://acme-ingest.strada.sh/v1/traces`
- **Logs destination**
  - type: `Logs`
  - endpoint: `https://acme-ingest.strada.sh/v1/logs`

Because Strada uses the hostname to determine the project, no extra auth or routing layer is required for the basic flow.

## What Cloudflare exports

Cloudflare docs say Workers can export:

- **traces**
- **logs**

Cloudflare docs also explicitly say:

- **metrics export is not yet supported**

So today, only these Strada endpoints matter:

- `/v1/traces`
- `/v1/logs`

`/v1/metrics` is not used by Cloudflare's built-in destination export.

## What trace data Cloudflare sends

Cloudflare automatically instruments spans for:

- fetch handlers
- scheduled handlers
- queue handlers
- alarm handlers
- RPC handlers
- outbound `fetch()` calls
- binding calls like KV, R2, D1, Durable Objects
- Durable Object storage operations

Useful documented span attributes include:

- `cloud.provider = "cloudflare"`
- `cloud.platform = "cloudflare.workers"`
- `service.name`
- `faas.name`
- `faas.invocation_id`
- `cloudflare.handler_type`
- `cloudflare.entrypoint`
- `cloudflare.execution_model`
- `cloudflare.outcome`
- `cloudflare.cpu_time_ms`
- `cloudflare.wall_time_ms`
- `cloudflare.jsrpc.method`

This is already enough to make Strada's trace UI useful for Workers and Durable Objects.

## How Cloudflare sends uncaught errors

Cloudflare's docs make two things clear:

1. **Workers Logs includes errors and uncaught exceptions**
2. **trace root spans include `cloudflare.outcome`**, and one documented outcome is `exception`

The docs do **not** show a concrete OTLP log example for an uncaught exception payload. Because of that, the safest reading is:

- uncaught exceptions are visible in Cloudflare's own logs UI
- uncaught exceptions are exported as part of the logs pipeline
- traces also carry a durable error signal through `cloudflare.outcome = "exception"`

So for Strada, the best current detection strategy is:

### 1. Detect failures from traces

If a root Worker span has:

```txt
cloudflare.outcome = "exception"
```

then the invocation failed with an uncaught exception.

Other failure outcomes documented by Cloudflare include:

- `exceededCpu`
- `exceededMemory`

### 2. Ingest logs too, but treat exact uncaught-exception log fields as not yet locked down

Cloudflare docs promise that logs include uncaught exceptions, but they do not document the exported OTLP log schema in enough detail to know whether Cloudflare sets fields like:

- `exception.type`
- `exception.message`
- `exception.stacktrace`

Strada's current error extractor for logs relies on those fields.

So today:

- **trace-based failure detection is reliable**
- **log-based error extraction may work, but should be confirmed with a real sample payload**

## What Strada can detect right now

With no collector changes, Strada can already do all of this from Cloudflare traces:

- identify Worker invocations
- identify Durable Object invocations
- identify RPC method names via `cloudflare.jsrpc.method`
- identify failed requests via `cloudflare.outcome`
- identify CPU or memory limit failures
- inspect fetch, KV, R2, D1, and Durable Object sub-spans

The current collector is already compatible with the standard OTLP JSON trace envelope:

- `resourceSpans[].scopeSpans[].spans[]`

and the standard OTLP JSON log envelope:

- `resourceLogs[].scopeLogs[].logRecords[]`

## What Strada cannot fully guarantee yet

The missing piece is **issue extraction from uncaught exception logs**.

Strada currently extracts errors from logs only when log attributes contain:

- `exception.type`
- or `exception.message`

Cloudflare docs do not show whether destination-exported uncaught exception logs use those exact OTel keys.

So there are two possible cases:

### Case A. Cloudflare uses standard OTel exception fields

Then Strada's existing `extractErrorsFromLogs()` logic should work with no changes.

### Case B. Cloudflare uses Cloudflare-specific log metadata instead

Then Strada would still ingest the logs, but would need an extra extraction rule for Cloudflare log fields.

Until a real sample is captured, this is unknown.

## Recommended Strada support level

The practical support story can be:

### Supported now

- ingest Cloudflare Workers traces
- ingest Cloudflare Workers logs
- show invocation failures from `cloudflare.outcome`
- support Workers, Durable Objects, RPC, KV, R2, D1 trace exploration

### Needs one real sample to finish

- issue extraction from Cloudflare uncaught exception logs
- stack trace parsing for exported uncaught exception logs

## Example queries for Strada

### Failed Worker invocations

```sql
SELECT
  Timestamp,
  ServiceName,
  SpanName,
  SpanAttributes['cloudflare.outcome'] AS outcome,
  SpanAttributes['cloudflare.handler_type'] AS handler_type,
  SpanAttributes['cloudflare.entrypoint'] AS entrypoint
FROM otel_traces
WHERE ResourceAttributes['cloud.platform'] = 'cloudflare.workers'
  AND SpanAttributes['cloudflare.outcome'] != 'ok'
ORDER BY Timestamp DESC
LIMIT 100
```

### Uncaught exceptions only

```sql
SELECT
  Timestamp,
  ServiceName,
  SpanName,
  SpanAttributes['cloudflare.handler_type'] AS handler_type,
  SpanAttributes['cloudflare.entrypoint'] AS entrypoint
FROM otel_traces
WHERE ResourceAttributes['cloud.platform'] = 'cloudflare.workers'
  AND SpanAttributes['cloudflare.outcome'] = 'exception'
ORDER BY Timestamp DESC
LIMIT 100
```

### Durable Object RPC failures

```sql
SELECT
  Timestamp,
  ServiceName,
  SpanName,
  SpanAttributes['cloudflare.jsrpc.method'] AS rpc_method,
  SpanAttributes['cloudflare.entrypoint'] AS entrypoint,
  SpanAttributes['cloudflare.outcome'] AS outcome
FROM otel_traces
WHERE ResourceAttributes['cloud.platform'] = 'cloudflare.workers'
  AND SpanAttributes['cloudflare.jsrpc.method'] != ''
  AND SpanAttributes['cloudflare.outcome'] != 'ok'
ORDER BY Timestamp DESC
LIMIT 100
```

## Example `wrangler.json` configs

### Minimal export to Strada

```json
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-23",
  "observability": {
    "traces": {
      "enabled": true,
      "destinations": ["strada-traces"]
    },
    "logs": {
      "enabled": true,
      "destinations": ["strada-logs"]
    }
  }
}
```

### Export only traces

```json
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-23",
  "observability": {
    "traces": {
      "enabled": true,
      "destinations": ["strada-traces"],
      "persist": false
    }
  }
}
```

### Export traces and logs with sampling

```json
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-23",
  "observability": {
    "traces": {
      "enabled": true,
      "destinations": ["strada-traces"],
      "head_sampling_rate": 0.1,
      "persist": false
    },
    "logs": {
      "enabled": true,
      "destinations": ["strada-logs"],
      "head_sampling_rate": 0.1,
      "persist": false
    }
  }
}
```

## Do we need a new Strada endpoint?

No.

Cloudflare destinations already target standard OTLP paths, and Strada already exposes them.

Use:

- `https://<project>-ingest.strada.sh/v1/traces`
- `https://<project>-ingest.strada.sh/v1/logs`

The only future reason to add a new endpoint would be convenience, not protocol compatibility.

## What docs and examples exist today

Cloudflare docs already provide strong examples for:

- destination setup
- `wrangler.jsonc` or `wrangler.toml` config
- provider-specific OTLP endpoints like Sentry and Grafana Cloud
- trace attributes for Worker, RPC, Durable Object, KV, R2, and D1 spans
- filtering uncaught exceptions in Cloudflare's own logs UI

The best docs to read are:

1. **Exporting OpenTelemetry Data**  
   https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
2. **Traces**  
   https://developers.cloudflare.com/workers/observability/traces/
3. **Spans and attributes**  
   https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/
4. **Errors and exceptions**  
   https://developers.cloudflare.com/workers/observability/errors/
5. **Workers Logs**  
   https://developers.cloudflare.com/workers/observability/logs/workers-logs/
6. **Export to Sentry**  
   https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/sentry/
7. **Export to Grafana Cloud**  
   https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/grafana-cloud/

## Recommended next step

Before claiming full Cloudflare error tracking support, capture one real exported OTLP log payload for an uncaught exception and answer these questions:

1. Does Cloudflare export uncaught exceptions with `exception.type`?
2. Does it export `exception.message`?
3. Does it export a stack trace, and under which field?
4. Does the log carry the same trace ID as the root span with `cloudflare.outcome = "exception"`?

If the answer to the first two questions is yes, Strada's existing error extraction logic will probably work unchanged.

If not, add a small Cloudflare-specific extraction rule while keeping the same `/v1/logs` endpoint.
