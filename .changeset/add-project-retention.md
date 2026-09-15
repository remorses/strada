---
'strada': minor
'strada-website': minor
---

Add optional per-project Tinybird retention for raw traces, logs, errors, and metrics.

```sh
strada projects retention -p api
strada projects retention update -p api --traces-days 7 --logs-days 14
strada projects retention update -p staging --all-days 7
strada projects retention update --traces-days -1
```

Raw telemetry is kept by default. A custom day count applies only to that project. Tinybird applies those rules with conditional `ENGINE_TTL`. Browser analytics and health-check aggregates stay at 90 days.
