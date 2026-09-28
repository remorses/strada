/**
 * `@strada.sh/sdk/instrument`: integrations that create spans from
 * `node:diagnostics_channel`. Pass them to `initStrada({ integrations })`.
 *
 * Libraries and Node publish named events for their operations. Subscribing
 * needs no module patching, no loader hook, and no preload: channels are
 * process-global, so it works with any import order and in bundled apps.
 * Works on Node and on Cloudflare Workers with `nodejs_compat` (for custom
 * integrations; workerd publishes no HTTP channels).
 *
 * Channel names and payload shapes are private to this file. Users import
 * functions, never strings.
 *
 * Libraries that publish no channels (pg 8, express 5, hono) are not covered:
 * wrap those calls in `startSpan()`.
 *
 * The SDK exports its own telemetry with `fetch`, so requests to the ingest
 * origin are skipped; otherwise every export would create a span that is
 * exported again, forever.
 */

import dc from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import {
  AsyncContextManager,
  context,
  getContextManager,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "./api.ts";
import { ATTR } from "./attrs.ts";
import { getExportOrigin } from "./export.ts";
import { tryTelemetry, type StradaIntegration } from "./shared.ts";

export type { StradaIntegration } from "./shared.ts";

const tracer = trace.getTracer("strada-instrument");

/**
 * diagnostics_channel reports a throwing subscriber as an uncaught exception,
 * which would crash the app. Every handler goes through this boundary.
 */
function safe<T>(operation: string, handler: (message: T) => void): (message: unknown) => void {
  return (message) => void tryTelemetry({ operation, run: () => handler(message as T) });
}

function subscribeAll(subscriptions: Array<[string, (message: unknown) => void]>): () => void {
  for (const [name, handler] of subscriptions) dc.subscribe(name, handler);
  return () => {
    for (const [name, handler] of subscriptions) dc.unsubscribe(name, handler);
  };
}

function recordError(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : String(error));
  const code = (error as { code?: unknown } | undefined)?.code;
  span.setAttribute(ATTR["error.type"], typeof code === "string" ? code : error instanceof Error ? error.name : "Error");
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function endSpan(span: Span, { status, error }: { status?: number; error?: unknown }): void {
  if (status !== undefined) span.setAttribute(ATTR["http.response.status_code"], status);
  if (error) recordError(span, error);
  span.end();
}

// ---------------------------------------------------------------------------
// HTTP (plain channels from undici and node:http)
// ---------------------------------------------------------------------------

/** The parts of an undici Request that diagnostics_channel messages expose. */
interface UndiciRequest {
  origin: string | URL;
  path: string;
  method: string;
  addHeader(name: string, value: string): unknown;
}

function startClientSpan(method: string, url: URL): { span: Span; ctx: ReturnType<typeof context.active> } {
  const span = tracer.startSpan(method, {
    kind: SpanKind.CLIENT,
    attributes: {
      [ATTR["http.request.method"]]: method,
      [ATTR["url.full"]]: url.href,
      [ATTR["server.address"]]: url.hostname,
      [ATTR["server.port"]]: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    },
  });
  return { span, ctx: trace.setSpan(context.active(), span) };
}

function isExportRequest(origin: string): boolean {
  return origin === getExportOrigin();
}

/**
 * CLIENT spans for global `fetch()` (undici). Adds `traceparent` and `baggage`
 * headers so the receiving server continues the trace. Node only.
 */
export function fetchSpans(): StradaIntegration {
  return {
    name: "fetchSpans",
    setup() {
      const spans = new WeakMap<UndiciRequest, Span>();
      const finish = (request: UndiciRequest, error?: unknown) => {
        const span = spans.get(request);
        if (!span) return;
        spans.delete(request);
        endSpan(span, { error });
      };
      return subscribeAll([
        [
          "undici:request:create",
          safe<{ request: UndiciRequest }>("fetchSpans", ({ request }) => {
            const url = new URL(request.path, request.origin);
            if (isExportRequest(url.origin)) return;
            const { span, ctx } = startClientSpan(request.method, url);
            spans.set(request, span);
            propagation.inject(ctx, request, { set: (carrier, key, value) => carrier.addHeader(key, value) });
          }),
        ],
        [
          "undici:request:headers",
          safe<{ request: UndiciRequest; response: { statusCode: number } }>("fetchSpans", ({ request, response }) => {
            const span = spans.get(request);
            if (!span) return;
            span.setAttribute(ATTR["http.response.status_code"], response.statusCode);
            if (response.statusCode >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
          }),
        ],
        // Trailers mark the end of the response body.
        ["undici:request:trailers", safe<{ request: UndiciRequest }>("fetchSpans", ({ request }) => finish(request))],
        [
          "undici:request:error",
          safe<{ request: UndiciRequest; error: unknown }>("fetchSpans", ({ request, error }) => finish(request, error)),
        ],
      ]);
    },
  };
}

/**
 * CLIENT spans for `http.request` / `https.request`. Adds `traceparent` and
 * `baggage` headers. Node 22.12+ (the `http.client.request.created` channel).
 */
export function httpClientSpans(): StradaIntegration {
  return {
    name: "httpClientSpans",
    setup() {
      const spans = new WeakMap<ClientRequest, Span>();
      return subscribeAll([
        // `created` fires before the header block is serialized, so setHeader
        // still works. By `start` the headers are already stored.
        [
          "http.client.request.created",
          safe<{ request: ClientRequest }>("httpClientSpans", ({ request }) => {
            const url = new URL(request.path, `${request.protocol}//${String(request.getHeader("host") ?? request.host)}`);
            if (isExportRequest(url.origin)) return;
            const { span, ctx } = startClientSpan(request.method, url);
            spans.set(request, span);
            propagation.inject(ctx, request, { set: (carrier, key, value) => carrier.setHeader(key, value) });
          }),
        ],
        [
          "http.client.response.finish",
          safe<{ request: ClientRequest; response: IncomingMessage }>("httpClientSpans", ({ request, response }) => {
            const span = spans.get(request);
            if (!span) return;
            spans.delete(request);
            const status = response.statusCode ?? 0;
            if (status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
            endSpan(span, { status });
          }),
        ],
        [
          "http.client.request.error",
          safe<{ request: ClientRequest; error: unknown }>("httpClientSpans", ({ request, error }) => {
            const span = spans.get(request);
            if (!span) return;
            spans.delete(request);
            endSpan(span, { error });
          }),
        ],
      ]);
    },
  };
}

/**
 * SERVER spans for incoming `http.createServer` requests. Reads `traceparent`
 * and `baggage`, and makes the span active for the whole handler, so logs,
 * errors, and child spans attach to it. Node only.
 */
export function httpServerSpans(): StradaIntegration {
  return {
    name: "httpServerSpans",
    setup() {
      return subscribeAll([
        [
          "http.server.request.start",
          safe<{ request: IncomingMessage; response: ServerResponse }>("httpServerSpans", ({ request, response }) => {
            const method = request.method ?? "GET";
            const url = new URL(request.url ?? "/", "http://localhost");
            const parent = propagation.extract(context.active(), request.headers);
            const span = tracer.startSpan(
              method,
              {
                kind: SpanKind.SERVER,
                attributes: {
                  [ATTR["http.request.method"]]: method,
                  [ATTR["url.path"]]: url.pathname,
                  [ATTR["url.query"]]: url.search || undefined,
                  [ATTR["user_agent.original"]]: request.headers["user-agent"],
                },
              },
              parent,
            );
            // The channel is published synchronously right before the server
            // emits 'request', inside the per-request async resource, so
            // enterWith makes the span active for the handler and its async
            // continuations.
            const manager = getContextManager();
            if (manager instanceof AsyncContextManager) manager.enterWith(trace.setSpan(parent, span));
            // 'close' fires after the response finished or the client aborted.
            response.once("close", () => {
              const status = response.statusCode;
              if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
              endSpan(span, response.writableFinished ? { status } : { status, error: new Error("client aborted request") });
            });
          }),
        ],
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Libraries that publish a TracingChannel
// ---------------------------------------------------------------------------

/**
 * One CLIENT span per traced call. The span starts on `start` (sync, in the
 * caller's context, so it parents to the active span) and ends on `asyncEnd`.
 * A synchronous throw publishes `error` then `end` with no `asyncEnd`, so
 * `end` closes the span only when `error` is already set.
 */
function subscribeTracingChannel<T extends object>({
  integration,
  channel: channelName,
  describe,
}: {
  integration: string;
  channel: string;
  describe: (message: T) => { name: string; attributes: Attributes };
}): () => void {
  const channel = dc.tracingChannel<object, T>(channelName);
  const spans = new WeakMap<T, Span>();
  const finish = (message: T) => {
    const span = spans.get(message);
    if (!span) return;
    spans.delete(message);
    span.end();
  };
  const handlers = {
    start: safe<T>(integration, (message) => {
      const { name, attributes } = describe(message);
      spans.set(message, tracer.startSpan(name, { kind: SpanKind.CLIENT, attributes }));
    }),
    end: safe<T>(integration, (message) => {
      if ("error" in message) finish(message);
    }),
    asyncStart: () => {},
    asyncEnd: safe<T>(integration, finish),
    error: safe<T & { error: unknown }>(integration, (message) => {
      const span = spans.get(message);
      if (span) recordError(span, message.error);
    }),
  };
  channel.subscribe(handlers);
  return () => {
    channel.unsubscribe(handlers);
  };
}

const MAX_QUERY_TEXT = 1024;

function truncate(text: string): string {
  return text.length > MAX_QUERY_TEXT ? `${text.slice(0, MAX_QUERY_TEXT - 3)}...` : text;
}

// Quoted strings (with \ and doubled-quote escapes), hex, and numbers.
const SQL_LITERAL = /'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|\b0x[0-9a-f]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi;

/**
 * mysql2 `query()` inlines values into the SQL before publishing, so literals
 * can hold user data. Replace them with `?`, as OTel semconv asks for
 * `db.query.text`.
 */
function sanitizeSql(sql: string): string {
  return truncate(sql.replace(SQL_LITERAL, "?"));
}

function sqlOperation(sql: string): string | undefined {
  return /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase();
}

interface Mysql2QueryMessage {
  query: string;
  database: string;
  serverAddress: string;
  serverPort?: number;
}

/**
 * CLIENT spans for mysql2 `query()` and `execute()`, callback and promise
 * APIs. Needs mysql2 3.20+, older versions publish nothing. Literals in the
 * SQL are replaced with `?`.
 */
export function mysql2Spans(): StradaIntegration {
  const describe = (message: Mysql2QueryMessage) => {
    const operation = sqlOperation(message.query);
    const database = message.database || undefined;
    return {
      name: [operation, database].filter(Boolean).join(" ") || "mysql",
      attributes: {
        [ATTR["db.system.name"]]: "mysql",
        [ATTR["db.namespace"]]: database,
        [ATTR["db.operation.name"]]: operation,
        [ATTR["db.query.text"]]: sanitizeSql(message.query),
        [ATTR["server.address"]]: message.serverAddress,
        [ATTR["server.port"]]: message.serverPort,
      },
    };
  };
  return {
    name: "mysql2Spans",
    setup() {
      const unsubscribers = ["mysql2:query", "mysql2:execute"].map((channel) =>
        subscribeTracingChannel({ integration: "mysql2Spans", channel, describe }),
      );
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
  };
}

interface IoredisCommandMessage {
  command: string;
  args: string[];
  database: number;
  serverAddress: string;
  serverPort?: number;
}

/**
 * CLIENT spans for ioredis commands, including each command of a pipeline or
 * MULTI. Needs ioredis 5.11+, older versions publish nothing. ioredis redacts
 * argument values of write commands (for example `SET key ?`) before
 * publishing.
 */
export function ioredisSpans(): StradaIntegration {
  return {
    name: "ioredisSpans",
    setup() {
      return subscribeTracingChannel<IoredisCommandMessage>({
        integration: "ioredisSpans",
        channel: "ioredis:command",
        describe: (message) => {
          const operation = message.command.toUpperCase();
          return {
            name: `${operation} ${message.database}`,
            attributes: {
              [ATTR["db.system.name"]]: "redis",
              [ATTR["db.namespace"]]: String(message.database),
              [ATTR["db.operation.name"]]: operation,
              [ATTR["db.query.text"]]: truncate([operation, ...message.args].join(" ")),
              [ATTR["server.address"]]: message.serverAddress,
              [ATTR["server.port"]]: message.serverPort,
            },
          };
        },
      });
    },
  };
}
