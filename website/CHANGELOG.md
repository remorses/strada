# Changelog

## 0.3.0

1. **Raw telemetry is kept by default** — traces, logs, errors, and metrics no longer expire at 14 / 30 / 90 days. Set a custom TTL from the CLI or the project retention API. Pass `-1` (CLI) or `null` (API) to keep a signal forever. Analytics and health checks stay at 90 days. After this website deploy, run `strada database upgrade` so Tinybird drops the old default TTLs.

2. **SDK docs live at `/docs/sdk`** — `/sdk/README` redirects to the new slug. GitHub and in-site links now point at `website/src/docs/sdk.mdx`.

## 0.2.0

1. **Unique visitors and first-visit analytics** — browser traffic uses cookie `strada_vid` (`visitor.id`). Login and logout do not touch it. Docs and CLI cover `strada analytics overview`, `timeseries`, and `visitors`. First visits come from the pages MV `FirstVisits` column. Existing analytics rows are not backfilled.

2. **MCP docs** — the same `strada` binary is a stdio MCP server. Docs cover `strada mcp`, install-mcp one-liners for Cursor, Claude Desktop, and VS Code, and a manual Cursor `mcp.json`.

3. **Per-project Tinybird retention** — set traces, logs, errors, and metrics retention from the CLI and the project API. Defaults are 14 / 30 / 90 / 90 days. Analytics and health checks stay at 90 days.

4. **`strada database upgrade` waits for an in-progress Tinybird deploy** — a 400 that means "already a deployment in progress" is no longer treated as a hard failure.

## 0.1.0

1. **Landing hero and docs refresh** — homepage uses **Syne** for heading and body type. The hero CTA is **Sign up with Google**. `/signup` redirects to `/login`. `/pricing` redirects to Tinybird pricing.

2. **Health checks and rewritten alerts** — URL health checks run as a Cloudflare Workflow. Error alerts support multiple named rules per org with project-scoped overrides. Destinations are org-scoped and shared with health checks.

3. **CLI docs tab** — generated pages for every `strada` command, plus alerts and health-checks guides.

4. **AI bot detection in analytics** — `BotName` on the analytics materialized views (`ChatGPT`, `Claude`, `Perplexity`, `Gemini`, `Copilot`, `Meta`, `other-bot`, or empty for humans).

5. **CLI sessions last one year** — Better Auth device-flow sessions expire after 365 days and refresh at most once per day.

6. **Device flow and query reliability** — device-flow poll reads the response body once. Drizzle D1 batch `findFirst` no longer crashes. Tinybird schema upgrades can wait for slow data migrations and apply destructive datasource cleanup.
