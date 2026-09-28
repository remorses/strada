/**
 * OTLP/HTTP JSON export pipeline. Zero dependencies: records are encoded by
 * hand and POSTed with `fetch` to `/v1/logs`, `/v1/traces`, `/v1/metrics`.
 *
 * - Batching: logs and spans queue until `scheduledDelayMillis` (default 5s)
 *   or `maxExportBatchSize` (default 512). Metrics are collected every
 *   `exportIntervalMillis` (default 10s) once an instrument exists.
 * - Timers are unref'd: telemetry never keeps a CLI or server process alive.
 *   Runtime entries flush on exit (`beforeExit`) or per request (`waitUntil`).
 * - Connections: every response body is read so `fetch` returns the socket
 *   to its keep-alive pool, and the three endpoints are sent one after the
 *   other so they reuse the same connection instead of opening parallel ones.
 * - Telemetry never throws: failures are warned once and returned as values.
 * - `invocationScoped` (Cloudflare Workers): no timers, and each flush sends
 *   on its own instead of waiting for earlier flushes. Workers bind promises
 *   and I/O to the request that created them, so a flush in request B must
 *   never wait on a fetch started by request A. Metrics send only series that
 *   changed since the last export.
 */

const warnedMessages = new Set<string>();
const MAX_WARNED_MESSAGES = 200;

/** console.warn each distinct message once. Never throws, even with a broken console. */
export function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  if (warnedMessages.size >= MAX_WARNED_MESSAGES) warnedMessages.clear();
  warnedMessages.add(message);
  try {
    globalThis.console?.warn?.(message);
  } catch {
    // nothing left to do, the console itself is broken
  }
}

export function resetWarnings(): void {
  warnedMessages.clear();
}

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
  bytesValue?: string;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText?: string;
  body?: OtlpAnyValue;
  eventName?: string;
  traceId?: string;
  spanId?: string;
  flags?: number;
  attributes: OtlpKeyValue[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  traceState?: string;
  parentSpanId?: string;
  flags: number;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: Array<{ name: string; timeUnixNano: string; attributes: OtlpKeyValue[] }>;
  links: Array<{ traceId: string; spanId: string; traceState?: string; attributes: OtlpKeyValue[] }>;
  status: { code: number; message?: string };
}

export type OtlpMetric = { name: string; description?: string; unit?: string } & Record<string, unknown>;

export interface BatchOptions {
  /** Delay between automatic flushes. Default 5000ms (500ms in dev mode). */
  scheduledDelayMillis?: number;
  /** Flush as soon as this many records are queued. Default 512. */
  maxExportBatchSize?: number;
  /** Drop new records above this many queued. Default 2048. */
  maxQueueSize?: number;
  /** Abort an export request after this long. Default 30000ms. */
  exportTimeoutMillis?: number;
}

export interface MetricExportOptions {
  /** Collection and export interval. Default 10000ms (2000ms in dev mode). */
  exportIntervalMillis?: number;
  /** Abort an export request after this long. Default 30000ms. */
  exportTimeoutMillis?: number;
}

export interface PipelineConfig {
  /** Base ingest URL without trailing slash. Empty disables export. */
  endpoint: string;
  headers: Record<string, string>;
  resource: OtlpKeyValue[];
  logs: Required<BatchOptions>;
  traces: Required<BatchOptions>;
  metrics: Required<MetricExportOptions>;
  /** Cloudflare Workers: the runtime flushes per invocation. See file comment. */
  invocationScoped?: boolean;
}

interface MetricsCollector {
  /** `changedOnly`: return only series recorded since the previous collect. */
  collect(options: { changedOnly: boolean }): Promise<{ scope: string; metrics: OtlpMetric[] } | undefined>;
  /** Drop accumulated series when the pipeline stops. */
  reset(): void;
}

interface Queued<T> {
  scope: string;
  record: T;
}

let config: PipelineConfig | undefined;
let logQueue: Array<Queued<OtlpLogRecord>> = [];
let spanQueue: Array<Queued<OtlpSpan>> = [];
let batchTimer: ReturnType<typeof setTimeout> | undefined;
let metricsTimer: ReturnType<typeof setInterval> | undefined;
let inflight: Promise<Error | undefined> = Promise.resolve(undefined);
const metricsCollectors: MetricsCollector[] = [];

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function toAnyValue(value: unknown): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  if (typeof value === "bigint") return { intValue: value.toString() };
  if (value instanceof Uint8Array) return { bytesValue: btoa(String.fromCharCode(...value)) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toAnyValue) } };
  if (value && typeof value === "object") {
    return { kvlistValue: { values: toKeyValues(value as Record<string, unknown>) } };
  }
  return {};
}

export function toKeyValues(record: Record<string, unknown>): OtlpKeyValue[] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    return [{ key, value: toAnyValue(value) }];
  });
}

function hrNowMillis(): number {
  const perf = globalThis.performance;
  return perf && typeof perf.timeOrigin === "number" ? perf.timeOrigin + perf.now() : Date.now();
}

function millisToUnixNano(millis: number): string {
  return (BigInt(Math.floor(millis)) * 1_000_000n + BigInt(Math.round((millis % 1) * 1_000_000))).toString();
}

export function nowUnixNano(): string {
  return millisToUnixNano(hrNowMillis());
}

/** Accepts epoch millis, a Date, or an OTel HrTime `[seconds, nanoseconds]`. */
export function timeToUnixNano(time: number | Date | [number, number]): string {
  if (Array.isArray(time)) return (BigInt(time[0]) * 1_000_000_000n + BigInt(time[1])).toString();
  if (time instanceof Date) return millisToUnixNano(time.getTime());
  return millisToUnixNano(time);
}

// ---------------------------------------------------------------------------
// Pipeline lifecycle
// ---------------------------------------------------------------------------

/** Node and Bun timers have unref(); browsers and Workers return plain ids. */
function unref(timer: unknown): void {
  if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

export function startPipeline(next: PipelineConfig): void {
  config = next;
  if (metricsCollectors.length > 0) startMetricsTimer();
}

/** Stop exporting and drop queued records. Used by shutdown() and tests. */
export function stopPipeline(): void {
  clearTimeout(batchTimer);
  clearInterval(metricsTimer);
  batchTimer = undefined;
  metricsTimer = undefined;
  config = undefined;
  logQueue = [];
  spanQueue = [];
  for (const collector of metricsCollectors) collector.reset();
}

/** Ingest origin, so HTTP instrumentation can skip the SDK's own export requests. */
export function getExportOrigin(): string | undefined {
  if (!config?.endpoint) return undefined;
  try {
    return new URL(config.endpoint).origin;
  } catch {
    return undefined;
  }
}

export function isExporting(): boolean {
  return Boolean(config?.endpoint);
}

function startMetricsTimer(): void {
  if (metricsTimer || !config?.endpoint || config.invocationScoped) return;
  metricsTimer = setInterval(() => {
    void flush({ includeMetrics: true });
  }, config.metrics.exportIntervalMillis);
  unref(metricsTimer);
}

export function registerMetricsCollector(collector: MetricsCollector): void {
  metricsCollectors.push(collector);
  startMetricsTimer();
}

function scheduleBatch(): void {
  // Invocation-scoped runtimes flush from runtimeHooks.afterRecord.
  if (!config || config.invocationScoped) return;
  const logsFull = logQueue.length >= config.logs.maxExportBatchSize;
  const spansFull = spanQueue.length >= config.traces.maxExportBatchSize;
  if (logsFull || spansFull) {
    void flush();
    return;
  }
  if (batchTimer) return;
  batchTimer = setTimeout(
    () => {
      batchTimer = undefined;
      void flush();
    },
    Math.min(config.logs.scheduledDelayMillis, config.traces.scheduledDelayMillis),
  );
  unref(batchTimer);
}

export function enqueueLog(scope: string, record: OtlpLogRecord): void {
  if (!config?.endpoint) return;
  if (logQueue.length >= config.logs.maxQueueSize) {
    warnOnce("[@strada.sh/sdk] log queue full, dropping telemetry");
    return;
  }
  logQueue.push({ scope, record });
  scheduleBatch();
}

export function enqueueSpan(scope: string, record: OtlpSpan): void {
  if (!config?.endpoint) return;
  if (spanQueue.length >= config.traces.maxQueueSize) {
    warnOnce("[@strada.sh/sdk] span queue full, dropping telemetry");
    return;
  }
  spanQueue.push({ scope, record });
  scheduleBatch();
}

function groupByScope<T>(queued: Array<Queued<T>>): Array<{ scope: { name: string }; records: T[] }> {
  const scopes = [...new Set(queued.map((item) => item.scope))];
  return scopes.map((name) => ({
    scope: { name },
    records: queued.filter((item) => item.scope === name).map((item) => item.record),
  }));
}

async function post(current: PipelineConfig, path: string, body: object, timeoutMillis: number): Promise<Error | undefined> {
  try {
    const payload = JSON.stringify(body);
    const response = await fetch(`${current.endpoint}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...current.headers },
      body: payload,
      // Lets a browser flush on page hide survive the unload. Browsers reject
      // keepalive bodies above 64 KiB (bytes, not characters), so large batches go without it.
      keepalive: typeof document !== "undefined" && new TextEncoder().encode(payload).byteLength < 60_000,
      signal: AbortSignal.timeout(timeoutMillis),
    });
    // Read the body so fetch returns the socket to its keep-alive pool.
    // An unread body pins the socket and the next flush opens a new connection.
    await response.arrayBuffer();
    if (!response.ok) {
      const error = new Error(`Strada ingest ${path} responded ${response.status}`);
      warnOnce(`[@strada.sh/sdk] ${error.message}`);
      return error;
    }
    return undefined;
  } catch (cause) {
    const error = new Error(`Strada ingest ${path} request failed`, { cause });
    warnOnce(`[@strada.sh/sdk] ${error.message}`);
    return error;
  }
}

async function send({
  current,
  logs,
  spans,
  includeMetrics,
}: {
  current: PipelineConfig;
  logs: Array<Queued<OtlpLogRecord>>;
  spans: Array<Queued<OtlpSpan>>;
  includeMetrics: boolean;
}): Promise<Error | undefined> {
  const resource = { attributes: current.resource };
  // Sequential on purpose: parallel requests to one origin open extra connections.
  const logsError =
    logs.length > 0
      ? await post(current, "/v1/logs", {
          resourceLogs: [
            {
              resource,
              scopeLogs: groupByScope(logs).map(({ scope, records }) => ({ scope, logRecords: records })),
            },
          ],
        }, current.logs.exportTimeoutMillis)
      : undefined;
  const spansError =
    spans.length > 0
      ? await post(current, "/v1/traces", {
          resourceSpans: [
            {
              resource,
              scopeSpans: groupByScope(spans).map(({ scope, records }) => ({ scope, spans: records })),
            },
          ],
        }, current.traces.exportTimeoutMillis)
      : undefined;
  const metricsError = await (async () => {
    if (!includeMetrics || metricsCollectors.length === 0) return undefined;
    const changedOnly = Boolean(current.invocationScoped);
    const scopeMetrics = (await Promise.all(metricsCollectors.map((collector) => collector.collect({ changedOnly }).catch(() => undefined))))
      .flatMap((collected) => (collected ? [{ scope: { name: collected.scope }, metrics: collected.metrics }] : []));
    if (scopeMetrics.length === 0) return undefined;
    return post(current, "/v1/metrics", { resourceMetrics: [{ resource, scopeMetrics }] }, current.metrics.exportTimeoutMillis);
  })();
  return logsError ?? spansError ?? metricsError;
}

/**
 * Send everything queued. Resolves after all earlier flushes finished.
 * Metrics are collected on their own interval and on explicit flush.
 */
export function flush({ includeMetrics = true }: { includeMetrics?: boolean } = {}): Promise<Error | undefined> {
  const current = config;
  if (!current?.endpoint) return inflight;
  clearTimeout(batchTimer);
  batchTimer = undefined;
  const logs = logQueue;
  const spans = spanQueue;
  logQueue = [];
  spanQueue = [];
  if (current.invocationScoped) {
    if (logs.length === 0 && spans.length === 0 && (!includeMetrics || metricsCollectors.length === 0)) {
      return Promise.resolve(undefined);
    }
    return send({ current, logs, spans, includeMetrics });
  }
  if (logs.length === 0 && spans.length === 0 && (!includeMetrics || metricsCollectors.length === 0)) {
    return inflight;
  }
  inflight = inflight.then(() => send({ current, logs, spans, includeMetrics }));
  return inflight;
}

/**
 * Remove and return queued records without sending them. For tests and
 * debugging, like OTel's in-memory exporters.
 */
export function takeQueuedRecords(): {
  logs: Array<{ scope: string; record: OtlpLogRecord }>;
  spans: Array<{ scope: string; record: OtlpSpan }>;
} {
  const taken = { logs: logQueue, spans: spanQueue };
  logQueue = [];
  spanQueue = [];
  clearTimeout(batchTimer);
  batchTimer = undefined;
  return taken;
}
