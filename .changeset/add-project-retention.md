---
'strada': minor
'strada-website': minor
---

Add per-project Tinybird retention for raw traces, logs, errors, and metrics.

```sh
strada projects retention -p api
strada projects retention update -p api --traces-days 7 --logs-days 14
strada projects retention update -p staging --all-days 7
```

New projects default to 14 days for traces, 30 days for logs and custom events, and 90 days for errors and metrics. Tinybird applies changes to existing rows with conditional `ENGINE_TTL` rules. Browser analytics and health-check aggregates remain available for 90 days.
