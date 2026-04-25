# Changelog

## 0.1.0

1. **New `issues list` command** (renamed from `errors list`) — browse error groups from your project, sorted by frequency:

   ```bash
   strada issues list -p my-app
   strada issues list -p my-app --since 24h --unhandled
   strada issues list -p my-app -p api --service frontend --limit 50
   ```

   Shows count, unhandled status, level, exception type, message, and last-seen time. Supports comma-separated project slugs to query multiple projects at once.

2. **New `issues view` command** (renamed from `errors view`) — detailed view of a single error group with full stacktrace:

   ```bash
   strada issues view <fingerprint> -p my-app
   strada issues view <fingerprint> -p my-app --json
   ```

   Displays summary (type, message, event count, first/last seen, mechanism, services, releases, environments), structured stacktrace with in-app frame highlighting, and a recent events table.

3. **New `query` command** — run ad-hoc SQL against your project's database:

   ```bash
   strada query "SELECT * FROM otel_errors LIMIT 10" -p my-app
   strada query "SELECT ServiceName, count() FROM otel_traces GROUP BY ServiceName" -p my-app
   ```

4. **New `selfhost` command** — set up Strada on your own Tinybird workspace:

   ```bash
   # Interactive (opens browser for Tinybird auth)
   strada selfhost

   # Non-interactive with existing token
   strada selfhost --token p.eyXXX --base-url https://api.tinybird.co
   ```

   Authenticates with Tinybird, deploys OTel datasources and materialized views, then saves the tokens to your Strada database. Warns if deploying to a non-empty workspace.

5. **New `login`, `logout`, `whoami` commands** — authenticate via browser device flow:

   ```bash
   strada login         # opens browser, saves session token
   strada whoami        # shows current user and server
   strada logout        # removes stored credentials
   ```

6. **`--since` duration flag** — filter by human-readable time ranges:

   ```bash
   strada issues list -p my-app --since 1h
   strada issues list -p my-app --since 7d
   ```

   Supports `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks).

7. **Project slug caching** — project lookups are cached locally in `~/.strada/config.json`. After the first API call, subsequent commands resolve project slugs instantly without network requests. Cache is refreshed automatically on miss.

8. **Typed API client** — the CLI uses spiceflow's typed fetch client with compile-time route validation. Errors are returned as values (`Error | Data`), never thrown.

