# Health checks, status pages, and agent-triggered alerts

Open-source Checkly alternative built into Strada. Monitors URLs on a schedule, stores
results in ClickHouse alongside OTel data, fires alerts through the existing destination
system, and optionally triggers AI agents to investigate and fix issues.

## Schema foundation (done)

The D1 alert schema was widened in migration `0007_alert-schema-widen.sql`:

- **`alert_rule`** supports multiple rules per org with a `type` field (`error_threshold` | `health_check`).
  Error-specific fields are prefixed with `error_` (e.g. `error_threshold`, `error_window_minutes`).
  Health check fields will be prefixed with `check_` when added.
- **`alert_destination`** is org-scoped (not rule-scoped). Channel-specific fields are prefixed
  with their channel name (`agent_prompt`, `slack_channel`, `slack_mention`).
- **`alert_rule_destination`** junction table links rules to destinations many-to-many.
  One Slack webhook can fire for both error alerts and health check failures.

## Health check rule fields to add

When building the health check feature, add these columns to `alert_rule`:

```
check_url                    text     -- the URL to fetch
check_interval_minutes       integer  -- default 5 or 10
check_expected_status_min    integer  -- default 200
check_expected_status_max    integer  -- default 299 (any 2xx)
check_max_latency_ms         integer  -- nullable (no limit if null)
check_failure_threshold      integer  -- default 2 (consecutive failures before alerting)
check_regions                text     -- comma-separated: "us-east,eu-west,ap-southeast"
```

The existing `cooldown_minutes` and `last_alerted_at` fields handle alert dedup for health checks.
No separate incident table needed.

## ClickHouse table: otel_health_checks

Every check result (success and failure) goes to ClickHouse. This is time-series data,
not control plane state.

```sql
CREATE TABLE otel_health_checks
(
    ProjectId        LowCardinality(String),
    Url              String,
    Region           LowCardinality(String),
    StatusCode       UInt16,
    LatencyMs        UInt32,
    Success          UInt8,
    ErrorMessage     String,
    Timestamp        DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (ProjectId, Url, Region, Timestamp)
TTL toDate(Timestamp) + INTERVAL 90 DAY
```

No `RuleId`. The check result is about a URL from a region at a time. If a rule
is deleted and recreated for the same URL, historical data remains queryable. Join
on URL if you need to correlate back to a rule.

## Alert dedup for health checks

```
Cron fires (every 5 min)
  │
  ▼
For each health_check rule:
  │
  ├── Fetch URL, measure latency
  ├── Write result to otel_health_checks (ClickHouse)
  ├── Query last N results: SELECT Success FROM otel_health_checks
  │   WHERE Url = '...' ORDER BY Timestamp DESC LIMIT check_failure_threshold
  │
  ├── All N failed?
  │   ├── No  ► done
  │   └── Yes ► check alert_rule.last_alerted_at
  │            ├── Within cooldown ► skip
  │            └── Past cooldown ► send alert, update last_alerted_at in D1
```

No separate incident state table. Consecutive failure detection is derived from ClickHouse
at query time. Alert dedup uses `last_alerted_at` on the rule itself.

## Agent-triggered alerts

Destinations with `channel = 'agent'` have an `agent_prompt` field containing a template.
When an alert fires, the system renders the template with context variables and sends it
to the agent platform.

**Error alert variables:**
- `{{exception_type}}`, `{{exception_message}}`, `{{fingerprint}}`
- `{{project}}`, `{{service}}`, `{{stacktrace}}`
- `{{error_count}}`, `{{window_minutes}}`

**Health check alert variables:**
- `{{url}}`, `{{status_code}}`, `{{latency_ms}}`
- `{{region}}`, `{{failure_count}}`, `{{error_message}}`

**Example prompts:**
- "Debug the {{exception_type}} in {{project}}: {{exception_message}}. Use strada CLI to investigate and open a PR to fix it."
- "The status page check for {{url}} failed {{failure_count}} times. Status {{status_code}}, latency {{latency_ms}}ms from {{region}}. Investigate and open a PR."
- "@codex investigate the incident on {{url}}. Check logs with `strada logs -p {{project}} --since 30m`. If it's a code issue, fix it."

The agent destination could post to a Slack channel mentioning an AI agent, or call a
webhook that triggers a CI pipeline, or invoke a Kimaki session.

## Slack integration

Destinations with `channel = 'slack'` use a Slack incoming webhook URL as `destination`.
Additional fields:
- `slack_channel` for display/routing (the webhook already targets a channel)
- `slack_mention` for @-mentioning users or bots in the message

Future: Slack OAuth app for richer integration (threads, reactions, interactive buttons).
For v1, incoming webhooks are sufficient.

## Status page

Health check data in ClickHouse powers public status pages and embeddable widgets.

**Queries for status page components:**

```sql
-- Availability percentage (last 30 days)
SELECT
    countIf(Success = 1) * 100.0 / count() AS availability_pct
FROM otel_health_checks
WHERE Url = 'https://api.example.com/health'
AND Timestamp >= now() - INTERVAL 30 DAY
LIMIT 1

-- Daily success bar chart
SELECT
    toDate(Timestamp) AS day,
    countIf(Success = 1) AS ok,
    countIf(Success = 0) AS fail
FROM otel_health_checks
WHERE Url = 'https://api.example.com/health'
AND Timestamp >= now() - INTERVAL 90 DAY
GROUP BY day
ORDER BY day
LIMIT 90

-- Latency by region
SELECT
    Region,
    quantile(0.5)(LatencyMs) AS p50,
    quantile(0.95)(LatencyMs) AS p95,
    quantile(0.99)(LatencyMs) AS p99
FROM otel_health_checks
WHERE Url = 'https://api.example.com/health'
AND Timestamp >= now() - INTERVAL 24 HOUR
GROUP BY Region
LIMIT 20

-- Recent failures
SELECT Timestamp, Region, StatusCode, LatencyMs, ErrorMessage
FROM otel_health_checks
WHERE Url = 'https://api.example.com/health'
AND Success = 0
ORDER BY Timestamp DESC
LIMIT 20
```

**React widget** for embedding in footers:

```tsx
import { StradaStatusWidget } from '@strada.sh/ui'

// Embeddable component showing current status + availability
<StradaStatusWidget
  projectId="01KPVGTT9CJW4ZNEF414VHGRFD"
  checks={['https://api.example.com/health', 'https://example.com']}
/>
```

## Regional checks

Health checks should run from multiple Cloudflare edge locations for global latency data.
Options:
1. **Cloudflare Workers in multiple regions** (via custom domains or regional services)
2. **Cron trigger with `ctx.waitUntil` spawning fetch from different PoPs** (limited, CF picks the PoP)
3. **Smart placement disabled** + deploy multiple workers named by region

For v1, a single worker location is fine. Multi-region is a v2 feature.

## CLI commands

```bash
# Manage health checks
strada checks create --url https://api.example.com/health --name "API health"
strada checks list
strada checks delete <id>

# View results
strada checks status                      # current status of all checks
strada checks history --url https://...   # recent results
strada checks availability --url https://... --since 30d

# Wire destinations to a health check rule
strada alerts add --channel email --to ops@example.com --rule <rule-id>
strada alerts add --channel agent --to https://agent.endpoint \
  --agent-prompt "Investigate {{url}} failure from {{region}}"
```

## Implementation order

1. Add `check_*` columns to `alert_rule` schema + migration
2. Create `otel_health_checks` Tinybird datasource
3. Build `checkHealthChecks()` cron handler (fetch URLs, write results, alert)
4. Add `strada checks` CLI commands
5. Build status page query endpoints on the website API
6. Build React status widget in `@strada.sh/ui`
7. Add Slack notification support
8. Add agent-triggered alert support (template rendering + dispatch)
9. Multi-region checks
