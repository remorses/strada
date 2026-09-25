/**
 * `@strada.sh/sdk/register`: preload for OpenTelemetry auto-instrumentation.
 *
 *   node --import @strada.sh/sdk/register server.js
 *
 * Forwards to `@strada.sh/instrumentation/register`, which owns every OTel
 * dependency so the SDK stays dependency-free. When that package is not
 * installed, it prints one warning and the app runs without
 * auto-instrumentation. See its source for why a preload is required.
 */

import { warnOnce } from "./shared.ts";

try {
  await import("@strada.sh/instrumentation/register");
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const missing = message.includes("'@strada.sh/instrumentation'");
  warnOnce(
    missing
      ? "[@strada.sh/sdk] auto-instrumentation is off: install @strada.sh/instrumentation (npm install @strada.sh/instrumentation)"
      : `[@strada.sh/sdk] auto-instrumentation failed to start: ${message}`,
  );
}
