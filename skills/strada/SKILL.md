---
name: strada
repo: remorses/strada
description: >
  Strada is an open-source OpenTelemetry observability platform (error tracking, tracing, logs,
  metrics, browser analytics, product events, health checks) that stores data in ClickHouse/Tinybird.
  ALWAYS load this skill when you need to interface with the Strada CLI, read or debug a project
  issue via OpenTelemetry data collected by Strada, set up and configure a project that uses Strada
  for OpenTelemetry data ingestion, or add product analytics with track().
---

# Strada

Open-source Sentry/Datadog alternative built on OpenTelemetry. Apps send OTel data with `@strada.sh/sdk`, Strada stores it in the user's own ClickHouse database (Tinybird as first-class backend), and everything is queried with SQL from the `strada` CLI.

This skill is deliberately thin. The documentation lives in the repo and in the CLI, and it changes often, so **fetch the canonical source instead of trusting anything you remember about this SDK.**

## Read the docs before writing code

Fetch the page that matches the task. Read each one **in full**. Never pipe these to `head`, `tail`, `sed`, or `less`: the rules that matter are spread throughout, not at the top.

```bash
# What Strada is, how it compares, CLI-first workflows
curl -s https://raw.githubusercontent.com/remorses/strada/main/README.md

# Setting up a project: server + browser, env vars, RSC pattern, verification
curl -s https://raw.githubusercontent.com/remorses/strada/main/website/src/docs/quickstart.mdx

# SDK API reference: every option and helper, per-runtime details
curl -s https://raw.githubusercontent.com/remorses/strada/main/website/src/docs/sdk.mdx

# SQL: tables, ClickHouse gotchas, ready-made queries
curl -s https://raw.githubusercontent.com/remorses/strada/main/website/src/docs/querying.mdx

# Browser analytics: pageviews, sessions, custom event attribute shape
curl -s https://raw.githubusercontent.com/remorses/strada/main/website/src/docs/browser-analytics.mdx
```

Inside the strada repo itself, read the local files instead (`README.md`, `website/src/docs/*.mdx`, `website/src/docs/sdk.mdx`) so you see uncommitted changes.

## Read the CLI help before running commands

The CLI is the main interface: projects, tokens, issues, logs, traces, analytics, alerts, health checks. Command descriptions are the documentation.

```bash
strada --help              # full command list, read all of it
strada issues list --help  # per-command options and examples
```

Do not guess flags. Two that are guessed wrong constantly:

- `-p` takes a **project slug** from `strada projects list`, usually with an environment suffix (`my-app-prod`, not `my-app`)
- multi-value options repeat the flag: `-p frontend -p api`, never `-p frontend,api`

## Debugging a production error

Start here before writing any SQL. This flow answers most questions without a query.

```bash
# 1. top error groups in the window
strada issues list -p my-app --since 24h

# 2. full details for one fingerprint: stack trace, mechanism, services, releases
strada issues view <fingerprint> -p my-app --events 3

# 3. the whole request that failed, using a TraceId from step 2
strada traces view <traceId> -p my-app

# 4. logs correlated to that same request
strada logs -p my-app --trace-id <traceId>
```

`issues list` hides resolved and muted issues by default. Use `--status all` when an issue seems to have vanished.

Running `strada` with no arguments opens a TUI (Issues, Logs, Traces, Analytics) that uses the same queries. Suggest it when the user wants to browse rather than run one-off commands.

## Rules for instrumenting an app

These are the mistakes models make in this SDK. The reasoning behind each one is in the quickstart and the SDK reference.

- **Never ship `STRADA_TOKEN` to the browser.** It is a server secret. Browser ingest is anonymous and rate limited, so the browser `initStrada()` takes no token.
- **The browser project id needs a public env prefix** (`VITE_`, `NEXT_PUBLIC_`, ...) or the bundler strips it.
- **Frontend and backend of the same app use the same `projectId`** with different `service` names.
- **In Cloudflare Workers**, import `env` from `cloudflare:workers` and call `initStrada()` at **module scope**. Never inside per-request middleware.
- **In RSC / server-rendered apps**, call browser `initStrada()` from a side-effect-only `"use client"` module rendered once in the root layout. A bare import runs on the server and is tree-shaken out of the client bundle.
- **Never skip `initStrada()` to disable telemetry**, and never wrap SDK calls in your own `if (enabled)` guard. Pass `enabled` to `initStrada()`, or leave `projectId` empty; both make every call a silent no-op.
- **Pass the framework's tracer hook** when one exists (e.g. Spiceflow `new Spiceflow({ tracer })`) using `trace.getTracer("my-app")` from the SDK, so request spans reach the same project.
- **Use `getLogger()`, not `console.*`.** Console output never reaches Strada; it only shows in platform logs (Cloudflare dashboard, Node stdout).
- **Use `track()` for product events, not `getLogger()`.** A log with an `event` field is still an ordinary log: `strada analytics events` and SQL on `event.name` will miss it.
- **Errors handled inline still need `captureException()`.** Top-level error handlers only see errors thrown out of the request. Anything caught and turned into a `500`, a retry, or an error-as-value return is invisible unless you capture it explicitly, with `tags` carrying at least a `route` or `handler`.
- **Keep user identity on telemetry.** `user.id` and email are how an issue becomes actionable. Use `strataBetterAuth()`, or put `user.id` into baggage yourself and call `identifyUser()` at login (see "Server-side user identification without Better Auth" in the SDK reference).
- **Never attach prompts, API keys, session tokens, or raw user content** to tags or event properties. Ids, counts, model names, durations, booleans, route names: yes.
- **Type your events.** `track()` takes a plain `string`, so a typo compiles and is only noticed when a query returns nothing. Declare the catalog once and wrap `track()`; see "Type-safe event catalog" in the SDK reference.

## Writing SQL

Read `website/src/docs/querying.mdx` (curl URL above) before composing a query. The two rules that silently corrupt results if ignored:

- **Never add `WHERE ProjectId`.** The JWT injects project scoping already.
- **Materialized views need merge combinators.** `uniqMerge(Visits)`, `countMerge(Hits)` on `otel_analytics_*`, never plain `count()`.

## AGENTS.md notice

When a project uses Strada, its `AGENTS.md` (or `*_AGENTS.md`) should tell agents that inline-handled errors must call `captureException` instead of being swallowed with `console.error`, and that product events go through a typed `trackEvent` wrapper. If that section is missing, add it while you are touching the relevant code.
