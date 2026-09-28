---
'@strada.sh/sdk': patch
---

Fix bugs in the zero-dependency SDK:

- **Metrics**: `shutdown()` then `initStrada()` no longer exports the old cumulative values again. Instruments also stop collecting while the SDK is not exporting.
- **Trace context**: the W3C `tracestate` header is now read, sent to downstream requests, and stored on spans. Spans now export their trace `flags`, so `TraceFlags` in `otel_traces` is no longer always `0`.
- **traceparent**: a version `00` header with extra fields after the flags is now rejected, as the W3C spec requires.
- **Browser**: when a hidden tab is visible again, the SDK starts a `pageview.resume` span. Events and errors after a tab switch join a page trace again. It is not a `pageview`, so page analytics do not count a tab switch as a hit.
- **Browser**: the 64 KiB `keepalive` limit is now checked in bytes, not characters. Batches with many non-ASCII characters are no longer lost when the page closes.
- **Node**: `shutdown()` removes the `uncaughtException`, `unhandledRejection`, and `beforeExit` handlers. A later `initStrada()` can enable or disable `captureUncaughtErrors` again.
- `registerOpenTelemetry()` never throws. If a registration step throws, the SDK rolls back and returns the error.
- New exports: `createTraceState()` and the `TraceState` type, the same as in `@opentelemetry/api`.
- **Cloudflare Workers**: each invocation exports its own records. A flush no longer waits for another request's export, and the SDK starts no timers in Workers. Workers bind I/O to the request that created it, so a shared export chain could delay or lose telemetry.
- **Cloudflare Workers**: metrics are exported with the invocation that recorded them, and only series that changed are sent. Before, a timer with no owner request sent them, and every log or span flush sent all metrics again.
