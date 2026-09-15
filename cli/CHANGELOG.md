# Changelog

## 0.7.0

1. **Unique visitors and first-visit analytics** — browser traffic now uses cookie `strada_vid` (`visitor.id`). Login and logout do not touch it. `strada_uid` stays the signed-in account. New commands for a daily traffic check without SQL:

   ```bash
   strada analytics overview -p my-app --since 7d
   strada analytics timeseries -p my-app --since 30d
   strada analytics visitors -p my-app --since 7d
   ```

   `overview` prints unique visitors, first visits, pageviews, sessions, bounce rate, top pages, and top referrers. Unique visitors in the pages MV use `visitor.id`, with `session.id` as fallback for old data. First visits come from the `FirstVisits` column. Existing analytics rows are not backfilled.

2. **`strada mcp`** — the same CLI binary is now a stdio MCP server. Cursor, Claude Desktop, and VS Code can spawn it and call supported non-interactive commands as tools (`issues_list`, `logs`, `query`):

   ```bash
   strada login
   npx @playwriter/install-mcp 'strada mcp' --client cursor
   ```

   `login`, `logout`, `database create`, `database upgrade`, `projects retention update`, `mcp`, and the TUI are not MCP tools. Run those in a terminal.

3. **Per-project Tinybird retention** — set how long raw traces, logs, errors, and metrics stay in Tinybird:

   ```bash
   strada projects retention -p api
   strada projects retention update -p api --traces-days 7 --logs-days 14
   strada projects retention update -p staging --all-days 7
   ```

   New projects default to 14 days for traces, 30 days for logs and custom events, and 90 days for errors and metrics. Browser analytics and health-check aggregates stay at 90 days. Lowering a value can delete existing Tinybird rows after schema promotion.

4. **`strada database upgrade` waits for an in-progress Tinybird deploy** — a 400 that means "already a deployment in progress" is no longer treated as a hard failure. Upgrade now waits and retries until Tinybird finishes. Run `strada database upgrade` again if a previous attempt failed with `Deployment not found`.

## 0.6.0

1. **URL health checks** — monitor any HTTP endpoint on a cron schedule and get alerted when it fails. Checks run as a Cloudflare Workflow, one durable step per org, so a slow tenant does not block others:

   ```bash
   strada checks create --url https://api.example.com/health --name "API health"
   strada checks list
   strada checks disable <id>
   strada checks enable <id>
   strada checks delete <id>
   ```

   Defaults: GET, expect 200-299, check every 5 minutes (`*/5 * * * *`), alert after 2 consecutive failures, 60 minute cooldown. After 24 hours of continuous failure the check auto-disables so a dead URL does not fill ClickHouse. Recovery notifications fire automatically when the URL comes back.

   Results live in `otel_health_checks`. Failed checks store the response body (up to 16KB) and headers so you can see what the server returned:

   ```bash
   strada query "
     SELECT Timestamp, StatusCode, LatencyMs, ErrorMessage
     FROM otel_health_checks
     WHERE Success = 0
     ORDER BY Timestamp DESC
     LIMIT 20
   "
   ```

2. **Rewritten alerts and destinations** — multiple named error-alert rules per org, with project-scoped overrides. Destinations (email, webhook, Slack) are org-scoped and auto-link to every rule, including health checks:

   ```bash
   # Org-wide default
   strada alerts create --name "All errors" --channel email --to ops@example.com

   # Project override: only fire after 20 errors in 30 minutes
   strada alerts create --name "Frontend noise" --project frontend --threshold 20 --window 30

   strada alerts list
   strada alerts update <id> --threshold 5 --window 15
   strada alerts delete <id>
   strada alerts test
   strada destinations list
   strada destinations remove <id>
   ```

   `alerts add` / `alerts set` / `alerts remove` are gone. Use `create`, `update`, and `delete`.

3. **`--status` on `issues list`** — default is now **open only**. Pass `--status` to include other triage states:

   ```bash
   strada issues list -p my-app
   strada issues list -p my-app --status all
   strada issues list -p my-app --status resolved
   ```

   Valid values: `open`, `resolved`, `muted`, `ignored`, `all`.

4. **CLI docs site** — every command now has a generated Holocron page under the CLI tab, with usage, flags, and examples. Command descriptions use `.example()` so `--help` and the docs stay in sync.

5. **CLI sessions last one year** — device-flow tokens no longer expire after 7 days. Active sessions refresh at most once per day.

6. **TUI starts correctly** — Termcast is initialized before the cache module, so `strada` opens with the right `~/.termcast/compiled/strada` storage instead of creating a cache before Termcast is ready.

7. **`strada database upgrade` no longer deadlocks** on slow Tinybird data migrations. It waits for `data_ready` (up to 45 minutes), adopts in-flight deployments, and allows destructive schema changes so removed datasources can be cleaned up.

## 0.5.0

1. **Enriched issue detail view** -- issue detail now shows URL path, user ID, session ID, browser brands, and environment alongside the existing metadata. The events table displays URL path and user ID columns. A 30-day frequency bar chart renders below the metadata so you can see error trends at a glance.

2. **HTTP method and route in issues list** -- the issues list subtitle now shows `POST /api/users/:id` style labels combining `http.method` and `http.route` (or `url.path` as fallback). The full detail view also shows method, route, and URL path as separate metadata labels.

3. **30-day frequency chart in both list and detail** -- each issue shows a daily frequency bar graph for the last 30 days. In the list view, frequency data for all visible issues is batch-fetched in a single SQL query to avoid N+1 requests. Bar width adapts to terminal width.

4. **Copy stacktrace action** -- press the action key on any issue to copy the full stacktrace (prefixed with error type and message) to the clipboard. Available in both the issues list and the pushed detail view.

5. **URL path visible in issues list** -- the issues list subtitle shows the URL path inline (e.g. `error · /api/orders`) so you can see which endpoint errored without opening the detail view.

6. **Server-side `url.path` propagation into error rows** -- errors captured via `captureException()` in Node or Cloudflare Workers HTTP handlers now include `url.path`, `http.route`, and `http.method` in their tags. Errors from `span.recordException()` also inherit span-level attributes. This powers the new URL display in the TUI.

7. **Removed unhandled tag from issues list** -- the red dot icon color already communicates unhandled status; the redundant text tag is gone for a cleaner layout.

8. **Fixed bin.js entrypoint resolution under bun** -- the CLI re-spawn logic now resolves the `bin.js` path correctly when running under bun.

## 0.4.0

1. **Interactive TUI** -- run `strada` with no arguments to launch a Raycast-like terminal UI for browsing issues, logs, traces, and analytics. Built with termcast and zustand for state persistence across restarts:

   ```bash
   strada
   ```

   Four views switchable via navigation dropdown (Ctrl+P): issues (error groups with stacktrace detail), logs (severity-colored records), traces (span tree drill-down), and analytics (KPIs, top pages, browsers, countries, referrers, custom events). Service and time range filters apply globally across all views.

2. **AI-powered natural language search** -- type free-form queries in the TUI search bar and they are translated into ClickHouse SQL filters server-side via Workers AI:

   ```
   errors with "timeout" in the last hour
   traces slower than 500ms from the api service
   unhandled exceptions in production
   ```

   The AI filter generates structured SQL fragments (WHERE, HAVING, ORDER BY) with self-correcting retry on invalid output. Works across issues, logs, and traces views.

3. **Cursor-based pagination** -- all TUI views and CLI list commands use cursor-based pagination instead of OFFSET, so scrolling through large datasets stays fast regardless of depth.

4. **Trace duration coloring by standard deviation** -- span durations in the TUI traces view are colored relative to the trace's mean and standard deviation, making slow spans visually obvious without needing to read numbers.

5. **Alert rules scoped to projects** -- `strada alerts add` now accepts `--project` to scope alert rules to a specific project instead of org-wide:

   ```bash
   strada alerts add --channel email --to ops@example.com --project api
   ```

6. **Improved `projects create` output** -- shows the ingest endpoint, token, and SDK setup instructions immediately after project creation.

7. **Fixed stale closure in AI search** -- resolved a bug where AI search results could apply to the wrong query when typing fast.

8. **Fixed pagination with custom ORDER BY** -- queries with AI-generated custom sort orders now paginate correctly.

## 0.3.0

1. **New `traces` commands** -- inspect distributed traces from the terminal:

   ```bash
   # List recent traces with root span summary
   strada traces list -p my-app --since 1h

   # Render a trace as a parent-child span tree
   strada traces view <traceId> -p my-app

   # Expand specific spans inline with full attributes
   strada traces view <traceId> -p my-app --expand-span ab3f

   # Show a single span in full detail (attributes, events, links)
   strada traces span <traceId> <spanId> -p my-app
   ```

   The tree view shows short span IDs, compact attribute previews, event summaries, and `[ERROR]` badges on errored spans. Use `--expand-span` (repeatable) to expand specific spans inline by their short ID prefix.

2. **New `services list` command** -- discover active `service.name` values in a project:

   ```bash
   strada services list -p my-app --since 24h
   ```

   Queries both `otel_logs` and `otel_traces`, merges counts by ServiceName, and shows separate log/span error counts plus last seen time. Useful before filtering logs, issues, or SQL queries by service.

3. **New `tokens` commands** -- manage org-scoped ingest tokens:

   ```bash
   # Create a token for server-side SDK authentication
   strada tokens create my-server-token --scope ingest

   # List all tokens in the current org
   strada tokens list

   # Delete a token
   strada tokens delete <tokenId>
   ```

   Tokens authenticate server-side SDK writes to the collector across all projects in an org. The initial token is also printed during `strada projects create`.

4. **Directory-scoped project setup** -- run `strada setup` once per app folder to configure the default org and project:

   ```bash
   cd my-app/
   strada setup
   ```

   After setup, all commands (`logs`, `issues`, `traces`, `analytics`, `services`, `query`) use the configured project automatically without `--project`. Config is stored in `~/.strada/config.json` with closest-parent matching, so nested package directories inherit the parent's config.

## 0.2.0

1. **New `logs` command** -- browse and search OTel log records with colored output:

   ```bash
   strada logs -p my-app --since 1h
   strada logs -p my-app --level error --service api
   strada logs -p my-app --search "timeout" --json
   strada logs -p my-app -w "LogAttributes['user.id'] = 'user_123'"
   ```

   Renders compact colored lines (one log per line) by default, raw JSON with `--json`. Supports `--level` for minimum severity, `--search` for full-text body search, `--trace-id` for trace correlation, and `--where` (`-w`) for arbitrary SQL attribute filters.

2. **New `analytics` commands** -- browser pageview analytics from the CLI:

   ```bash
   strada analytics pages -p my-app --since 7d
   strada analytics browsers -p my-app
   strada analytics countries -p my-app
   strada analytics referrers -p my-app
   strada analytics kpis -p my-app --since 30d
   strada analytics events -p my-app
   strada analytics realtime -p my-app
   ```

   Subcommands: `pages`, `browsers`, `devices`, `countries`, `referrers`, `languages`, `kpis`, `events`, `realtime`. All query the pre-aggregated materialized views for fast results.

3. **New `alerts` commands** -- configure error alert rules and notification destinations:

   ```bash
   strada alerts add --channel email --to ops@example.com
   strada alerts add --channel webhook --url https://hooks.slack.com/...
   strada alerts set --threshold 10 --window 5m --cooldown 1h
   strada alerts list
   strada alerts test
   strada alerts remove <id>
   ```

   One alert rule per org with configurable threshold, window, and cooldown. The website cron checks errors every 5 minutes and sends notifications when thresholds are exceeded.

4. **Issue lifecycle management** -- resolve, mute, unresolve, and assign issues:

   ```bash
   strada issues resolve <fingerprint> -p my-app
   strada issues mute <fingerprint> -p my-app
   strada issues unresolve <fingerprint> -p my-app
   strada issues assign <fingerprint> -p my-app
   ```

   Issue state (status, assignee) is stored in ClickHouse via `ReplacingMergeTree` and joined with error aggregations in a single SQL query.

5. **New `orgs list` and `orgs switch` commands** -- manage multi-org access:

   ```bash
   strada orgs list
   strada orgs switch
   ```

   The current org is stored in `~/.strada/config.json`. All commands respect the selected org.

6. **Renamed `selfhost` to `database`** -- `strada database create` and `strada database upgrade` replace the old `selfhost` namespace. Adds `--force` flag to overwrite existing database config.

7. **`--until` time boundary** -- all time-filtered commands now accept `--until` in addition to `--since`. Both accept relative durations ("1h", "7d") or ISO dates ("2026-04-28T10:00:00Z").

8. **`--where` flag on `logs` and `analytics events`** -- pass arbitrary SQL conditions for attribute filtering without escaping into the main query.

## 0.1.0

1. **New `issues list` command** (renamed from `errors list`) -- browse error groups from your project, sorted by frequency:

   ```bash
   strada issues list -p my-app
   strada issues list -p my-app --since 24h --unhandled
   strada issues list -p my-app -p api --service frontend --limit 50
   ```

   Shows count, unhandled status, level, exception type, message, and last-seen time. Supports repeatable `-p` flags to query multiple projects at once.

2. **New `issues view` command** (renamed from `errors view`) -- detailed view of a single error group with full stacktrace:

   ```bash
   strada issues view <fingerprint> -p my-app
   strada issues view <fingerprint> -p my-app --json
   ```

   Displays summary (type, message, event count, first/last seen, mechanism, services, releases, environments), structured stacktrace with in-app frame highlighting, and a recent events table.

3. **New `query` command** -- run ad-hoc SQL against your project's database:

   ```bash
   strada query "SELECT * FROM otel_errors LIMIT 10" -p my-app
   strada query "SELECT ServiceName, count() FROM otel_traces GROUP BY ServiceName" -p my-app
   ```

4. **New `selfhost` command** -- set up Strada on your own Tinybird workspace:

   ```bash
   # Interactive (opens browser for Tinybird auth)
   strada selfhost

   # Non-interactive with existing token
   strada selfhost --token p.eyXXX --base-url https://api.tinybird.co
   ```

   Authenticates with Tinybird, deploys OTel datasources and materialized views, then saves the tokens to your Strada database. Warns if deploying to a non-empty workspace.

5. **New `login`, `logout`, `whoami` commands** -- authenticate via browser device flow:

   ```bash
   strada login         # opens browser, saves session token
   strada whoami        # shows current user and server
   strada logout        # removes stored credentials
   ```

6. **`--since` duration flag** -- filter by human-readable time ranges:

   ```bash
   strada issues list -p my-app --since 1h
   strada issues list -p my-app --since 7d
   ```

   Supports `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks).

7. **Project slug caching** -- project lookups are cached locally in `~/.strada/config.json`. After the first API call, subsequent commands resolve project slugs instantly without network requests. Cache is refreshed automatically on miss.

8. **Typed API client** -- the CLI uses spiceflow's typed fetch client with compile-time route validation. Errors are returned as values (`Error | Data`), never thrown.
