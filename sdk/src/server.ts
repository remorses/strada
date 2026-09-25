/**
 * Server-only pieces shared by the node and cloudflare entries: request
 * enrichment hooks, profile events, and server-side pageviews. The browser
 * entry has its own identifyUser (cookie) and pageview spans.
 */

import { context, propagation, trace, type Attributes, type Context, type RecordingSpan, type RuntimeHooks } from "./api.ts";
import { ATTR } from "./attrs.ts";
import {
  BAGGAGE_SESSION_ID,
  BAGGAGE_USER_ID,
  buildPageviewAttributes,
  deriveUrlPath,
  emitUserIdentifyLog,
  isInitialized,
  readSpanAttributes,
  SPAN_CONTEXT_ATTR_KEYS,
  tryTelemetry,
  type StradaUserIdentity,
  type TrackPageviewOptions,
} from "./shared.ts";
import { logs } from "./api.ts";

function warnBeforeInit(what: string): boolean {
  if (isInitialized()) return false;
  console.warn(`[@strada.sh/sdk] ${what} called before initStrada(). Nothing was sent.`);
  return true;
}

// ---------------------------------------------------------------------------
// Request enrichment
// ---------------------------------------------------------------------------

function baggageAttributes(ctx: Context): Attributes {
  const baggage = propagation.getBaggage(ctx);
  return {
    [ATTR["session.id"]]: baggage?.getEntry(BAGGAGE_SESSION_ID)?.value,
    [ATTR["user.id"]]: baggage?.getEntry(BAGGAGE_USER_ID)?.value,
  };
}

function setMissing(target: Attributes, source: Attributes): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== "" && !Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = value;
    }
  }
}

/** Request-scoped attributes (url.path, http.route, ...) from a span, including old HTTP semconv. */
function requestContextAttributes(span: unknown): Attributes {
  const attrs = readSpanAttributes(span);
  if (!attrs) return {};
  const picked = Object.fromEntries(
    SPAN_CONTEXT_ATTR_KEYS.flatMap((key) => (attrs[key] != null ? [[key, String(attrs[key])]] : [])),
  );
  return { ...picked, [ATTR["url.path"]]: deriveUrlPath(attrs) };
}

/**
 * Hooks for servers: child spans inherit request attributes from their
 * parent, and spans/logs pick up session.id and user.id from incoming W3C
 * baggage, so errors and events inside a request carry its URL and user.
 */
export const serverHooks: Pick<RuntimeHooks, "onSpanStart" | "onLogEmit"> = {
  onSpanStart(span: RecordingSpan, parentContext: Context) {
    const derived = deriveUrlPath(span.attributes);
    if (derived && span.attributes[ATTR["url.path"]] === undefined) span.setAttribute(ATTR["url.path"], derived);
    const inherited: Attributes = {};
    setMissing(inherited, requestContextAttributes(trace.getSpan(parentContext)));
    setMissing(inherited, baggageAttributes(parentContext));
    for (const [key, value] of Object.entries(inherited)) {
      if (value !== undefined && span.attributes[key] === undefined) span.setAttribute(key, value);
    }
  },
  onLogEmit(attributes: Attributes, ctx: Context) {
    setMissing(attributes, baggageAttributes(ctx));
    setMissing(attributes, requestContextAttributes(trace.getSpan(ctx)));
  },
};

/**
 * Emit a trusted user profile event. The collector stores it in otel_logs
 * and extracts the latest profile into otel_users.
 */
export function identifyUser(user: StradaUserIdentity): Error | undefined {
  return tryTelemetry({
    operation: "identifyUser()",
    run: () => {
      if (warnBeforeInit("identifyUser()")) return;
      emitUserIdentifyLog(logs.getLogger("strada"), user);
    },
  });
}

/**
 * Server-side pageview span (`pageview.source = server`). Feeds the same
 * analytics views as browser pageviews. Use for bots, crawlers, or SSR-only
 * traffic the browser SDK cannot see.
 */
export function trackPageview(opts: TrackPageviewOptions): Error | undefined {
  return tryTelemetry({
    operation: "trackPageview()",
    run: () => {
      if (warnBeforeInit("trackPageview()")) return;
      const attributes = buildPageviewAttributes(opts, propagation.getBaggage(context.active()));
      trace.getTracer("strada").startSpan("pageview", { attributes }).end();
    },
  });
}

