<div align='center'>
    <br/>
    <br/>
    <h3>strada</h3>
    <p>Sentry + DataDog simple alternative for agents, based on OTEL. Self hosted with one command on TinyBird</p>
    <br/>
    <br/>
</div>

### use cases

- be alerted of downtime. spawn agents to create a pr to auto fix. for example let agents running `strada incidents watch` in the background. agents will be alerted of an incident right away. spawn a PR and you can fix issues by clicking a button.
- be notified of errors: list errors, show histograms, group errors by fingerprint, show together with logs, custom events, user analytics
- use strad sdk to build a status page based on your real data.
- give strada cli to your agents to monitor issues, traces, logs, debug issues. via raw SQL and pre built convenience commands.
- give your codex/claude code data sources to resolve bugs.
- website analytics? it's just client side otel collection.
- monitor funnels via custom graphs. monitor funnel success rate. never lose a payment because of a bug

### why strada instead of sentry, datadog, grafana, etc

- own your data. on your own clickhouse database.
- more powerful: your agents can run SQL directly. no clunky middle layer or custom SQL dialect no one knows. just clickhouse.
- built on top of opentelemetry standard. no vendor lock in.
- self hostable. super easy to manage via tinybird or your own clickhouse
- agent first. terminal first. your agents will keep your infrastructure running. fix issues and open PR automatically.
- hyper customizable: generative UI let you generate only what you need. just ask your agent what you want to see. no more intricate system of toggles, selects, options everywhere.
- delightful user interface
- real time: strada is built on top of clickhouse with optimized schema and tables for instant graphs and data visualization.

### why tinybird

Strada uses [Tinybird](https://www.tinybird.co) as its default storage backend. Tinybird is managed ClickHouse with a great developer experience on top.

- **Self-hostable in one command.** `strada selfhost` sets up your Tinybird workspace, deploys all datasources and materialized views. No infra to manage, no ClickHouse cluster to babysit.
- **Also runs on plain ClickHouse.** If you don't want Tinybird, point Strada at any ClickHouse instance. Same schema, same queries. No lock-in.
- **Fast queries.** ClickHouse is columnar and designed for analytical workloads. Querying millions of spans or logs takes milliseconds, not seconds.
- **Just SQL.** No custom query language, no proprietary DSL. Standard ClickHouse SQL. Your agents can query data directly with `SELECT`. 
- **Built-in multi-tenancy.** Tinybird's JWT row-level filtering lets us isolate tenants without any application-level query rewriting. Each customer gets a scoped token that filters automatically.
- **Storage is cheap.** $0.058/GB/month with ZSTD compression. Orders of magnitude cheaper than Datadog or Sentry for the same volume. Auto-delete old data with per-table TTL.
- **No idle compute cost.** You only pay for active vCPU minutes (actual queries and ingestion). When nobody is using the system, only the base plan fee and storage are charged.

See the [Tinybird pricing breakdown](./docs/tinybird-pricing.md) for detailed cost estimates, retention strategies, and Datadog comparison.

### docs

- [Tinybird pricing breakdown](./docs/tinybird-pricing.md) — cost estimates for OTel workloads, retention strategies, TTL auto-deletion

### sourcemaps

Strada does **not support sourcemap upload or symbolication** right now.

Instead, prefer configuring your frontend build to **preserve function and class names** in production bundles. For many apps this gets you most of the practical debugging value with much less operational complexity.

With the latest rolldown-based Vite, use `keepNames`:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        keepNames: true,
      },
    },
  },
})
```

This preserves the `name` property of **functions and classes** after bundling. Stack traces, error grouping, and manual debugging become much easier because production frames still contain useful symbols.

In practice, the **gzipped size increase is usually small**. Keeping names does increase raw bundle size, but compression already removes most of the repeated string cost. For typical applications the compressed delta is small enough that it is often not noticeable in real-world page loads.

This tradeoff is often worth it for error tracking:

- **simpler builds**. no sourcemap upload step
- **no build-time auth tokens** for sourcemap publishing
- **fewer moving parts** across CI, CDN, and release pipelines
- **more reliable debugging** because the shipped bundle already contains useful names

Technically, identifier mangling and gzip/brotli both reduce transfer size, but they operate differently. Mangling shortens local symbols before compression. Compression then exploits repeated substrings across the full output. Once transfer compression is already enabled, the incremental win from aggressively renaming human-meaningful function and class names is often much smaller than the raw bundle diff suggests, while the debugging cost is immediate.

Sourcemap-based workflows can still make sense for some teams, but they also depend on exact artifact upload, release matching, token management, CDN behavior, and browser/runtime stack trace quirks. In practice, when any of those pieces drift, symbolication quality drops quickly. Preserving names in the shipped bundle is a much more direct and robust baseline.
