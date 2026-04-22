/**
 * Cloudflare Workers runtime entry for @strada.sh/sdk.
 *
 * Uses BasicTracerProvider from sdk-trace-base (no Node/browser dependencies)
 * with AsyncLocalStorage for context propagation (requires nodejs_compat).
 *
 * Primary API: instrument() wraps an ExportedHandler with tracing.
 * Each request gets a root span, telemetry is flushed via ctx.waitUntil().
 *
 * Also exports initStrada() for manual setup without the instrument() wrapper,
 * and instrumentDO() for wrapping Durable Object classes.
 *
 * Env type comes from wrangler types (worker-configuration.d.ts), never define
 * custom Env interfaces. See the cloudflare-workers skill for conventions.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { logs } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";
import {
  context as otelContext,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import type { Context, ContextManager } from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

import {
  type BatchSpanProcessorBrowserConfig,
  type StradaOptions,
  type CaptureExceptionOptions,
  type StradaTelemetryOptions,
  type UserContext,
  applyBeforeSend,
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  setUser,
  setTags,
  resetContext,
  resolveEndpoint,
  ATTR,
  BAGGAGE_SESSION_ID,
  BAGGAGE_USER_ID,
  ERROR_SEVERITY,
  ERROR_SEVERITY_TEXT,
} from "./shared.ts";

// Re-export shared types, helpers, and OTel primitives so users only need one import
export {
  type StradaOptions,
  type CaptureExceptionOptions,
  type StradaTelemetryOptions,
  type UserContext,
  setUser,
  setTags,
  type BatchSpanProcessorBrowserConfig,
  type BatchLogRecordProcessorBrowserConfig,
  type PeriodicExportingMetricReaderOptions,
  // OTel API re-exports
  trace,
  context,
  metrics,
  propagation,
  diag,
  SpanStatusCode,
  SpanKind,
  SeverityNumber,
  logs,
  type Tracer,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanAttributes,
  type Logger,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Context manager for Workers (requires nodejs_compat)
// ---------------------------------------------------------------------------
// Workers support node:async_hooks AsyncLocalStorage via the nodejs_compat
// compatibility flag. This gives us proper context propagation so nested
// spans are linked correctly within a request.

class WorkerContextManager implements ContextManager {
  private storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    return this.storage.run(context, cb as never, ...args);
  }

  bind<T>(context: Context, target: T): T {
    if (typeof target === "function") {
      const manager = this;
      return ((...fnArgs: unknown[]) =>
        manager.with(context, () => (target as Function)(...fnArgs))) as T;
    }
    return target;
  }

  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Baggage-extracting span processor (same as node.ts)
// ---------------------------------------------------------------------------
// Reads session.id and user.id from incoming W3C Baggage (propagated by the
// browser SDK) and sets them as span attributes on every backend span.

class BaggageSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const baggage = propagation.getBaggage(otelContext.active());
    if (!baggage) return;

    const sessionId = baggage.getEntry(BAGGAGE_SESSION_ID)?.value;
    if (sessionId) span.setAttribute(ATTR["session.id"], sessionId);

    const userId = baggage.getEntry(BAGGAGE_USER_ID)?.value;
    if (userId) span.setAttribute(ATTR["user.id"], userId);
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Baggage-extracting log processor (same as node.ts)
// ---------------------------------------------------------------------------
// Wraps another LogRecordProcessor and injects session.id and user.id from
// incoming W3C Baggage into every log record.

class BaggageLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: LogRecordProcessor) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>): void {
    const record = args[0];
    const baggage = propagation.getBaggage(otelContext.active());
    if (baggage) {
      const sessionId = baggage.getEntry(BAGGAGE_SESSION_ID)?.value;
      if (sessionId) record.setAttribute(ATTR["session.id"], sessionId);

      const userId = baggage.getEntry(BAGGAGE_USER_ID)?.value;
      if (userId) record.setAttribute(ATTR["user.id"], userId);
    }

    this.inner.onEmit(...args);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _tracerProvider: BasicTracerProvider | undefined;
let _loggerProvider: LoggerProvider | undefined;
let _logger: Logger | undefined;
let _options: StradaOptions | undefined;
let _coldStart = true;


// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize Strada for Cloudflare Workers. Called automatically by
 * instrument() on the first request. Can also be called manually.
 *
 * Sets up:
 * - BasicTracerProvider with AsyncLocalStorage context manager
 * - BaggageSpanProcessor + BatchSpanProcessor (HTTP/JSON)
 * - LoggerProvider with BaggageLogProcessor + BatchLogRecordProcessor
 * - W3C TraceContext + Baggage propagation
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function initStrada(options: StradaOptions): void {
  if (_tracerProvider) return;
  _options = options;

  const resource = resourceFromAttributes({
    [ATTR["service.name"]]: options.service,
    ...(options.version
      ? { [ATTR["service.version"]]: options.version }
      : {}),
    ...(options.environment
      ? { [ATTR["deployment.environment.name"]]: options.environment }
      : {}),
    "cloud.provider": "cloudflare",
    "cloud.platform": "cloudflare.workers",
  });

  const endpoint = resolveEndpoint(options);

  // Logger provider for logs and error capture
  const logExporter = new OTLPLogExporter({
    url: `${endpoint}/v1/logs`,
  });
  _loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BaggageLogProcessor(new BatchLogRecordProcessor(logExporter)),
    ],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada");

  // Tracer provider with BaggageSpanProcessor for browser context extraction
  _tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BaggageSpanProcessor(),
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      ),
    ],
  });

  // Register globals manually (BasicTracerProvider has no register() method)
  trace.setGlobalTracerProvider(_tracerProvider);
  otelContext.setGlobalContextManager(new WorkerContextManager());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// instrument() — wrap an ExportedHandler with tracing
// ---------------------------------------------------------------------------
// The input object has a `strada` key for config plus standard handler methods
// (fetch, scheduled, queue, email, etc.). The return strips `strada` and
// returns a plain ExportedHandler-compatible object.
//
// Usage:
//   export default instrument({
//     strada: (env) => ({ projectId: env.STRADA_PROJECT_ID, service: "api" }),
//     fetch(request, env, ctx) { return new Response("ok") },
//   }) satisfies ExportedHandler<Env>

// Minimal type for ctx.waitUntil() so we don't need @cloudflare/workers-types
interface HasWaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

function resolveConfig(
  config: StradaOptions | ((env: any) => StradaOptions),
  env: unknown,
): StradaOptions {
  return typeof config === "function" ? config(env) : config;
}



export function instrument<H extends Record<string, any>>(
  input: H & { strada: StradaOptions | ((env: any) => StradaOptions) },
): Omit<H, "strada"> {
  const stradaConfig = input.strada;
  const result: Record<string, any> = {};

  for (const key of Object.keys(input)) {
    if (key === "strada") continue;
    const value = input[key];

    if (typeof value !== "function") {
      result[key] = value;
      continue;
    }

    if (key === "fetch") {
      result.fetch = createFetchHandler(value, stradaConfig);
    } else if (key === "scheduled") {
      result.scheduled = createScheduledHandler(value, stradaConfig);
    } else if (key === "queue") {
      result.queue = createQueueHandler(value, stradaConfig);
    } else {
      // email, tail, trace, test, etc.: just init strada and pass through
      result[key] = createPassthroughHandler(value, stradaConfig);
    }
  }

  return result as Omit<H, "strada">;
}

function createFetchHandler(
  original: Function,
  stradaConfig: StradaOptions | ((env: any) => StradaOptions),
) {
  return async (request: Request, env: unknown, ctx: HasWaitUntil) => {
    initStrada(resolveConfig(stradaConfig, env));

    const tracer = trace.getTracer("strada");

    // Extract trace context from incoming request headers (distributed tracing)
    const parentContext = propagation.extract(
      otelContext.active(),
      request.headers,
      {
        get(headers, key) {
          return headers.get(key) ?? undefined;
        },
        keys(headers) {
          return [...headers.keys()];
        },
      },
    );

    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // Extract Cloudflare-specific metadata from request.cf
    // Available on all plans: colo, country, asn, tlsVersion
    // Available on Business/Enterprise: city, region, continent
    const cf = (request as any).cf as Record<string, unknown> | undefined;
    const cfAttrs: Record<string, string | number | boolean> = {};
    if (cf) {
      if (cf.colo) cfAttrs["cf.colo"] = String(cf.colo);
      if (cf.country) cfAttrs["cf.country"] = String(cf.country);
      if (cf.asn) cfAttrs["cf.asn"] = Number(cf.asn);
      if (cf.tlsVersion) cfAttrs["cf.tls_version"] = String(cf.tlsVersion);
      if (cf.city) cfAttrs["cf.city"] = String(cf.city);
      if (cf.region) cfAttrs["cf.region"] = String(cf.region);
      if (cf.continent) cfAttrs["cf.continent"] = String(cf.continent);
      if (cf.httpProtocol) cfAttrs["network.protocol.version"] = String(cf.httpProtocol);
    }

    return tracer.startActiveSpan(
      `${method} ${url.pathname}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": method,
          "url.path": url.pathname,
          "url.query": url.search,
          "url.full": url.href,
          "server.address": url.host,
          "cold_start": _coldStart,
          ...cfAttrs,
        },
      },
      parentContext,
      async (span) => {
        _coldStart = false;
        try {
          const response: Response = await original(request, env, ctx);
          span.setAttribute("http.response.status_code", response.status);
          if (response.status >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          return response;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
          ctx.waitUntil(flush());
        }
      },
    );
  };
}

function createScheduledHandler(
  original: Function,
  stradaConfig: StradaOptions | ((env: any) => StradaOptions),
) {
  return async (controller: any, env: unknown, ctx: HasWaitUntil) => {
    initStrada(resolveConfig(stradaConfig, env));

    const tracer = trace.getTracer("strada");
    return tracer.startActiveSpan(
      "scheduled",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "scheduled.cron": controller.cron,
          "cold_start": _coldStart,
        },
      },
      async (span) => {
        _coldStart = false;
        try {
          await original(controller, env, ctx);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
          ctx.waitUntil(flush());
        }
      },
    );
  };
}

function createQueueHandler(
  original: Function,
  stradaConfig: StradaOptions | ((env: any) => StradaOptions),
) {
  return async (batch: any, env: unknown, ctx: HasWaitUntil) => {
    initStrada(resolveConfig(stradaConfig, env));

    const tracer = trace.getTracer("strada");
    return tracer.startActiveSpan(
      "queue",
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.batch.message_count": batch.messages?.length,
          "cold_start": _coldStart,
        },
      },
      async (span) => {
        _coldStart = false;
        try {
          await original(batch, env, ctx);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
          ctx.waitUntil(flush());
        }
      },
    );
  };
}

function createPassthroughHandler(
  original: Function,
  stradaConfig: StradaOptions | ((env: any) => StradaOptions),
) {
  return async (...args: any[]) => {
    // Convention: env is the second arg, ctx is the third
    const env = args[1];
    const ctx = args[2] as HasWaitUntil | undefined;

    initStrada(resolveConfig(stradaConfig, env));

    try {
      return await original(...args);
    } finally {
      if (ctx?.waitUntil) ctx.waitUntil(flush());
    }
  };
}

// ---------------------------------------------------------------------------
// instrumentDO() — wrap a Durable Object class with tracing
// ---------------------------------------------------------------------------
// Initializes Strada on DO construction so trace.getTracer(),
// captureException(), etc. work inside DO methods. Does not auto-wrap
// individual methods; use manual spans or captureException() inside
// your RPC methods.
//
// Usage:
//   class MyStore extends DurableObject<Env> {
//     async handleRequest(request: Request) { return new Response("ok") }
//   }
//
//   export const InstrumentedStore = instrumentDO({
//     strada: (env) => ({ projectId: env.STRADA_PROJECT_ID, service: "my-store" }),
//     DO: MyStore,
//   })

export function instrumentDO<T extends new (...args: any[]) => any>(input: {
  strada: StradaOptions | ((env: any) => StradaOptions);
  DO: T;
}): T {
  const { strada: stradaConfig, DO } = input;

  // Create a subclass that initializes Strada in the constructor.
  // The runtime type is compatible; the cast preserves the original type
  // so Cloudflare can construct it normally and RPC methods remain visible.
  return class extends (DO as any) {
    constructor(ctx: any, env: any) {
      super(ctx, env);
      initStrada(resolveConfig(stradaConfig, env));
    }
  } as unknown as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture an exception and send it to Strada as an OTel log record.
 * Same API as the Node and browser entries.
 */
export function captureException(
  error: unknown,
  opts?: CaptureExceptionOptions,
): void {
  const normalized = normalizeError(error);

  if (_options && shouldIgnoreError(normalized, _options)) return;
  const prepared = applyBeforeSend(normalized, _options?.beforeSend);
  if (prepared === null) return;

  const attributes = errorToAttributes(prepared, opts);

  if (_logger) {
    _logger.emit({
      eventName: "exception",
      severityNumber: ERROR_SEVERITY,
      severityText: ERROR_SEVERITY_TEXT,
      body: prepared.message,
      attributes,
    });
  } else {
    console.warn(
      "[@strada.sh/sdk] captureException called before initStrada(). Error was not sent.",
    );
  }
}

/**
 * Flush all buffered telemetry (traces and logs).
 * Called automatically by instrument() via ctx.waitUntil() after each request.
 * Call manually if using initStrada() without instrument().
 *
 * This sends 2 HTTP requests to the collector (one for traces, one for logs).
 * We flush per-request because Workers isolates can be evicted at any time
 * between requests, and module-level state (including the BatchSpanProcessor's
 * internal buffer) is not guaranteed to persist. Batching across requests
 * would risk losing spans if the isolate dies before the timer fires.
 * This is the same approach used by @microlabs/otel-cf-workers.
 */
export async function flush(): Promise<void> {
  await Promise.all([
    _loggerProvider?.forceFlush(),
    _tracerProvider?.forceFlush(),
  ]);
}

/**
 * Shut down the SDK and flush remaining telemetry.
 * Rarely needed in Workers since isolates are ephemeral.
 */
export async function shutdown(): Promise<void> {
  await Promise.all([
    _tracerProvider?.shutdown(),
    _loggerProvider?.shutdown(),
  ]);
  _tracerProvider = undefined;
  _loggerProvider = undefined;
  _logger = undefined;
  _options = undefined;
  resetContext();
}
