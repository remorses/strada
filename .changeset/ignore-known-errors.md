---
'@strada.sh/sdk': patch
'otel-collector': patch
---

Ignore expected errors created by a `KnownError` class. The SDK no longer
captures them, and the collector does not turn their OpenTelemetry span events
or log records into Strada issues.
