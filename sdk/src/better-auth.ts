/**
 * Better Auth plugin for Strada user identification and auth event tracking.
 *
 * This file intentionally imports Better Auth only as a type. The runtime plugin
 * is a plain object matching Better Auth's structural plugin contract, so apps
 * that do not use Better Auth never bundle it through @strada.sh/sdk.
 *
 * Cookie setting uses the `{ headers }` return mechanism from after hooks, not
 * `ctx.setCookie()`. The hook context type (`HookEndpointContext`) wraps
 * `EndpointContext` in `Partial<>`, so `setCookie` is undefined at runtime.
 * Returning `{ headers: new Headers({ "set-cookie": ... }) }` is the correct
 * way to set cookies from after hooks; `runAfterHooks` merges those headers
 * into `context.context.responseHeaders`.
 */

import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { BetterAuthPlugin } from "better-auth";
import { ATTR } from "./attrs.ts";
import {
  DEFAULT_USER_ID_COOKIE,
  emitUserIdentifyLog,
  captureExceptionViaOtel,
  tryTelemetry,
  tryTelemetryAsync,
} from "./shared.ts";

export interface StradaBetterAuthOptions {
  /** Disable all cookie and event behavior while keeping the plugin registered. */
  enabled?: boolean;
  /** JS-readable cookie name used by the browser SDK to resolve user.id. */
  cookieName?: string;
  /** Cookie lifetime in seconds. Defaults to one year. */
  cookieMaxAge?: number;
  /**
   * Track email and display name as custom event attributes.
   *
   * Auth telemetry can contain PII. This defaults to true because auth analytics
   * is most useful when debugging real user journeys, but callers can disable it.
   */
  includeUserDetails?: boolean;
  /** Override event emission, mostly useful for tests or custom routing. */
  track?: (name: string, properties: StradaAuthEventProperties) => void | Promise<void>;
}

export interface StradaAuthEventProperties {
  userId?: string;
  userEmail?: string;
  userName?: string;
  authMethod?: string;
  authProvider?: string;
  authPath?: string;
  isSignup?: boolean;
}

type BetterAuthUser = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  image?: string | null;
};

/**
 * Minimal shape of the context passed to after hooks at runtime.
 * The real type is HookEndpointContext from @better-auth/core, which is
 * Partial<EndpointContext<...>> — most EndpointContext methods (setCookie,
 * setHeader, etc.) are undefined. We only type the properties we actually use.
 *
 * Source: @better-auth/core/dist/types/plugin.d.mts (HookEndpointContext)
 * Source: @better-auth/core/dist/api/index.d.mts (AuthContext.newSession, AuthContext.session)
 * Source: better-call/dist/endpoint.d.mts (EndpointContext.getCookie)
 */
type HookContext = {
  path?: string;
  context: {
    newSession?: { user?: BetterAuthUser } | null;
    session?: { user?: BetterAuthUser } | null;
  };
  getCookie?: (name: string) => string | null | undefined;
};

type BetterAuthAfterHookHandler =
  NonNullable<NonNullable<BetterAuthPlugin["hooks"]>["after"]>[number]["handler"];

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const pluginBase = { id: "strada-better-auth" } satisfies BetterAuthPlugin;

const customAttributeKeys = {
  userId: "custom.user_id",
  userEmail: "custom.user_email",
  userName: "custom.user_name",
  authMethod: "custom.auth_method",
  authProvider: "custom.auth_provider",
  authPath: "custom.auth_path",
  isSignup: "custom.is_signup",
} satisfies Record<keyof StradaAuthEventProperties, string>;

/**
 * Serialize a cookie name/value/options into a Set-Cookie header string.
 * Avoids a runtime dependency on better-call's serializeCookie.
 */
function serializeSetCookie(
  name: string,
  value: string,
  options: { path?: string; sameSite?: string; httpOnly?: boolean; maxAge?: number } = {},
): string {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (options.path) cookie += `; Path=${options.path}`;
  if (options.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
  if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
  if (options.httpOnly) cookie += "; HttpOnly";
  return cookie;
}

export function strataBetterAuth(options: StradaBetterAuthOptions = {}) {
  const config = {
    enabled: options.enabled ?? true,
    cookieName: options.cookieName ?? DEFAULT_USER_ID_COOKIE,
    cookieMaxAge: options.cookieMaxAge ?? ONE_YEAR_SECONDS,
    includeUserDetails: options.includeUserDetails ?? true,
    track: options.track ?? emitAuthLog,
  };

  /**
   * Properties are built inside the boundary, not passed in already built.
   * `buildProperties()` reads `user.id`, `user.email`, and `ctx.path`, which
   * are app-controlled getters: evaluating them in the argument position would
   * throw before any protection ran and break the auth request.
   */
  async function trackSafely({
    name,
    buildProperties,
  }: {
    name: string;
    buildProperties: () => StradaAuthEventProperties;
  }) {
    void (await tryTelemetryAsync({
      operation: `betterAuth ${name}`,
      run: async () => {
        await config.track(name, buildProperties());
      },
    }));
  }

  if (!config.enabled) return pluginBase;

  return {
    ...pluginBase,
    init() {
      return {
        options: {
          onAPIError: {
            onError(error: unknown) {
              // Runs inside the auth request path. Reading `error.message` and
              // `String(error)` can throw on a hostile value, so the whole
              // handler sits behind the boundary.
              void tryTelemetry({
                operation: "betterAuth onAPIError",
                run: () => {
                  void captureExceptionViaOtel(error, {
                    tags: { source: "better-auth" },
                    loggerName: "strada-better-auth",
                  });
                  console.error(
                    "[better-auth]",
                    error instanceof Error ? error.message : String(error),
                  );
                },
              });
            },
          },
          databaseHooks: {
            user: {
              create: {
                after: async (user, context) => {
                  emitIdentifyLog(user, config.includeUserDetails);
                  await trackSafely({
                    name: "auth.signup",
                    buildProperties: () => ({
                      ...commonAuthProperties({
                        user,
                        path: context?.path,
                        includeUserDetails: config.includeUserDetails,
                      }),
                      isSignup: true,
                    }),
                  });
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      after: [
        {
          matcher: (context) => Boolean(context.path),
          // The after hook receives HookEndpointContext at runtime, which is
          // Partial<EndpointContext<...>> — setCookie/setHeader are undefined.
          // Cookie setting is done via the returned { headers } object, which
          // runAfterHooks merges into context.context.responseHeaders.
          handler: (async (ctx: HookContext) => {
            if (ctx.path === "/sign-out") {
              const previousUserId = ctx.getCookie?.(config.cookieName) ?? undefined;
              const headers = makeClearCookieHeaders(config.cookieName);
              const user = ctx.context.session?.user ?? (previousUserId ? { id: previousUserId } : undefined);
              await trackSafely({
                name: "auth.logout",
                buildProperties: () => commonAuthProperties({
                  user,
                  path: ctx.path,
                  includeUserDetails: config.includeUserDetails,
                }),
              });
              return { headers };
            }

            const user = ctx.context.newSession?.user;
            const userId = stringValue(user?.id);
            if (!userId) return {};

            const headers = makeSetCookieHeaders(config.cookieName, userId, config.cookieMaxAge);

            emitIdentifyLog(user, config.includeUserDetails);

            if (ctx.path?.startsWith("/sign-up")) return { headers };

            await trackSafely({
              name: "auth.login",
              buildProperties: () => commonAuthProperties({
                user,
                path: ctx.path,
                includeUserDetails: config.includeUserDetails,
              }),
            });
            return { headers };
          }) as BetterAuthAfterHookHandler,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

function makeSetCookieHeaders(name: string, value: string, maxAge: number): Headers {
  const headers = new Headers();
  headers.set("set-cookie", serializeSetCookie(name, value, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge,
  }));
  return headers;
}

function makeClearCookieHeaders(name: string): Headers {
  const headers = new Headers();
  headers.set("set-cookie", serializeSetCookie(name, "", {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: 0,
  }));
  return headers;
}

function commonAuthProperties({
  user,
  path,
  includeUserDetails,
}: {
  user?: BetterAuthUser | null;
  path?: string;
  includeUserDetails: boolean;
}): StradaAuthEventProperties {
  const { method, provider } = parseAuthSource(path);
  const userId = stringValue(user?.id);
  const userEmail = includeUserDetails ? stringValue(user?.email) : undefined;
  const userName = includeUserDetails ? stringValue(user?.name) : undefined;

  return {
    ...(userId ? { userId } : {}),
    ...(userEmail ? { userEmail } : {}),
    ...(userName ? { userName } : {}),
    ...(method ? { authMethod: method } : {}),
    ...(provider ? { authProvider: provider } : {}),
    ...(path ? { authPath: path } : {}),
  };
}

function parseAuthSource(path: string | undefined): { method?: string; provider?: string } {
  if (!path) return {};
  if (path === "/sign-up/email" || path === "/sign-in/email") {
    return { method: "email", provider: "email" };
  }
  if (path.startsWith("/callback/")) {
    const provider = path.slice("/callback/".length);
    return { method: "oauth", provider: provider || undefined };
  }
  if (path.includes("device")) return { method: "device", provider: "device" };
  return {};
}

function stringValue(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// These hooks run inside the auth request path, so a throw here would break
// sign in. Telemetry failures must stay invisible to the user.
function emitAuthLog(name: string, properties: StradaAuthEventProperties): void {
  void tryTelemetry({
    operation: `betterAuth ${name}`,
    run: () => {
      const attributes: Record<string, string | number | boolean> = {
        [ATTR["event.name"]]: name,
      };

      if (properties.userId) attributes[ATTR["user.id"]] = properties.userId;
      for (const key of Object.keys(customAttributeKeys) as Array<keyof StradaAuthEventProperties>) {
        const value = properties[key];
        if (value !== undefined) attributes[customAttributeKeys[key]] = value;
      }

      logs.getLogger("strada-better-auth").emit({
        eventName: name,
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        body: name,
        attributes,
      });
    },
  });
}

function emitIdentifyLog(user: BetterAuthUser | undefined | null, includeUserDetails: boolean): void {
  void tryTelemetry({
    operation: "betterAuth identify",
    run: () => {
      emitIdentifyLogUnsafe(user, includeUserDetails);
    },
  });
}

function emitIdentifyLogUnsafe(
  user: BetterAuthUser | undefined | null,
  includeUserDetails: boolean,
): void {
  const userId = stringValue(user?.id);
  if (!userId) return;
  const email = includeUserDetails ? stringValue(user?.email) : undefined;
  const name = includeUserDetails ? stringValue(user?.name) : undefined;
  const image = includeUserDetails ? stringValue(user?.image) : undefined;

  emitUserIdentifyLog(logs.getLogger("strada-better-auth"), {
    id: userId,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(image ? { image } : {}),
  });
}
