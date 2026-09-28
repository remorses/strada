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
 *
 * Channel names and payloads are contracts owned by each library. Every
 * integration links the source that publishes its channels. When you add or
 * change an integration, keep the `Source:` link current. When a library
 * release renames a channel or a payload field, update the subscriber here
 * and the version in its doc comment. Keep integrations thin: map published
 * fields to span name and semconv attributes, no sanitizing or parsing of our
 * own. When unsure, copy Sentry's subscriber for the same channel. Ecosystem status:
 * https://github.com/getsentry/js-tracing-channels-proposals/blob/main/TRACKER.md
 */

import dc from "node:diagnostics_channel";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import {
  AsyncContextManager,
  context,
  getContextManager,
  logs,
  propagation,
  SeverityNumber,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
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
  // Hold the Channel objects: Bun garbage-collects unreferenced channels with
  // their subscribers. https://github.com/oven-sh/bun/issues/43086
  const channels = subscriptions.map(([name, handler]) => {
    const channel = dc.channel(name);
    channel.subscribe(handler);
    return { channel, handler };
  });
  return () => {
    for (const { channel, handler } of channels) channel.unsubscribe(handler);
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
 *
 * Source: https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md
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
 *
 * Source: https://nodejs.org/api/diagnostics_channel.html#built-in-channels
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
 *
 * Source: https://nodejs.org/api/diagnostics_channel.html#built-in-channels
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

interface SpanDescription {
  name: string;
  attributes: Attributes;
  kind?: SpanKind;
}

/**
 * One span per traced call, following Sentry's `bindTracingChannelToSpan`
 * (packages/server-utils/src/tracing-channel.ts in getsentry/sentry-javascript).
 *
 * - `start.bindStore` creates the span in the caller's context and makes it
 *   active inside the traced call, so nested spans, logs, and errors attach
 *   to it. `asyncStart.bindStore` restores the caller's context for
 *   callback-style continuations. Without AsyncLocalStorage (browser) the span
 *   is created on `start` and is never active.
 * - `describe` returning undefined creates no span and leaves the context as is.
 * - The span ends on `end` when the call settled synchronously (`result` or
 *   `error` already set, e.g. traceSync or a sync throw), else on `asyncEnd`.
 */
function subscribeTracingChannel<T extends object>({
  integration,
  channel: channelName,
  describe,
  beforeEnd,
}: {
  integration: string;
  channel: string;
  describe: (message: T) => SpanDescription | undefined;
  /** Read the settled `result` before the span ends, e.g. status or token usage. */
  beforeEnd?: (span: Span, message: T & { result?: unknown }) => void;
}): () => void {
  const channel = dc.tracingChannel<object, T>(channelName);
  const spans = new WeakMap<T, Span>();
  const open = (message: T): Span | undefined => {
    const description = describe(message);
    if (!description) return undefined;
    const span = tracer.startSpan(description.name, {
      kind: description.kind ?? SpanKind.CLIENT,
      attributes: description.attributes,
    });
    spans.set(message, span);
    return span;
  };
  const finish = (message: T) => {
    const span = spans.get(message);
    if (!span) return;
    spans.delete(message);
    beforeEnd?.(span, message);
    span.end();
  };

  const manager = getContextManager();
  const storage = manager instanceof AsyncContextManager ? (manager.storage as AsyncLocalStorage<Context>) : undefined;
  const callers = new WeakMap<T, Context>();
  if (storage) {
    // bindStore transforms run outside diagnostics_channel's subscriber error
    // handling, so a throw here would reach the traced call. Guard it.
    channel.start.bindStore(storage, (message: T) => {
      const caller = context.active();
      callers.set(message, caller);
      let span: Span | undefined;
      void tryTelemetry({ operation: integration, run: () => void (span = open(message)) });
      return span ? trace.setSpan(caller, span) : caller;
    });
    channel.asyncStart.bindStore(storage, (message: T) => callers.get(message) ?? context.active());
  }

  const handlers = {
    start: storage ? () => {} : safe<T>(integration, (message) => void open(message)),
    end: safe<T>(integration, (message) => {
      if ("error" in message || "result" in message) finish(message);
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
    if (!storage) return;
    channel.start.unbindStore(storage);
    channel.asyncStart.unbindStore(storage);
  };
}

function combine(teardowns: Array<() => void>): () => void {
  return () => {
    for (const teardown of teardowns) teardown();
  };
}

const MAX_QUERY_TEXT = 1024;

function truncate(text: string): string {
  return text.length > MAX_QUERY_TEXT ? `${text.slice(0, MAX_QUERY_TEXT - 3)}...` : text;
}

function sqlOperation(sql: string): string | undefined {
  return /^\(*\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase();
}

interface Mysql2QueryMessage {
  query: string;
  database: string;
  serverAddress: string;
  serverPort?: number;
}

/**
 * CLIENT spans for mysql2 `query()` and `execute()`, callback and promise
 * APIs. Needs mysql2 3.20+, older versions publish nothing. `db.query.text`
 * is the SQL as mysql2 publishes it (`query()` inlines the values).
 *
 * Source: https://github.com/sidorares/node-mysql2/blob/master/lib/tracing.js
 * (channels) and https://github.com/sidorares/node-mysql2/blob/master/lib/base/connection.js
 * (payload built at each traceCallback / tracePromise call).
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
        [ATTR["db.query.text"]]: truncate(message.query),
        [ATTR["server.address"]]: message.serverAddress,
        [ATTR["server.port"]]: message.serverPort,
      },
    };
  };
  return {
    name: "mysql2Spans",
    setup() {
      return combine(
        ["mysql2:query", "mysql2:execute"].map((channel) => subscribeTracingChannel({ integration: "mysql2Spans", channel, describe })),
      );
    },
  };
}

interface RedisCommandMessage {
  command: string;
  args: readonly string[];
  database: number;
  serverAddress: string;
  serverPort?: number;
}

interface RedisBatchMessage {
  batchMode: "MULTI" | "PIPELINE";
  batchSize: number;
  database: number;
  serverAddress: string;
  serverPort?: number;
}

function redisAttributes(message: RedisCommandMessage | RedisBatchMessage, operation: string): Attributes {
  return {
    [ATTR["db.system.name"]]: "redis",
    [ATTR["db.namespace"]]: String(message.database),
    [ATTR["db.operation.name"]]: operation,
    [ATTR["server.address"]]: message.serverAddress,
    [ATTR["server.port"]]: message.serverPort,
  };
}

/**
 * CLIENT spans for Redis commands from `redis` (node-redis 5.12+) and
 * `ioredis` (5.11+); older versions publish nothing. Both libraries replace
 * write values with `?` before publishing. node-redis also publishes one span
 * per MULTI / PIPELINE; ioredis publishes only the commands.
 *
 * Source: https://github.com/redis/node-redis/blob/master/packages/client/lib/client/tracing.ts
 * (channels, payload types; `args[0]` is the command name) and
 * https://github.com/redis/ioredis/blob/main/lib/tracing.ts (channels) with
 * https://github.com/redis/ioredis/blob/main/lib/Redis.ts (`_buildCommandContext` payload).
 */
export function redisSpans(): StradaIntegration {
  const command = (args: (message: RedisCommandMessage) => readonly string[]) => (message: RedisCommandMessage) => {
    const operation = message.command.toUpperCase();
    return {
      name: `${operation} ${message.database}`,
      attributes: {
        ...redisAttributes(message, operation),
        [ATTR["db.query.text"]]: truncate([operation, ...args(message)].join(" ")),
      },
    };
  };
  return {
    name: "redisSpans",
    setup() {
      return combine([
        subscribeTracingChannel<RedisCommandMessage>({
          integration: "redisSpans",
          channel: "node-redis:command",
          describe: command((message) => message.args.slice(1)),
        }),
        subscribeTracingChannel<RedisBatchMessage>({
          integration: "redisSpans",
          channel: "node-redis:batch",
          describe: (message) => ({
            name: `${message.batchMode} ${message.database}`,
            attributes: {
              ...redisAttributes(message, message.batchMode),
              [ATTR["db.operation.batch.size"]]: message.batchSize > 1 ? message.batchSize : undefined,
            },
          }),
        }),
        subscribeTracingChannel<RedisCommandMessage>({
          integration: "redisSpans",
          channel: "ioredis:command",
          describe: command((message) => message.args),
        }),
      ]);
    },
  };
}

interface MongooseMessage {
  operation: string;
  collection?: string;
  database?: string;
  serverAddress?: string;
  serverPort?: number;
  args?: { filter?: object; pipeline?: object[]; docs?: unknown[]; ops?: unknown[] };
}

/**
 * CLIENT spans for mongoose 9.7+ queries, aggregations, `save()`,
 * `insertMany()`, `bulkWrite()`, and cursor `next()`. Older versions publish
 * nothing. `db.query.text` is the filter or pipeline as JSON.
 *
 * Source: https://github.com/Automattic/mongoose/blob/master/lib/tracing.js
 * (channel helper) and the payloads at each `trace*()` call in
 * https://github.com/Automattic/mongoose/blob/master/lib/query.js,
 * https://github.com/Automattic/mongoose/blob/master/lib/aggregate.js,
 * https://github.com/Automattic/mongoose/blob/master/lib/model.js.
 */
export function mongooseSpans(): StradaIntegration {
  const describe = (message: MongooseMessage) => {
    const query = message.args?.pipeline ?? message.args?.filter;
    const batch = message.args?.docs ?? message.args?.ops;
    return {
      name: [message.operation, message.collection ?? message.database].filter(Boolean).join(" "),
      attributes: {
        [ATTR["db.system.name"]]: "mongodb",
        [ATTR["db.namespace"]]: message.database,
        [ATTR["db.collection.name"]]: message.collection,
        [ATTR["db.operation.name"]]: message.operation,
        [ATTR["db.query.text"]]: query === undefined ? undefined : truncate(JSON.stringify(query)),
        [ATTR["db.operation.batch.size"]]: batch && batch.length > 1 ? batch.length : undefined,
        [ATTR["server.address"]]: message.serverAddress,
        [ATTR["server.port"]]: message.serverPort,
      },
    };
  };
  return {
    name: "mongooseSpans",
    setup() {
      return combine(
        [
          "mongoose:query",
          "mongoose:aggregate",
          "mongoose:model:save",
          "mongoose:model:insertMany",
          "mongoose:model:bulkWrite",
          "mongoose:cursor:next",
        ].map((channel) => subscribeTracingChannel({ integration: "mongooseSpans", channel, describe })),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// GraphQL, AI SDK, h3
// ---------------------------------------------------------------------------

interface GraphqlDocument {
  loc?: { source?: { body?: string } };
}

interface GraphqlOperationMessage {
  document?: GraphqlDocument;
  operationName?: string;
  operationType?: string;
}

/**
 * INTERNAL spans for graphql 17+ `parse`, `validate`, `execute`, and
 * `subscribe`. Older versions publish nothing. Resolver spans are not
 * created (one per field is too many), as in Sentry. An execute result with
 * `errors` or a non-empty validation result sets ERROR status.
 *
 * Source: https://github.com/graphql/graphql-js/blob/17.x.x/src/diagnostics.ts
 * Mirrors: https://github.com/getsentry/sentry-javascript/blob/develop/packages/server-utils/src/integrations/graphql/graphql-dc-subscriber.ts
 */
export function graphqlSpans(): StradaIntegration {
  const operation = (message: GraphqlOperationMessage): SpanDescription => ({
    name: [message.operationType, message.operationName].filter(Boolean).join(" ") || "graphql.execute",
    kind: SpanKind.INTERNAL,
    attributes: {
      [ATTR["graphql.operation.type"]]: message.operationType,
      [ATTR["graphql.operation.name"]]: message.operationName || undefined,
      [ATTR["graphql.document"]]: message.document?.loc?.source?.body,
    },
  });
  const failed = (span: Span, errors: unknown) => {
    if (Array.isArray(errors) && errors.length > 0) span.setStatus({ code: SpanStatusCode.ERROR });
  };
  return {
    name: "graphqlSpans",
    setup() {
      return combine([
        subscribeTracingChannel<object>({
          integration: "graphqlSpans",
          channel: "graphql:parse",
          describe: () => ({ name: "graphql.parse", kind: SpanKind.INTERNAL, attributes: {} }),
        }),
        subscribeTracingChannel<{ document?: GraphqlDocument }>({
          integration: "graphqlSpans",
          channel: "graphql:validate",
          describe: (message) => ({
            name: "graphql.validate",
            kind: SpanKind.INTERNAL,
            attributes: { [ATTR["graphql.document"]]: message.document?.loc?.source?.body },
          }),
          beforeEnd: (span, message) => failed(span, message.result),
        }),
        ...["graphql:execute", "graphql:subscribe"].map((channel) =>
          subscribeTracingChannel<GraphqlOperationMessage>({
            integration: "graphqlSpans",
            channel,
            describe: operation,
            beforeEnd: (span, message) => failed(span, (message.result as { errors?: unknown } | undefined)?.errors),
          }),
        ),
      ]);
    },
  };
}

interface AiMessage {
  type: string;
  event: {
    provider?: string;
    modelId?: string;
    functionId?: string;
    toolCallId?: string;
    toolCall?: { toolName?: string; toolCallId?: string };
  };
}

/** `usage` fields are numbers on operation results and `{ total }` on model call results. */
function tokenCount(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  const total = (value as { total?: unknown } | undefined)?.total;
  return typeof total === "number" ? total : undefined;
}

// OTel GenAI operation names for each `ai:telemetry` event type.
const AI_OPERATIONS: Record<string, { operation: string; kind: SpanKind }> = {
  generateText: { operation: "invoke_agent", kind: SpanKind.INTERNAL },
  streamText: { operation: "invoke_agent", kind: SpanKind.INTERNAL },
  generateObject: { operation: "invoke_agent", kind: SpanKind.INTERNAL },
  languageModelCall: { operation: "generate_content", kind: SpanKind.CLIENT },
  executeTool: { operation: "execute_tool", kind: SpanKind.INTERNAL },
  embed: { operation: "embeddings", kind: SpanKind.CLIENT },
  embedMany: { operation: "embeddings", kind: SpanKind.CLIENT },
  rerank: { operation: "rerank", kind: SpanKind.CLIENT },
};

/**
 * GenAI spans for the Vercel AI SDK 7+ (`ai`): one per `generateText` /
 * `streamText` / `generateObject` call, model call, tool call, embedding, and
 * rerank, nested under each other. Token usage is read from the result.
 * Prompts and outputs are not recorded. Older versions publish nothing; use
 * `registerOpenTelemetry()` with `experimental_telemetry` there.
 *
 * Limit: a streamed model call ends when the stream is returned, not when it
 * is drained, so its duration and usage cover only the first response.
 *
 * Source: https://github.com/vercel/ai/blob/main/packages/ai/src/telemetry/tracing-channel.ts
 * Mirrors: https://github.com/getsentry/sentry-javascript/blob/develop/packages/server-utils/src/integrations/vercel-ai/vercel-ai-dc-subscriber.ts
 */
export function aiSpans(): StradaIntegration {
  return {
    name: "aiSpans",
    setup() {
      return subscribeTracingChannel<AiMessage>({
        integration: "aiSpans",
        channel: "ai:telemetry",
        describe: ({ type, event }) => {
          // `step` events and unknown types keep the enclosing span active.
          const known = AI_OPERATIONS[type];
          if (!known) return undefined;
          const toolName = event.toolCall?.toolName;
          const suffix = type === "executeTool" ? toolName : known.operation === "invoke_agent" ? event.functionId : event.modelId;
          return {
            name: [known.operation, suffix].filter(Boolean).join(" "),
            kind: known.kind,
            attributes: {
              [ATTR["gen_ai.operation.name"]]: known.operation,
              [ATTR["gen_ai.provider.name"]]: event.provider,
              [ATTR["gen_ai.request.model"]]: event.modelId,
              [ATTR["gen_ai.tool.name"]]: toolName,
              [ATTR["gen_ai.tool.call.id"]]: event.toolCallId ?? event.toolCall?.toolCallId,
            },
          };
        },
        beforeEnd: (span, message) => {
          const usage = (message.result as { usage?: Record<string, unknown> } | undefined)?.usage;
          if (!usage) return;
          const input = tokenCount(usage.inputTokens);
          const output = tokenCount(usage.outputTokens);
          if (input !== undefined) span.setAttribute(ATTR["gen_ai.usage.input_tokens"], input);
          if (output !== undefined) span.setAttribute(ATTR["gen_ai.usage.output_tokens"], output);
        },
      });
    },
  };
}

interface H3Message {
  type?: "middleware" | "route";
  event: {
    url: URL;
    req: { method: string };
    context?: { matchedRoute?: { route?: string } };
  };
}

/**
 * SERVER spans for h3 v2 routes and INTERNAL spans for its middleware, with
 * `http.route` from the matched route. h3 publishes only after the app adds
 * `tracingPlugin()` from `h3/tracing` (2.0.1-rc.14+; earlier rcs used the
 * `h3.fetch` channel name).
 *
 * Source: https://github.com/h3js/h3/blob/main/src/tracing.ts
 * Mirrors: https://github.com/getsentry/sentry-javascript/blob/develop/packages/nitro/src/runtime/hooks/captureTracingEvents.ts
 */
export function h3Spans(): StradaIntegration {
  return {
    name: "h3Spans",
    setup() {
      return subscribeTracingChannel<H3Message>({
        integration: "h3Spans",
        channel: "h3.request",
        describe: ({ type, event }) => {
          const matched = event.context?.matchedRoute?.route;
          const route = matched && matched !== "/**" ? matched : undefined;
          const method = event.req.method.toUpperCase();
          return {
            name: `${type === "middleware" ? "middleware " : ""}${method} ${route ?? event.url.pathname}`,
            kind: type === "middleware" ? SpanKind.INTERNAL : SpanKind.SERVER,
            attributes: {
              [ATTR["http.request.method"]]: method,
              [ATTR["url.path"]]: event.url.pathname,
              [ATTR["http.route"]]: route,
            },
          };
        },
        beforeEnd: (span, message) => {
          const status = (message.result as { status?: unknown } | undefined)?.status;
          if (typeof status !== "number") return;
          span.setAttribute(ATTR["http.response.status_code"], status);
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// pino (logs, not spans)
// ---------------------------------------------------------------------------

interface PinoAsJsonMessage {
  instance: { levels?: { labels?: Record<number, string> } };
  arguments: [object | undefined, string | undefined, number];
  result?: string;
}

// pino level numbers to OTel severity numbers.
const PINO_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

/**
 * Sends every pino 9.10+ log line as an OTel log record, correlated to the
 * active span. The body is the message, attributes are the other JSON fields
 * (objects as JSON strings). Older versions publish nothing.
 *
 * Source: https://github.com/pinojs/pino/blob/main/lib/tools.js (`asJson`,
 * the `tracing:pino_asJson` channel)
 * Mirrors: https://github.com/getsentry/sentry-javascript/blob/develop/packages/node/src/integrations/pino.ts
 */
export function pinoLogs(): StradaIntegration {
  return {
    name: "pinoLogs",
    setup() {
      const logger = logs.getLogger("pino");
      const channel = dc.tracingChannel<object, PinoAsJsonMessage>("pino_asJson");
      const handlers = {
        start: () => {},
        // traceSync sets `result` (the serialized JSON line) before `end`.
        end: safe<PinoAsJsonMessage>("pinoLogs", ({ instance, arguments: args, result }) => {
          if (!result) return;
          const { level: _level, time: _time, pid: _pid, hostname: _hostname, msg, ...fields } = JSON.parse(result) as Record<string, unknown>;
          const levelNumber = args[2];
          logger.emit({
            severityNumber: PINO_SEVERITY[levelNumber] ?? SeverityNumber.INFO,
            severityText: instance.levels?.labels?.[levelNumber]?.toUpperCase() ?? "INFO",
            body: typeof msg === "string" ? msg : (args[1] ?? ""),
            attributes: Object.fromEntries(
              Object.entries(fields).map(([key, value]) => [key, value !== null && typeof value === "object" ? JSON.stringify(value) : value]),
            ) as Attributes,
          });
        }),
        asyncStart: () => {},
        asyncEnd: () => {},
        error: () => {},
      };
      channel.subscribe(handlers);
      return () => channel.unsubscribe(handlers);
    },
  };
}
