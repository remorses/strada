# Changelog

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
