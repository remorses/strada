/**
 * Browser entry for @strada.sh/sdk. Zero dependencies.
 *
 * Adds Strada web analytics on top of the shared client: session and visitor
 * ids, pageview spans (initial load + same-document navigations through the
 * Navigation API), window error listeners, and context injection into every
 * span and log record.
 *
 * Analytics model (website/src/docs/browser-analytics.mdx):
 * - Pageviews = spans in otel_traces (SpanName = 'pageview')
 * - Custom events = log records in otel_logs (event.name attribute)
 * - Session = one session.id per tab, stored in sessionStorage
 * - Visitor = one visitor.id per browser, cookie strada_vid
 * - user.id = signed-in account, cookie strada_uid
 *
 * No fetch/XHR patching. To send traceparent + baggage to your backend, call
 * `propagation.inject(context.active(), headers)` on the request, or register
 * `@opentelemetry/instrumentation-fetch` through `@strada.sh/sdk/otel`.
 *
 * Context does not survive `await` in browsers (synchronous stack), the same
 * limitation as OTel's StackContextManager. Work outside any span is
 * parented to the current pageview span.
 */

import {
  getContextManager,
  propagation,
  runtimeHooks,
  StackContextManager,
  setContextManager,
  trace,
  type Attributes,
  type Context,
  type ContextManager,
  type Span,
} from "./api.ts";
import { ATTR } from "./attrs.ts";
import { captureException, flush, shutdown as shutdownClient } from "./client.ts";
import {
  clearUserIdCookie,
  createStradaBaggage,
  createStradaLogger,
  getOptions,
  initCore,
  DEFAULT_USER_ID_COOKIE,
  DEFAULT_USER_ID_COOKIE_MAX_AGE,
  DEFAULT_VISITOR_COOKIE,
  normalizeError,
  readCookie,
  resetContext,
  resolveReleaseAttributes,
  resolveUserId,
  setRuntimeUserId,
  tryTelemetry,
  writeUserIdCookie,
  writeVisitorCookie,
  type StradaLogger,
  type StradaOptions,
  type StradaUserIdentity,
} from "./shared.ts";
import { logs } from "./api.ts";

export * from "./client.ts";

const SESSION_STORAGE_KEY = "strada.session_id";

function getOrCreateSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
    return id;
  } catch {
    // sessionStorage blocked (sandboxed iframe, privacy mode)
    return crypto.randomUUID();
  }
}

/**
 * Visitor id from the `strada_vid` cookie. Refreshes the cookie on every
 * page load so active visitors never expire.
 */
export function getOrCreateVisitor(): { id: string; firstVisit: boolean } {
  const existing = readCookie(DEFAULT_VISITOR_COOKIE);
  if (existing) {
    writeVisitorCookie({ value: existing });
    return { id: existing, firstVisit: false };
  }
  const id = crypto.randomUUID();
  writeVisitorCookie({ value: id });
  return { id, firstVisit: true };
}

let _sessionId: string | undefined;
let _visitorId: string | undefined;
let _firstVisit: boolean | undefined;
let _currentPageviewSpan: Span | undefined;
let _removeListeners: (() => void) | undefined;

export function getLogger(name = "strada-web"): StradaLogger {
  return createStradaLogger((loggerName) => (getOptions() ? logs.getLogger(loggerName) : undefined), undefined, name);
}

function getPageAttributes(
  url: URL = new URL(window.location.href),
  referrer: string = document.referrer,
): Record<string, string> {
  return {
    [ATTR["url.path"]]: url.pathname,
    [ATTR["url.query"]]: url.search,
    [ATTR["url.full"]]: url.href,
    ...(referrer ? { [ATTR["http.request.header.referer"]]: referrer } : {}),
  };
}

/**
 * Parent work outside any span to the current pageview span, so events,
 * errors, and spans started from click handlers join the page trace.
 */
export function getBrowserWorkContext(activeContext: Context, pageviewSpan: Span | undefined): Context {
  if (!pageviewSpan || trace.getSpan(activeContext)) return activeContext;
  return trace.setSpan(activeContext, pageviewSpan);
}

/** Adds the pageview span and session baggage to the active context. */
class PageviewContextManager implements ContextManager {
  constructor(private readonly inner: ContextManager) {}

  active(): Context {
    const ctx = getBrowserWorkContext(this.inner.active(), _currentPageviewSpan);
    if (!_sessionId) return ctx;
    return propagation.setBaggage(ctx, createStradaBaggage(_sessionId, resolveUserId(getOptions())));
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.inner.with(ctx, fn, thisArg, ...args);
  }

  bind<T>(ctx: Context, target: T): T {
    return this.inner.bind(ctx, target);
  }

  enable(): this {
    this.inner.enable();
    return this;
  }

  disable(): this {
    this.inner.disable();
    return this;
  }
}

function browserResource(options: StradaOptions): Attributes {
  const uaData = typeof navigator === "undefined" ? undefined : Reflect.get(navigator, "userAgentData");
  const platform = uaData ? Reflect.get(uaData, "platform") : undefined;
  const mobile = uaData ? Reflect.get(uaData, "mobile") : undefined;
  const brands = uaData ? Reflect.get(uaData, "brands") : undefined;
  const brandNames = Array.isArray(brands)
    ? brands.flatMap((brand) => {
        const name = Reflect.get(brand, "brand");
        const version = Reflect.get(brand, "version");
        return typeof name === "string" && typeof version === "string" ? [`${name} ${version}`] : [];
      })
    : [];
  return {
    [ATTR["service.name"]]: options.service,
    ...resolveReleaseAttributes(options),
    [ATTR["deployment.environment.name"]]: options.environment,
    [ATTR["browser.platform"]]: typeof platform === "string" ? platform : undefined,
    [ATTR["browser.brands"]]: brandNames.length > 0 ? brandNames : undefined,
    [ATTR["browser.mobile"]]: typeof mobile === "boolean" ? mobile : undefined,
    [ATTR["user_agent.original"]]: typeof navigator === "undefined" ? undefined : navigator.userAgent || undefined,
    [ATTR["browser.language"]]: typeof navigator === "undefined" ? undefined : navigator.language || undefined,
  };
}

function sessionAttributes(): Attributes {
  return {
    [ATTR["session.id"]]: _sessionId,
    [ATTR["visitor.id"]]: _visitorId,
    [ATTR["user.id"]]: resolveUserId(getOptions()),
  };
}

function installListeners(options: StradaOptions): () => void {
  const removers: Array<() => void> = [];
  const listen = <T extends Event>(target: EventTarget, type: string, listener: (event: T) => void) => {
    target.addEventListener(type, listener as EventListener);
    removers.push(() => target.removeEventListener(type, listener as EventListener));
  };

  if (options.captureUncaughtErrors !== false) {
    listen<ErrorEvent>(window, "error", (event) => {
      const error = event.error instanceof Error ? event.error : event.message ? new Error(event.message) : undefined;
      if (error) void captureException(error, { handled: false, mechanism: "onerror" });
    });
    listen<PromiseRejectionEvent>(window, "unhandledrejection", (event) => {
      void captureException(normalizeError(event.reason), { handled: false, mechanism: "unhandledrejection" });
    });
  }

  // Page hidden: end the pageview (its duration is the time on page) and
  // flush with keepalive so the data survives tab close.
  listen(document, "visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    endCurrentPageSpan();
    void flush();
  });

  // Same-document navigations through the Navigation API cover pushState,
  // replaceState, link clicks, and back/forward in every SPA router.
  if (typeof navigation !== "undefined") {
    listen<NavigateEvent>(navigation, "navigate", (event) => {
      if (!event.canIntercept || !event.destination.sameDocument || event.navigationType === "reload") return;
      const destination = new URL(event.destination.url);
      if (destination.pathname + destination.search === window.location.pathname + window.location.search) return;
      startPageSpan(
        destination,
        {
          [ATTR["navigation.type"]]: event.navigationType,
          [ATTR["navigation.user_initiated"]]: event.userInitiated,
        },
        window.location.href,
      );
    });
  }

  return () => {
    for (const remove of removers) remove();
  };
}

export function initStrada(options: StradaOptions): Error | undefined {
  return tryTelemetry({
    operation: "initStrada()",
    run: () => {
      if (options.token) {
        console.warn("[@strada.sh/sdk] token is ignored in browser builds. Browser ingest is anonymous and rate limited.");
      }
      const started = initCore({ options, resource: browserResource(options), allowToken: false });
      if (!started) return;
      _sessionId = getOrCreateSessionId();
      const visitor = getOrCreateVisitor();
      _visitorId = visitor.id;
      _firstVisit = visitor.firstVisit;

      const base = getContextManager();
      setContextManager(new PageviewContextManager(base instanceof PageviewContextManager ? new StackContextManager() : base));
      runtimeHooks.onSpanStart = (span) => {
        const attributes: Attributes = {
          ...sessionAttributes(),
          ...(span.name === "pageview" ? {} : getPageAttributes()),
        };
        for (const [key, value] of Object.entries(attributes)) {
          if (value !== undefined && value !== "" && span.attributes[key] === undefined) span.setAttribute(key, value);
        }
      };
      runtimeHooks.onLogEmit = (attributes) => {
        Object.assign(attributes, {
          ...sessionAttributes(),
          [ATTR["url.path"]]: window.location.pathname,
          [ATTR["url.full"]]: window.location.href,
        });
      };

      startPageSpan();
      _removeListeners = installListeners(options);
    },
  });
}

/**
 * Start a new pageview span, ending the previous one. Called automatically on
 * init and on same-document navigations; call it yourself for custom routers.
 */
export function startPageSpan(
  url: string | URL = window.location.href,
  extraAttributes?: Record<string, string | boolean>,
  referrer?: string,
): void {
  endCurrentPageSpan();
  const pageUrl = typeof url === "string" ? new URL(url, window.location.href) : url;
  const firstVisit = _firstVisit === true;
  _firstVisit = false;
  _currentPageviewSpan = trace.getTracer("strada-web").startSpan("pageview", {
    attributes: {
      [ATTR["session.id"]]: _sessionId ?? "",
      ...(firstVisit ? { [ATTR["visitor.first_visit"]]: true } : {}),
      [ATTR["pageview.source"]]: "browser",
      ...getPageAttributes(pageUrl, referrer),
      ...extraAttributes,
    },
  });
}

/** End the current pageview span. Called automatically when the page is hidden. */
export function endCurrentPageSpan(): void {
  _currentPageviewSpan?.end();
  _currentPageviewSpan = undefined;
}

/**
 * Set the signed-in user for this browser. Sets `user.id` on every span and
 * log and writes the `strada_uid` cookie so the backend can read it. Pass
 * `null` on logout. Profile fields (email, name) are sent only by the
 * server-side `identifyUser()`, never from the browser.
 */
export function identifyUser(user: StradaUserIdentity | null): Error | undefined {
  return tryTelemetry({
    operation: "identifyUser()",
    run: () => {
      const options = getOptions();
      const cookieName = typeof options?.userIdCookie === "string" ? options.userIdCookie : DEFAULT_USER_ID_COOKIE;
      setRuntimeUserId(user?.id ?? null);
      if (options?.userIdCookie === false) return;
      if (user === null) {
        clearUserIdCookie(cookieName);
        return;
      }
      writeUserIdCookie({ name: cookieName, value: user.id, maxAge: DEFAULT_USER_ID_COOKIE_MAX_AGE });
    },
  });
}

/** Flush, remove window listeners, and stop exporting. */
export async function shutdown(): Promise<Error | undefined> {
  _removeListeners?.();
  _removeListeners = undefined;
  endCurrentPageSpan();
  const error = await shutdownClient();
  runtimeHooks.onSpanStart = undefined;
  runtimeHooks.onLogEmit = undefined;
  setContextManager(new StackContextManager());
  _sessionId = undefined;
  _visitorId = undefined;
  _firstVisit = undefined;
  resetContext();
  return error;
}
