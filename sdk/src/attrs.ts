/**
 * OTel attribute keys used by the Strada SDK and collector.
 * Extracted into a separate file so non-browser runtimes (Cloudflare Workers,
 * otel-collector) can import just the constants without pulling in DOM APIs.
 *
 * All custom attribute names in one place. Some are standard OTel semantic
 * conventions (exception.*, url.*), some are Strada additions (session.id,
 * event.name, navigation.*). Centralizing them prevents typos, makes
 * renaming safe, and documents what each attribute is for.
 */

export const ATTR = {
  // -- Session and user context (injected by browser SDK, propagated via baggage) --

  /** Per-tab browser session UUID, stored in sessionStorage. Groups pageviews, events, and errors into one visit. */
  "session.id": "session.id",
  /** Anonymous browser identity from cookie strada_vid. Survives tabs, login, and logout. Powers unique visitors. */
  "visitor.id": "visitor.id",
  /** True on the first pageview of a new visitor.id. String "true" in ClickHouse maps. */
  "visitor.first_visit": "visitor.first_visit",
  /** Signed-in account from cookie strada_uid, identifyUser(), or userId. */
  "user.id": "user.id",
  /** Signed-in user's email address. Stored through identifyUser profile events, not cookies. */
  "user.email": "user.email",
  /** Signed-in user's display name or username. */
  "user.name": "user.name",
  /** Signed-in user's full name. */
  "user.full_name": "user.full_name",
  /** Stable anonymized user hash when raw user.id is sensitive. */
  "user.hash": "user.hash",
  /** Signed-in user's profile image URL. */
  "user.image": "user.image",
  /** Product/account organization id associated with the user profile. */
  "organization.id": "organization.id",
  /** Product/account organization display name associated with the user profile. */
  "organization.name": "organization.name",
  /** Reserved event name for user profile upserts extracted into otel_users. */
  "strada.user.identify": "strada.user.identify",

  // -- URL context (injected by browser SDK into every span and log) --

  /** Current page pathname, e.g. "/pricing". From window.location.pathname. */
  "url.path": "url.path",
  /** Current page query string, e.g. "?plan=pro". From window.location.search. */
  "url.query": "url.query",
  /** Full page URL including protocol, host, path, query. From window.location.href. */
  "url.full": "url.full",
  /** Referrer URL. From document.referrer. Useful for entry page attribution. */
  "http.request.header.referer": "http.request.header.referer",

  // -- Custom events (track API) --

  /** Structured event name that distinguishes custom events from ordinary logs, e.g. "signup_started". */
  "event.name": "event.name",

  // -- Exception attributes (standard OTel + Strada extensions) --

  /** Fully-qualified exception class name, e.g. "TypeError". Standard OTel. */
  "exception.type": "exception.type",
  /** The exception message string. Standard OTel. */
  "exception.message": "exception.message",
  /** Raw stacktrace string in the language's natural format. Standard OTel. */
  "exception.stacktrace": "exception.stacktrace",
  /** How the exception was captured: "generic", "onerror", "unhandledrejection", "uncaughtException". */
  "exception.mechanism.type": "exception.mechanism.type",
  /** "true" if user code caught it, "false" if caught by a global handler. String, not boolean. */
  "exception.mechanism.handled": "exception.mechanism.handled",
  /** Custom fingerprint override for issue grouping. JSON array string. */
  "exception.fingerprint": "exception.fingerprint",
  /** Parsed stack frames as a JSON array of {filename, function, lineno, colno, in_app, debug_id}. */
  "exception.structured_frames": "exception.structured_frames",
  /** UUID linking the source file to its source map (TC39 debug-id proposal). */
  "exception.debug_id": "exception.debug_id",
  /** Severity level string for the error, e.g. "error", "warning", "fatal". */
  "exception.level": "exception.level",

  // -- Cloudflare Workers runtime attrs (for manual capture in Workers) --

  /** Cloudflare worker invocation outcome. Runtime traces use values like "ok" and "exception". */
  "cloudflare.outcome": "cloudflare.outcome",
  /** Cloudflare Worker script name. Usually the same logical service as service.name. */
  "cloudflare.script_name": "cloudflare.script_name",
  /** Serverless function name. In Workers this matches the configured service/script name. */
  "faas.name": "faas.name",
  /** Telemetry SDK implementation name. */
  "telemetry.sdk.name": "telemetry.sdk.name",
  /** Telemetry SDK language/runtime. */
  "telemetry.sdk.language": "telemetry.sdk.language",

  // -- Pageview tracking --

  /** Where the pageview was tracked: "browser" (JS SDK) or "server" (server SDK trackPageview). */
  "pageview.source": "pageview.source",

  // -- SPA navigation (set on pageview spans during client-side navigation) --

  /** How the navigation was triggered: "push", "replace", "traverse". From Navigation API. */
  "navigation.type": "navigation.type",
  /** Whether the user clicked a link vs programmatic navigation. Boolean. */
  "navigation.user_initiated": "navigation.user_initiated",

  // -- Browser detection (set as resource attributes on SDK init) --

  /** OS platform, e.g. "macOS", "Windows". From navigator.userAgentData.platform. */
  "browser.platform": "browser.platform",
  /** Brand strings, e.g. "Google Chrome 147, Chromium 147". From navigator.userAgentData.brands. */
  "browser.brands": "browser.brands",
  /** Whether the device is mobile. From navigator.userAgentData.mobile. */
  "browser.mobile": "browser.mobile",
  /** Browser language, e.g. "en-US". From navigator.language. */
  "browser.language": "browser.language",
  /** Full user agent string. From navigator.userAgent. */
  "user_agent.original": "user_agent.original",

  // -- Resource attributes (standard OTel semantic conventions) --

  /** Logical name of the service, e.g. "api", "frontend". Standard OTel resource attribute. */
  "service.name": "service.name",
  /** Version of the service/app. Maps to Release in error tracking. Standard OTel resource attribute. */
  "service.version": "service.version",
  /** Deployment environment, e.g. "production", "staging". Standard OTel resource attribute. */
  "deployment.environment.name": "deployment.environment.name",
  /** Deployment/build identifier from the hosting platform, e.g. Vercel deployment id or Cloudflare build uuid. */
  "deployment.id": "deployment.id",
  /** VCS revision that produced this deployment, usually a full git commit SHA. */
  "vcs.ref.head.revision": "vcs.ref.head.revision",
  /** VCS branch or ref name that produced this deployment, e.g. "main". */
  "vcs.ref.head.name": "vcs.ref.head.name",
} as const;
