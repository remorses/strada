/**
 * `@strada.sh/instrumentation/register`: preload for auto-instrumentation.
 *
 *   node --import @strada.sh/instrumentation/register server.js
 *
 * Instrumentations patch modules when they load: `require-in-the-middle` for
 * CommonJS, `import-in-the-middle` loader hooks for ESM. Node loads and links
 * the whole static import graph before any app code runs, so registering
 * from app code (even the first import) leaves `http`, `pg`, `express`
 * unpatched. `--import` runs this module before the app graph loads.
 *
 * Runs once per process: ESM loader hook, `registerOpenTelemetry()`, then the
 * curated `getInstrumentations()`. It does not call `initStrada()`; the app
 * keeps its own init. Spans before that init are dropped (startup only).
 *
 * Use `--import`, not `-r`. Importing it from app code as well is safe (same
 * module instance, runs once) and makes file tracers such as nft copy it into
 * standalone builds.
 */

import { register } from "node:module";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { getInstrumentations, registerOpenTelemetry } from "./index.ts";

const REGISTERED = Symbol.for("strada.instrumentation.register");
const globals = globalThis as Record<symbol, boolean | undefined>;

if (!globals[REGISTERED]) {
  globals[REGISTERED] = true;
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const error = registerOpenTelemetry();
  if (error) {
    console.warn(`[@strada.sh/instrumentation] ${error.message} Auto-instrumentation is off.`);
  } else {
    registerInstrumentations({ instrumentations: getInstrumentations() });
  }
}
