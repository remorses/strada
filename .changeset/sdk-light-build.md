---
'@strada.sh/sdk': minor
---

Add `@strada.sh/sdk/light`, which re-exports the new zero-dependency `@strada.sh/light` package: an explicit-only subset of the SDK with no OpenTelemetry.

Switch by changing the import path. Same names, same options, same rows in `otel_logs` and `otel_traces`. Unsupported exports and options fail to compile.

```ts
import { initStrada, track, captureException, getLogger, startSpan, flush } from '@strada.sh/light' // or '@strada.sh/sdk/light'

initStrada({ projectId: '01JTHG5M7XPQR8KNCZ0W4D', service: 'my-cli', version: '1.0.0' })
track('command_run', { command: 'deploy' })
await startSpan({ name: 'deploy' }, async () => {
  getLogger('deploy').info({ message: 'uploaded', files: 12 })
})
await flush()
```

Includes `track`, `identifyUser`, `trackPageview`, `captureException` (with `ignoreErrors`, `denyUrls`, `beforeSend`, `setTags`), `getLogger`, `startSpan`, `startInactiveSpan`, `flush`, and `shutdown`. Nothing is captured automatically and nothing global is installed, so hostname and OS username are never sent.
