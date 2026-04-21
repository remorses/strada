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

### docs

- [Tinybird pricing breakdown](./docs/tinybird-pricing.md) — how Tinybird pricing works, cost estimates for OTel workloads, retention strategies, TTL auto-deletion
