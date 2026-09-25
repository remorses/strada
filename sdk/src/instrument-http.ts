/**
 * Opt-in HTTP spans for Node through `node:diagnostics_channel`.
 *
 * Node's http module and undici (`fetch`) publish named events for every
 * request. Subscribing needs no module patching, no loader hook, and no
 * preload: the channels are process-global, so it works no matter when
 * modules were imported and inside bundled apps (Vite, Next), because
 * `node:http` and `fetch` are Node built-ins.
 *
 * Only HTTP. Databases and frameworks publish no channels today (pg 8.22,
 * express 5, hono checked); wrap those calls in `startSpan()` or pass the
 * framework tracer (Spiceflow `new Spiceflow({ tracer })`).
 *
 * The SDK exports its own telemetry with `fetch`, so requests to the ingest
 * origin are skipped; otherwise every export would create a span that is
 * exported again, forever.
 */

import dc from "node:diagnostics_channel";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { context, propagation, SpanKind, SpanStatusCode, trace, type Context, type Span } from "./api.ts";
import { ATTR } from "./attrs.ts";
import { getExportOrigin } from "./export.ts";
import type { StradaOptions } from "./shared.ts";

type Instrument = NonNullable<StradaOptions["instrument"]>[number];

/** The parts of an undici Request that diagnostics_channel messages expose. */
interface UndiciRequest {
  origin: string | URL;
  path: string;
  method: string;
  addHeader(name: string, value: string): unknown;
}

const tracer = trace.getTracer("strada-http");

function endSpan(span: Span, { status, error }: { status?: number; error?: unknown }): void {
  if (status !== undefined) span.setAttribute(ATTR["http.response.status_code"], status);
  if (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setAttribute(ATTR["error.type"], (error as { code?: string }).code ?? (error as Error).name ?? "Error");
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

function startClientSpan(method: string, url: URL): { span: Span; ctx: Context } {
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

function instrumentFetch(): () => void {
  const spans = new WeakMap<UndiciRequest, Span>();
  const onCreate = (message: unknown) => {
    const { request } = message as { request: UndiciRequest };
    const url = new URL(request.path, request.origin);
    if (isExportRequest(url.origin)) return;
    const { span, ctx } = startClientSpan(request.method, url);
    spans.set(request, span);
    propagation.inject(ctx, request, { set: (carrier, key, value) => carrier.addHeader(key, value) });
  };
  const onHeaders = (message: unknown) => {
    const { request, response } = message as { request: UndiciRequest; response: { statusCode: number } };
    const span = spans.get(request);
    if (!span) return;
    span.setAttribute(ATTR["http.response.status_code"], response.statusCode);
    if (response.statusCode >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
  };
  // Trailers mark the end of the response body.
  const onTrailers = (message: unknown) => {
    const { request } = message as { request: UndiciRequest };
    const span = spans.get(request);
    if (span) endSpan(span, {});
    spans.delete(request);
  };
  const onError = (message: unknown) => {
    const { request, error } = message as { request: UndiciRequest; error: unknown };
    const span = spans.get(request);
    if (span) endSpan(span, { error });
    spans.delete(request);
  };
  const subscriptions: Array<[string, (message: unknown) => void]> = [
    ["undici:request:create", onCreate],
    ["undici:request:headers", onHeaders],
    ["undici:request:trailers", onTrailers],
    ["undici:request:error", onError],
  ];
  for (const [name, handler] of subscriptions) dc.subscribe(name, handler);
  return () => {
    for (const [name, handler] of subscriptions) dc.unsubscribe(name, handler);
  };
}

function instrumentHttpClient(): () => void {
  const spans = new WeakMap<ClientRequest, Span>();
  // `created` (Node 22.12+) fires before the header block is serialized, so
  // setHeader still works. By `start` the headers are already stored.
  const onCreated = (message: unknown) => {
    const { request } = message as { request: ClientRequest };
    const url = new URL(request.path, `${request.protocol}//${String(request.getHeader("host") ?? request.host)}`);
    if (isExportRequest(url.origin)) return;
    const { span, ctx } = startClientSpan(request.method, url);
    spans.set(request, span);
    propagation.inject(ctx, request, { set: (carrier, key, value) => carrier.setHeader(key, value) });
  };
  const onFinish = (message: unknown) => {
    const { request, response } = message as { request: ClientRequest; response: IncomingMessage };
    const span = spans.get(request);
    if (!span) return;
    const status = response.statusCode ?? 0;
    if (status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
    endSpan(span, { status });
    spans.delete(request);
  };
  const onError = (message: unknown) => {
    const { request, error } = message as { request: ClientRequest; error: unknown };
    const span = spans.get(request);
    if (span) endSpan(span, { error });
    spans.delete(request);
  };
  const subscriptions: Array<[string, (message: unknown) => void]> = [
    ["http.client.request.created", onCreated],
    ["http.client.response.finish", onFinish],
    ["http.client.request.error", onError],
  ];
  for (const [name, handler] of subscriptions) dc.subscribe(name, handler);
  return () => {
    for (const [name, handler] of subscriptions) dc.unsubscribe(name, handler);
  };
}

function instrumentHttpServer(storage: AsyncLocalStorage<Context>): () => void {
  const onStart = (message: unknown) => {
    const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
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
    // The channel is published synchronously right before the server emits
    // 'request', inside the per-request async resource, so enterWith makes
    // this span active for the whole handler and its async continuations.
    storage.enterWith(trace.setSpan(parent, span));
    // 'close' fires after the response finished or the client aborted.
    response.once("close", () => {
      const status = response.statusCode;
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      endSpan(span, response.writableFinished ? { status } : { status, error: new Error("client aborted request") });
    });
  };
  dc.subscribe("http.server.request.start", onStart);
  return () => {
    dc.unsubscribe("http.server.request.start", onStart);
  };
}

/** Subscribe the requested instruments. Returns a function that unsubscribes all of them. */
export function instrumentHttp({
  instrument,
  storage,
}: {
  instrument: Instrument[];
  storage: AsyncLocalStorage<Context>;
}): () => void {
  const unsubscribers = [
    instrument.includes("fetch") ? instrumentFetch() : undefined,
    instrument.includes("http-client") ? instrumentHttpClient() : undefined,
    instrument.includes("http-server") ? instrumentHttpServer(storage) : undefined,
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe?.();
  };
}
