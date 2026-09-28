/**
 * Zero-dependency implementation of the OpenTelemetry JS API surface the SDK
 * needs: context, trace, propagation (W3C traceparent + baggage), logs, and
 * metrics. Shapes match `@opentelemetry/api` / `@opentelemetry/api-logs`, so:
 *
 * - user code written against the OTel API (`trace.getTracer()`,
 *   `logs.getLogger().emit()`, `metrics.getMeter()`) works unchanged when it
 *   imports these objects from `@strada.sh/sdk`
 * - `@strada.sh/sdk/otel` can register these providers into the real
 *   `@opentelemetry/api` globals, so third-party instrumentations (AI SDK,
 *   Prisma, @opentelemetry/instrumentation-*) export through Strada
 *
 * Context keys use `Symbol.for()` with the exact OTel descriptions, so spans
 * and baggage set by `@opentelemetry/api` helpers are visible here and vice
 * versa.
 *
 * Records are handed to the export pipeline in `export.ts`. Runtime entries
 * (node, browser, cloudflare) enrich records through `runtimeHooks`.
 */

import {
  enqueueLog,
  enqueueSpan,
  isExporting,
  registerMetricsCollector,
  type OtlpKeyValue,
  type OtlpMetric,
  toAnyValue,
  toKeyValues,
  timeToUnixNano,
  nowUnixNano,
} from "./export.ts";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface Context {
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): Context;
  deleteValue(key: symbol): Context;
}

class BaseContext implements Context {
  readonly #values: Map<symbol, unknown>;

  constructor(values?: Map<symbol, unknown>) {
    this.#values = values ? new Map(values) : new Map();
  }

  getValue(key: symbol): unknown {
    return this.#values.get(key);
  }

  setValue(key: symbol, value: unknown): Context {
    const next = new BaseContext(this.#values);
    next.#values.set(key, value);
    return next;
  }

  deleteValue(key: symbol): Context {
    const next = new BaseContext(this.#values);
    next.#values.delete(key);
    return next;
  }
}

export const ROOT_CONTEXT: Context = new BaseContext();

/** Same as OTel `createContextKey`: `Symbol.for` so separate copies share keys. */
export function createContextKey(description: string): symbol {
  return Symbol.for(description);
}

const SPAN_KEY = createContextKey("OpenTelemetry Context Key SPAN");
const BAGGAGE_KEY = createContextKey("OpenTelemetry Baggage Key");

export interface ContextManager {
  active(): Context;
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F>;
  bind<T>(context: Context, target: T): T;
  enable(): this;
  disable(): this;
}

function bindFunction<T>(manager: ContextManager, ctx: Context, target: T): T {
  if (typeof target !== "function") return target;
  const fn = target as (...args: unknown[]) => unknown;
  return function (this: unknown, ...args: unknown[]) {
    return manager.with(ctx, () => fn.apply(this, args));
  } as T;
}

/**
 * Synchronous context stack. Context is lost across `await`, the same
 * limitation as OTel's browser StackContextManager.
 */
export class StackContextManager implements ContextManager {
  #current: Context = ROOT_CONTEXT;

  active(): Context {
    return this.#current;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this.#current;
    this.#current = ctx;
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.#current = previous;
    }
  }

  bind<T>(ctx: Context, target: T): T {
    return bindFunction(this, ctx, target);
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#current = ROOT_CONTEXT;
    return this;
  }
}

/** Minimal AsyncLocalStorage shape, so this file never imports node:async_hooks. */
export interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R, A extends unknown[]>(store: T, callback: (...args: A) => R, ...args: A): R;
}

/** Context that survives `await`. Runtime entries pass the AsyncLocalStorage instance. */
export class AsyncContextManager implements ContextManager {
  constructor(private readonly storage: AsyncLocalStorageLike<Context>) {}

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const callback = thisArg == null ? fn : fn.bind(thisArg);
    return this.storage.run(ctx, callback, ...args);
  }

  bind<T>(ctx: Context, target: T): T {
    return bindFunction(this, ctx, target);
  }

  enable(): this {
    return this;
  }

  disable(): this {
    return this;
  }
}

let contextManager: ContextManager = new StackContextManager();

export function setContextManager(manager: ContextManager): void {
  contextManager = manager;
}

export function getContextManager(): ContextManager {
  return contextManager;
}

export const context = {
  active(): Context {
    return contextManager.active();
  },
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return contextManager.with(ctx, fn, thisArg, ...args);
  },
  bind<T>(ctx: Context, target: T): T {
    return contextManager.bind(ctx, target);
  },
};

// ---------------------------------------------------------------------------
// Attributes and time
// ---------------------------------------------------------------------------

export type AttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

export type Attributes = Record<string, AttributeValue | undefined>;
export type SpanAttributes = Attributes;
export type SpanAttributeValue = AttributeValue;

/** Milliseconds since epoch, a Date, or an OTel HrTime `[seconds, nanoseconds]`. */
export type TimeInput = number | Date | [number, number];

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export const SpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
} as const;
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;
export type SpanStatusCode = (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

export const TraceFlags = { NONE: 0, SAMPLED: 1 } as const;

/** Same shape as OTel `TraceState`: immutable W3C `tracestate` vendor entries. */
export interface TraceState {
  get(key: string): string | undefined;
  set(key: string, value: string): TraceState;
  unset(key: string): TraceState;
  serialize(): string;
}

// W3C Trace Context limits: https://www.w3.org/TR/trace-context/#tracestate-header
const TRACESTATE_KEY_RE = /^(?:[a-z][_0-9a-z\-*/]{0,255}|[a-z0-9][_0-9a-z\-*/]{0,240}@[a-z][_0-9a-z\-*/]{0,13})$/;
const TRACESTATE_VALUE_RE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const MAX_TRACESTATE_MEMBERS = 32;
const MAX_TRACESTATE_LENGTH = 512;

class TraceStateImpl implements TraceState {
  readonly #entries: Map<string, string>;

  constructor(entries?: Map<string, string>) {
    this.#entries = entries ? new Map(entries) : new Map();
  }

  get(key: string): string | undefined {
    return this.#entries.get(key);
  }

  /** Updated keys move to the front, as the spec requires. */
  set(key: string, value: string): TraceState {
    if (!TRACESTATE_KEY_RE.test(key) || !TRACESTATE_VALUE_RE.test(value)) return this;
    const next = new Map([[key, value]]);
    for (const [k, v] of this.#entries) if (k !== key) next.set(k, v);
    return new TraceStateImpl(new Map(Array.from(next).slice(0, MAX_TRACESTATE_MEMBERS)));
  }

  unset(key: string): TraceState {
    const next = new TraceStateImpl(this.#entries);
    next.#entries.delete(key);
    return next;
  }

  serialize(): string {
    return Array.from(this.#entries, ([key, value]) => `${key}=${value}`).join(",");
  }
}

/** Parse a `tracestate` header. Invalid members are dropped; an oversized header is dropped whole. */
export function createTraceState(header = ""): TraceState {
  if (header.length > MAX_TRACESTATE_LENGTH) return new TraceStateImpl();
  const entries = new Map<string, string>();
  for (const member of header.split(",")) {
    const trimmed = member.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (!TRACESTATE_KEY_RE.test(key) || !TRACESTATE_VALUE_RE.test(value) || entries.has(key)) continue;
    entries.set(key, value);
    if (entries.size === MAX_TRACESTATE_MEMBERS) break;
  }
  return new TraceStateImpl(entries);
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
  traceState?: TraceState;
}

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface Link {
  context: SpanContext;
  attributes?: Attributes;
  droppedAttributesCount?: number;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  links?: Link[];
  startTime?: TimeInput;
  root?: boolean;
}

export type Exception =
  | string
  | Error
  | { code?: string | number; message?: string; name?: string; stack?: string };

export interface Span {
  spanContext(): SpanContext;
  setAttribute(key: string, value: AttributeValue): this;
  setAttributes(attributes: Attributes): this;
  addEvent(name: string, attributesOrStartTime?: Attributes | TimeInput, startTime?: TimeInput): this;
  addLink(link: Link): this;
  addLinks(links: Link[]): this;
  setStatus(status: SpanStatus): this;
  updateName(name: string): this;
  end(endTime?: TimeInput): void;
  isRecording(): boolean;
  recordException(exception: Exception, time?: TimeInput): void;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions, context?: Context): Span;
  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>;
}

export interface TracerProvider {
  getTracer(name: string, version?: string, options?: { schemaUrl?: string }): Tracer;
}

const INVALID_TRACE_ID = "00000000000000000000000000000000";
const INVALID_SPAN_ID = "0000000000000000";

export function isSpanContextValid(spanContext: SpanContext): boolean {
  return (
    /^[0-9a-f]{32}$/i.test(spanContext.traceId) &&
    spanContext.traceId !== INVALID_TRACE_ID &&
    /^[0-9a-f]{16}$/i.test(spanContext.spanId) &&
    spanContext.spanId !== INVALID_SPAN_ID
  );
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isTimeInput(value: unknown): value is TimeInput {
  return typeof value === "number" || value instanceof Date || Array.isArray(value);
}

/** Span that only carries a context, e.g. a remote parent from `traceparent`. */
class NonRecordingSpan implements Span {
  constructor(private readonly context: SpanContext) {}
  spanContext(): SpanContext {
    return this.context;
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  updateName(): this {
    return this;
  }
  end(): void {}
  isRecording(): boolean {
    return false;
  }
  recordException(): void {}
}

interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: Attributes;
}

/** Hooks set by the runtime entry (node, browser, cloudflare). */
export interface RuntimeHooks {
  /** Enrich a span right after it starts (baggage, parent request attrs, session ids). */
  onSpanStart?(span: RecordingSpan, parentContext: Context): void;
  /** Enrich log attributes at emit time. */
  onLogEmit?(attributes: Attributes, ctx: Context): void;
  /** Called after every queued record, e.g. to register a waitUntil flush. */
  afterRecord?(): void;
  /** Wrap startActiveSpan, e.g. to mirror spans into Cloudflare native tracing. */
  wrapActiveSpan?<T>(name: string, run: (mirror?: SpanMirror) => T): T;
}

/** Receives scalar attributes of an active span, e.g. a Cloudflare native span. */
export interface SpanMirror {
  setAttribute(key: string, value: string | number | boolean | undefined): void;
}

export const runtimeHooks: RuntimeHooks = {};

const SPAN_FLAGS_HAS_IS_REMOTE = 0x100;
const SPAN_FLAGS_IS_REMOTE = 0x200;

export class RecordingSpan implements Span {
  readonly attributes: Attributes = {};
  readonly events: SpanEvent[] = [];
  readonly links: Link[] = [];
  readonly startTimeUnixNano: string;
  readonly parentSpanContext: SpanContext | undefined;
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  ended = false;
  mirror: SpanMirror | undefined;
  readonly #context: SpanContext;

  constructor(
    public name: string,
    readonly kind: SpanKind,
    readonly scope: string,
    parent: SpanContext | undefined,
    options: SpanOptions,
  ) {
    this.parentSpanContext = parent;
    this.#context = {
      traceId: parent?.traceId ?? randomHex(16),
      spanId: randomHex(8),
      traceFlags: TraceFlags.SAMPLED,
      ...(parent?.traceState ? { traceState: parent.traceState } : {}),
    };
    this.startTimeUnixNano = options.startTime === undefined ? nowUnixNano() : timeToUnixNano(options.startTime);
    this.setAttributes(options.attributes ?? {});
    this.links.push(...(options.links ?? []));
  }

  spanContext(): SpanContext {
    return this.#context;
  }

  setAttribute(key: string, value: AttributeValue | undefined): this {
    if (this.ended || value === undefined) return this;
    this.attributes[key] = value;
    if (typeof value !== "object") this.mirror?.setAttribute(key, value);
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes)) {
      this.setAttribute(key, value);
    }
    return this;
  }

  addEvent(name: string, attributesOrStartTime?: Attributes | TimeInput, startTime?: TimeInput): this {
    if (this.ended) return this;
    const time = isTimeInput(attributesOrStartTime) ? attributesOrStartTime : startTime;
    const attributes = isTimeInput(attributesOrStartTime) ? {} : (attributesOrStartTime ?? {});
    this.events.push({ name, attributes, timeUnixNano: time === undefined ? nowUnixNano() : timeToUnixNano(time) });
    return this;
  }

  addLink(link: Link): this {
    this.links.push(link);
    return this;
  }

  addLinks(links: Link[]): this {
    this.links.push(...links);
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (!this.ended) this.status = status;
    return this;
  }

  updateName(name: string): this {
    if (!this.ended) this.name = name;
    return this;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  recordException(exception: Exception, time?: TimeInput): void {
    const attributes: Attributes = (() => {
      if (typeof exception === "string") return { "exception.message": exception };
      return {
        "exception.type": exception.name ?? (exception as { code?: string | number }).code?.toString(),
        "exception.message": exception.message,
        "exception.stacktrace": exception.stack,
      };
    })();
    this.addEvent("exception", attributes, time);
  }

  end(endTime?: TimeInput): void {
    if (this.ended) return;
    this.ended = true;
    const endTimeUnixNano = endTime === undefined ? nowUnixNano() : timeToUnixNano(endTime);
    const traceState = this.#context.traceState?.serialize();
    enqueueSpan(this.scope, {
      traceId: this.#context.traceId,
      spanId: this.#context.spanId,
      ...(traceState ? { traceState } : {}),
      ...(this.parentSpanContext ? { parentSpanId: this.parentSpanContext.spanId } : {}),
      // OTLP SpanFlags: bits 0-7 are W3C trace flags, bit 8 says bit 9 (parent is remote) is known.
      flags:
        (this.#context.traceFlags & 0xff) |
        SPAN_FLAGS_HAS_IS_REMOTE |
        (this.parentSpanContext?.isRemote ? SPAN_FLAGS_IS_REMOTE : 0),
      name: this.name,
      // OTLP enum is the API SpanKind + 1 (0 means unspecified).
      kind: this.kind + 1,
      startTimeUnixNano: this.startTimeUnixNano,
      endTimeUnixNano,
      attributes: toKeyValues(this.attributes),
      events: this.events.map((event) => ({
        name: event.name,
        timeUnixNano: event.timeUnixNano,
        attributes: toKeyValues(event.attributes),
      })),
      links: this.links.map((link) => {
        const linkTraceState = link.context.traceState?.serialize();
        return {
          traceId: link.context.traceId,
          spanId: link.context.spanId,
          ...(linkTraceState ? { traceState: linkTraceState } : {}),
          attributes: toKeyValues(link.attributes ?? {}),
        };
      }),
      status: this.status,
    });
    runtimeHooks.afterRecord?.();
  }

  [Symbol.dispose](): void {
    this.end();
  }
}

function getSpan(ctx: Context): Span | undefined {
  const value = ctx.getValue(SPAN_KEY);
  return value && typeof value === "object" && "spanContext" in value ? (value as Span) : undefined;
}

function setSpan(ctx: Context, span: Span): Context {
  return ctx.setValue(SPAN_KEY, span);
}

function createTracer(scope: string): Tracer {
  const startSpan = (name: string, options: SpanOptions = {}, ctx: Context = context.active()): Span => {
    const parentContext = options.root ? ctx.deleteValue(SPAN_KEY) : ctx;
    const parent = getSpan(parentContext)?.spanContext();
    const validParent = parent && isSpanContextValid(parent) ? parent : undefined;
    const span = new RecordingSpan(name, options.kind ?? SpanKind.INTERNAL, scope, validParent, options);
    runtimeHooks.onSpanStart?.(span, parentContext);
    return span;
  };

  function startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    ...rest: [F] | [SpanOptions, F] | [SpanOptions, Context, F]
  ): ReturnType<F> {
    const fn = rest[rest.length - 1] as F;
    const options = rest.length > 1 ? (rest[0] as SpanOptions) : {};
    const parentContext = rest.length > 2 ? (rest[1] as Context) : context.active();
    const run = (mirror?: SpanMirror) => {
      const span = startSpan(name, options, parentContext);
      if (mirror && span instanceof RecordingSpan) {
        span.mirror = mirror;
        for (const [key, value] of Object.entries(span.attributes)) {
          if (value !== undefined && typeof value !== "object") mirror.setAttribute(key, value);
        }
      }
      return context.with(setSpan(parentContext, span), () => fn(span)) as ReturnType<F>;
    };
    return runtimeHooks.wrapActiveSpan ? runtimeHooks.wrapActiveSpan(name, run) : run();
  }

  return { startSpan, startActiveSpan: startActiveSpan as Tracer["startActiveSpan"] };
}

const tracers = new Map<string, Tracer>();

export const tracerProvider: TracerProvider = {
  getTracer(name: string): Tracer {
    const existing = tracers.get(name);
    if (existing) return existing;
    const created = createTracer(name);
    tracers.set(name, created);
    return created;
  },
};

export const trace = {
  getTracer(name: string, version?: string): Tracer {
    return tracerProvider.getTracer(name, version);
  },
  getTracerProvider(): TracerProvider {
    return tracerProvider;
  },
  getSpan,
  setSpan,
  getActiveSpan(): Span | undefined {
    return getSpan(context.active());
  },
  deleteSpan(ctx: Context): Context {
    return ctx.deleteValue(SPAN_KEY);
  },
  getSpanContext(ctx: Context): SpanContext | undefined {
    return getSpan(ctx)?.spanContext();
  },
  setSpanContext(ctx: Context, spanContext: SpanContext): Context {
    return setSpan(ctx, new NonRecordingSpan(spanContext));
  },
  wrapSpanContext(spanContext: SpanContext): Span {
    return new NonRecordingSpan(spanContext);
  },
  isSpanContextValid,
};

// ---------------------------------------------------------------------------
// Baggage and W3C propagation
// ---------------------------------------------------------------------------

export interface BaggageEntry {
  value: string;
  metadata?: unknown;
}

export interface Baggage {
  getEntry(key: string): BaggageEntry | undefined;
  getAllEntries(): [string, BaggageEntry][];
  setEntry(key: string, entry: BaggageEntry): Baggage;
  removeEntry(key: string): Baggage;
  removeEntries(...keys: string[]): Baggage;
  clear(): Baggage;
}

class BaggageImpl implements Baggage {
  readonly #entries: Map<string, BaggageEntry>;

  constructor(entries?: Map<string, BaggageEntry>) {
    this.#entries = entries ? new Map(entries) : new Map();
  }

  getEntry(key: string): BaggageEntry | undefined {
    const entry = this.#entries.get(key);
    return entry ? { ...entry } : undefined;
  }

  getAllEntries(): [string, BaggageEntry][] {
    return Array.from(this.#entries.entries()).map(([key, entry]) => [key, { ...entry }]);
  }

  setEntry(key: string, entry: BaggageEntry): Baggage {
    const next = new BaggageImpl(this.#entries);
    next.#entries.set(key, entry);
    return next;
  }

  removeEntry(key: string): Baggage {
    const next = new BaggageImpl(this.#entries);
    next.#entries.delete(key);
    return next;
  }

  removeEntries(...keys: string[]): Baggage {
    const next = new BaggageImpl(this.#entries);
    for (const key of keys) next.#entries.delete(key);
    return next;
  }

  clear(): Baggage {
    return new BaggageImpl();
  }
}

export interface TextMapGetter<Carrier> {
  keys(carrier: Carrier): string[];
  get(carrier: Carrier, key: string): undefined | string | string[];
}

export interface TextMapSetter<Carrier> {
  set(carrier: Carrier, key: string, value: string): void;
}

export interface TextMapPropagator<Carrier = unknown> {
  inject(context: Context, carrier: Carrier, setter: TextMapSetter<Carrier>): void;
  extract(context: Context, carrier: Carrier, getter: TextMapGetter<Carrier>): Context;
  fields(): string[];
}

type HeadersLike = { get(name: string): string | null; set(name: string, value: string): void };

function isHeadersLike(carrier: unknown): carrier is HeadersLike {
  return (
    typeof carrier === "object" &&
    carrier !== null &&
    typeof (carrier as HeadersLike).get === "function" &&
    typeof (carrier as HeadersLike).set === "function"
  );
}

/** Same as OTel's default getter, plus `Headers` support. */
export const defaultTextMapGetter: TextMapGetter<unknown> = {
  keys(carrier) {
    if (typeof Headers !== "undefined" && carrier instanceof Headers) return Array.from(carrier.keys());
    return carrier && typeof carrier === "object" ? Object.keys(carrier) : [];
  },
  get(carrier, key) {
    if (isHeadersLike(carrier)) return carrier.get(key) ?? undefined;
    if (!carrier || typeof carrier !== "object") return undefined;
    const record = carrier as Record<string, unknown>;
    const value = record[key] ?? record[key.toLowerCase()];
    return typeof value === "string" || Array.isArray(value) ? (value as string | string[]) : undefined;
  },
};

/** Same as OTel's default setter, plus `Headers` support. */
export const defaultTextMapSetter: TextMapSetter<unknown> = {
  set(carrier, key, value) {
    if (isHeadersLike(carrier)) {
      carrier.set(key, value);
      return;
    }
    if (carrier && typeof carrier === "object") (carrier as Record<string, string>)[key] = value;
  },
};

const TRACEPARENT = "traceparent";
const TRACESTATE = "tracestate";
const BAGGAGE = "baggage";
// Group 5 is the suffix future versions may add. Version 00 must not have one.
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const MAX_BAGGAGE_LENGTH = 8192;

function firstHeader(value: undefined | string | string[]): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}

/** W3C Trace Context + W3C Baggage in one propagator. */
export const w3cPropagator: TextMapPropagator<unknown> = {
  inject(ctx, carrier, setter) {
    const spanContext = getSpan(ctx)?.spanContext();
    if (spanContext && isSpanContextValid(spanContext)) {
      const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, "0");
      setter.set(carrier, TRACEPARENT, `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`);
      const traceState = spanContext.traceState?.serialize();
      if (traceState) setter.set(carrier, TRACESTATE, traceState);
    }
    const baggage = ctx.getValue(BAGGAGE_KEY) as Baggage | undefined;
    const pairs = (baggage?.getAllEntries() ?? []).map(([key, entry]) => {
      return `${encodeURIComponent(key)}=${encodeURIComponent(entry.value)}`;
    });
    const header = pairs.join(",");
    if (header && header.length <= MAX_BAGGAGE_LENGTH) setter.set(carrier, BAGGAGE, header);
  },
  extract(ctx, carrier, getter) {
    const withSpan = (() => {
      const match = TRACEPARENT_RE.exec(firstHeader(getter.get(carrier, TRACEPARENT))?.trim() ?? "");
      if (!match || match[1] === "ff" || (match[1] === "00" && match[5] !== undefined)) return ctx;
      const traceState = firstHeader(getter.get(carrier, TRACESTATE));
      const spanContext: SpanContext = {
        traceId: match[2]!,
        spanId: match[3]!,
        traceFlags: parseInt(match[4]!, 16),
        isRemote: true,
        ...(traceState ? { traceState: createTraceState(traceState) } : {}),
      };
      return isSpanContextValid(spanContext) ? setSpan(ctx, new NonRecordingSpan(spanContext)) : ctx;
    })();
    const header = firstHeader(getter.get(carrier, BAGGAGE));
    if (!header) return withSpan;
    const entries = header.split(",").flatMap((pair): Array<[string, BaggageEntry]> => {
      const [rawKey, ...rest] = pair.split(";")[0]!.split("=");
      const key = rawKey?.trim();
      if (!key || rest.length === 0) return [];
      try {
        return [[decodeURIComponent(key), { value: decodeURIComponent(rest.join("=").trim()) }]];
      } catch {
        return [];
      }
    });
    if (entries.length === 0) return withSpan;
    return withSpan.setValue(BAGGAGE_KEY, new BaggageImpl(new Map(entries)));
  },
  fields() {
    return [TRACEPARENT, TRACESTATE, BAGGAGE];
  },
};

export const propagation = {
  inject<Carrier>(ctx: Context, carrier: Carrier, setter: TextMapSetter<Carrier> = defaultTextMapSetter): void {
    w3cPropagator.inject(ctx, carrier, setter as TextMapSetter<unknown>);
  },
  extract<Carrier>(ctx: Context, carrier: Carrier, getter: TextMapGetter<Carrier> = defaultTextMapGetter): Context {
    return w3cPropagator.extract(ctx, carrier, getter as TextMapGetter<unknown>);
  },
  fields(): string[] {
    return w3cPropagator.fields();
  },
  getBaggage(ctx: Context): Baggage | undefined {
    return ctx.getValue(BAGGAGE_KEY) as Baggage | undefined;
  },
  getActiveBaggage(): Baggage | undefined {
    return context.active().getValue(BAGGAGE_KEY) as Baggage | undefined;
  },
  setBaggage(ctx: Context, baggage: Baggage): Context {
    return ctx.setValue(BAGGAGE_KEY, baggage);
  },
  deleteBaggage(ctx: Context): Context {
    return ctx.deleteValue(BAGGAGE_KEY);
  },
  createBaggage(entries: Record<string, BaggageEntry> = {}): Baggage {
    return new BaggageImpl(new Map(Object.entries(entries)));
  },
};

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/** Same values as `@opentelemetry/api-logs` SeverityNumber. */
export const SeverityNumber = {
  UNSPECIFIED: 0,
  TRACE: 1,
  TRACE2: 2,
  TRACE3: 3,
  TRACE4: 4,
  DEBUG: 5,
  DEBUG2: 6,
  DEBUG3: 7,
  DEBUG4: 8,
  INFO: 9,
  INFO2: 10,
  INFO3: 11,
  INFO4: 12,
  WARN: 13,
  WARN2: 14,
  WARN3: 15,
  WARN4: 16,
  ERROR: 17,
  ERROR2: 18,
  ERROR3: 19,
  ERROR4: 20,
  FATAL: 21,
  FATAL2: 22,
  FATAL3: 23,
  FATAL4: 24,
} as const;
export type SeverityNumber = (typeof SeverityNumber)[keyof typeof SeverityNumber];

export type LogBody = string | number | boolean | null | undefined | LogBody[] | { [key: string]: LogBody } | Uint8Array;

export interface LogRecord {
  eventName?: string;
  timestamp?: TimeInput;
  observedTimestamp?: TimeInput;
  severityNumber?: SeverityNumber;
  severityText?: string;
  body?: LogBody;
  attributes?: Attributes;
  context?: Context;
}

export interface Logger {
  emit(logRecord: LogRecord): void;
}

export interface LoggerProvider {
  getLogger(name: string, version?: string, options?: { schemaUrl?: string }): Logger;
}

function createLogger(scope: string): Logger {
  return {
    emit(record) {
      const ctx = record.context ?? context.active();
      const attributes: Attributes = { ...record.attributes };
      runtimeHooks.onLogEmit?.(attributes, ctx);
      const spanContext = getSpan(ctx)?.spanContext();
      const validSpan = spanContext && isSpanContextValid(spanContext) ? spanContext : undefined;
      const time = record.timestamp === undefined ? nowUnixNano() : timeToUnixNano(record.timestamp);
      enqueueLog(scope, {
        timeUnixNano: time,
        observedTimeUnixNano: record.observedTimestamp === undefined ? time : timeToUnixNano(record.observedTimestamp),
        severityNumber: record.severityNumber ?? SeverityNumber.UNSPECIFIED,
        ...(record.severityText ? { severityText: record.severityText } : {}),
        ...(record.body === undefined ? {} : { body: toAnyValue(record.body) }),
        ...(record.eventName ? { eventName: record.eventName } : {}),
        ...(validSpan ? { traceId: validSpan.traceId, spanId: validSpan.spanId, flags: validSpan.traceFlags } : {}),
        attributes: toKeyValues(attributes),
      });
      runtimeHooks.afterRecord?.();
    },
  };
}

const loggers = new Map<string, Logger>();

export const loggerProvider: LoggerProvider = {
  getLogger(name: string): Logger {
    const existing = loggers.get(name);
    if (existing) return existing;
    const created = createLogger(name);
    loggers.set(name, created);
    return created;
  },
};

export const logs = {
  getLogger(name: string, version?: string): Logger {
    return loggerProvider.getLogger(name, version);
  },
  getLoggerProvider(): LoggerProvider {
    return loggerProvider;
  },
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
// Cumulative temporality (OTel's OTLP default). Each attribute set keeps a
// running series. Observable instruments are read on every collection.

export interface MetricOptions {
  description?: string;
  unit?: string;
  advice?: { explicitBucketBoundaries?: number[] };
}

export interface Counter {
  add(value: number, attributes?: Attributes, context?: Context): void;
}
export type UpDownCounter = Counter;
export interface Histogram {
  record(value: number, attributes?: Attributes, context?: Context): void;
}
export type Gauge = Histogram;

export interface ObservableResult {
  observe(value: number, attributes?: Attributes): void;
}
export type ObservableCallback = (result: ObservableResult) => void | Promise<void>;
export interface Observable {
  addCallback(callback: ObservableCallback): void;
  removeCallback(callback: ObservableCallback): void;
}

export interface BatchObservableResult {
  observe(observable: Observable, value: number, attributes?: Attributes): void;
}
export type BatchObservableCallback = (result: BatchObservableResult) => void | Promise<void>;

export interface Meter {
  createCounter(name: string, options?: MetricOptions): Counter;
  createUpDownCounter(name: string, options?: MetricOptions): UpDownCounter;
  createHistogram(name: string, options?: MetricOptions): Histogram;
  createGauge(name: string, options?: MetricOptions): Gauge;
  createObservableCounter(name: string, options?: MetricOptions): Observable;
  createObservableUpDownCounter(name: string, options?: MetricOptions): Observable;
  createObservableGauge(name: string, options?: MetricOptions): Observable;
  addBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void;
  removeBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void;
}

export interface MeterProvider {
  getMeter(name: string, version?: string, options?: { schemaUrl?: string }): Meter;
}

/** OTel SDK default explicit bucket boundaries. */
const DEFAULT_BUCKETS = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];
const CUMULATIVE = 2;

type InstrumentKind = "counter" | "upDownCounter" | "histogram" | "gauge";

interface Series {
  attributes: OtlpKeyValue[];
  startTimeUnixNano: string;
  value: number;
  count: number;
  min: number;
  max: number;
  buckets: number[];
}

interface Instrument {
  name: string;
  kind: InstrumentKind;
  options: MetricOptions;
  bounds: number[];
  series: Map<string, Series>;
  callbacks: Set<ObservableCallback>;
  observable: boolean;
}

function seriesKey(attributes: Attributes): string {
  return JSON.stringify(Object.entries(attributes).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}

function recordValue(instrument: Instrument, value: number, attributes: Attributes = {}): void {
  // Same as logs and spans: nothing accumulates while the SDK is not exporting.
  if (!isExporting() || !Number.isFinite(value)) return;
  if (instrument.kind === "counter" && value < 0 && !instrument.observable) return;
  const key = seriesKey(attributes);
  const series = instrument.series.get(key) ?? {
    attributes: toKeyValues(attributes),
    startTimeUnixNano: nowUnixNano(),
    value: 0,
    count: 0,
    min: Infinity,
    max: -Infinity,
    buckets: new Array(instrument.bounds.length + 1).fill(0),
  };
  instrument.series.set(key, series);
  if (instrument.kind === "histogram") {
    series.count++;
    series.value += value;
    series.min = Math.min(series.min, value);
    series.max = Math.max(series.max, value);
    const index = instrument.bounds.findIndex((bound) => value <= bound);
    series.buckets[index === -1 ? instrument.bounds.length : index]!++;
    return;
  }
  // Observable counters report the current cumulative total, gauges the last value.
  series.value = instrument.kind === "gauge" || instrument.observable ? value : series.value + value;
}

function numberPoint(value: number): { asInt: string } | { asDouble: number } {
  return Number.isInteger(value) ? { asInt: String(value) } : { asDouble: value };
}

function toOtlpMetric(instrument: Instrument, timeUnixNano: string): OtlpMetric | undefined {
  const series = Array.from(instrument.series.values());
  if (series.length === 0) return undefined;
  const base = {
    name: instrument.name,
    ...(instrument.options.description ? { description: instrument.options.description } : {}),
    ...(instrument.options.unit ? { unit: instrument.options.unit } : {}),
  };
  if (instrument.kind === "histogram") {
    return {
      ...base,
      histogram: {
        aggregationTemporality: CUMULATIVE,
        dataPoints: series.map((point) => ({
          attributes: point.attributes,
          startTimeUnixNano: point.startTimeUnixNano,
          timeUnixNano,
          count: String(point.count),
          sum: point.value,
          bucketCounts: point.buckets.map(String),
          explicitBounds: instrument.bounds,
          ...(point.count > 0 ? { min: point.min, max: point.max } : {}),
        })),
      },
    };
  }
  const dataPoints = series.map((point) => ({
    attributes: point.attributes,
    startTimeUnixNano: point.startTimeUnixNano,
    timeUnixNano,
    ...numberPoint(point.value),
  }));
  if (instrument.kind === "gauge") return { ...base, gauge: { dataPoints } };
  return {
    ...base,
    sum: { aggregationTemporality: CUMULATIVE, isMonotonic: instrument.kind === "counter", dataPoints },
  };
}

const meters = new Map<string, Meter>();

function createMeter(scope: string): Meter {
  const instruments: Instrument[] = [];
  const batchCallbacks = new Map<BatchObservableCallback, Set<Observable>>();
  const observableToInstrument = new WeakMap<Observable, Instrument>();

  const addInstrument = (name: string, kind: InstrumentKind, options: MetricOptions = {}, observable = false) => {
    const instrument: Instrument = {
      name,
      kind,
      options,
      bounds: options.advice?.explicitBucketBoundaries ?? DEFAULT_BUCKETS,
      series: new Map(),
      callbacks: new Set(),
      observable,
    };
    instruments.push(instrument);
    return instrument;
  };

  const createObservable = (name: string, kind: InstrumentKind, options?: MetricOptions): Observable => {
    const instrument = addInstrument(name, kind, options, true);
    const observable: Observable = {
      addCallback(callback) {
        instrument.callbacks.add(callback);
      },
      removeCallback(callback) {
        instrument.callbacks.delete(callback);
      },
    };
    observableToInstrument.set(observable, instrument);
    return observable;
  };

  const collect = async () => {
    await Promise.all(
      instruments.flatMap((instrument) =>
        Array.from(instrument.callbacks, (callback) =>
          Promise.resolve(
            callback({
              observe(value, attributes) {
                recordValue(instrument, value, attributes);
              },
            }),
          ).catch(() => undefined),
        ),
      ),
    );
    await Promise.all(
      Array.from(batchCallbacks.keys(), (callback) =>
        Promise.resolve(
          callback({
            observe(observable, value, attributes) {
              const instrument = observableToInstrument.get(observable);
              if (instrument) recordValue(instrument, value, attributes);
            },
          }),
        ).catch(() => undefined),
      ),
    );
    const time = nowUnixNano();
    const metrics = instruments.flatMap((instrument) => {
      const metric = toOtlpMetric(instrument, time);
      return metric ? [metric] : [];
    });
    return metrics.length > 0 ? { scope, metrics } : undefined;
  };
  // Cumulative series belong to one pipeline session. A later initStrada()
  // starts every series from zero with a new start time.
  const reset = () => {
    for (const instrument of instruments) instrument.series.clear();
  };
  registerMetricsCollector({ collect, reset });

  return {
    createCounter(name, options) {
      const instrument = addInstrument(name, "counter", options);
      return { add: (value, attributes) => recordValue(instrument, value, attributes) };
    },
    createUpDownCounter(name, options) {
      const instrument = addInstrument(name, "upDownCounter", options);
      return { add: (value, attributes) => recordValue(instrument, value, attributes) };
    },
    createHistogram(name, options) {
      const instrument = addInstrument(name, "histogram", options);
      return { record: (value, attributes) => recordValue(instrument, value, attributes) };
    },
    createGauge(name, options) {
      const instrument = addInstrument(name, "gauge", options);
      return { record: (value, attributes) => recordValue(instrument, value, attributes) };
    },
    createObservableCounter(name, options) {
      return createObservable(name, "counter", options);
    },
    createObservableUpDownCounter(name, options) {
      return createObservable(name, "upDownCounter", options);
    },
    createObservableGauge(name, options) {
      return createObservable(name, "gauge", options);
    },
    addBatchObservableCallback(callback, observables) {
      batchCallbacks.set(callback, new Set(observables));
    },
    removeBatchObservableCallback(callback) {
      batchCallbacks.delete(callback);
    },
  };
}

export const meterProvider: MeterProvider = {
  getMeter(name: string): Meter {
    const existing = meters.get(name);
    if (existing) return existing;
    const created = createMeter(name);
    meters.set(name, created);
    return created;
  },
};

export const metrics = {
  getMeter(name: string, version?: string): Meter {
    return meterProvider.getMeter(name, version);
  },
  getMeterProvider(): MeterProvider {
    return meterProvider;
  },
};
