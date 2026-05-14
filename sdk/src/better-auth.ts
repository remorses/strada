/**
 * Better Auth plugin for Strada user identification and auth event tracking.
 *
 * This file intentionally imports Better Auth only as a type. The runtime plugin
 * is a plain object matching Better Auth's structural plugin contract, so apps
 * that do not use Better Auth never bundle it through @strada.sh/sdk.
 */

import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { BetterAuthPlugin } from "better-auth";
import { ATTR } from "./attrs.ts";

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
  id?: string;
  email?: string;
  name?: string;
};

type CookieOptions = {
  path?: string;
  sameSite?: "lax" | "strict" | "none";
  httpOnly?: boolean;
  maxAge?: number;
};

type BetterAuthContext = {
  path?: string;
  context: {
    newSession?: { user?: BetterAuthUser } | null;
    session?: { user?: BetterAuthUser } | null;
  };
  getCookie?: (name: string) => string | null | undefined;
  setCookie: (name: string, value: string, options?: CookieOptions) => string;
};

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const DEFAULT_BETTER_AUTH_USER_ID_COOKIE = "strada_uid";
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

export function strataBetterAuth(options: StradaBetterAuthOptions = {}) {
  const config = {
    enabled: options.enabled ?? true,
    cookieName: options.cookieName ?? DEFAULT_BETTER_AUTH_USER_ID_COOKIE,
    cookieMaxAge: options.cookieMaxAge ?? ONE_YEAR_SECONDS,
    includeUserDetails: options.includeUserDetails ?? true,
    track: options.track ?? emitAuthLog,
  };

  async function trackSafely(name: string, properties: StradaAuthEventProperties) {
    try {
      await config.track(name, properties);
    } catch (error) {
      console.warn("[@strada.sh/sdk] Better Auth event tracking failed", error);
    }
  }

  if (!config.enabled) return pluginBase;

  return {
    ...pluginBase,
    init() {
      return {
        options: {
          databaseHooks: {
            user: {
              create: {
                after: async (user, context) => {
                  await trackSafely("auth.signup", {
                    ...commonAuthProperties({
                      user,
                      path: context?.path,
                      includeUserDetails: config.includeUserDetails,
                    }),
                    isSignup: true,
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
          handler: async (ctx) => {
            const authCtx = ctx as BetterAuthContext;

            if (authCtx.path === "/sign-out") {
              const previousUserId = authCtx.getCookie?.(config.cookieName) ?? undefined;
              clearStradaUidCookie({ ctx: authCtx, name: config.cookieName });
              const user = authCtx.context.session?.user ?? (previousUserId ? { id: previousUserId } : undefined);
              await trackSafely("auth.logout", commonAuthProperties({
                user,
                path: authCtx.path,
                includeUserDetails: config.includeUserDetails,
              }));
              return {};
            }

            const user = authCtx.context.newSession?.user;
            const userId = stringValue(user?.id);
            if (!userId) return {};

            writeStradaUidCookie(authCtx, {
              name: config.cookieName,
              value: userId,
              maxAge: config.cookieMaxAge,
            });

            if (authCtx.path?.startsWith("/sign-up")) return {};

            await trackSafely("auth.login", commonAuthProperties({
              user,
              path: authCtx.path,
              includeUserDetails: config.includeUserDetails,
            }));
            return {};
          },
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

function writeStradaUidCookie(
  ctx: BetterAuthContext,
  options: { name: string; value: string; maxAge: number },
) {
  ctx.setCookie(options.name, options.value, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: options.maxAge,
  });
}

function clearStradaUidCookie({
  ctx,
  name,
}: {
  ctx: BetterAuthContext;
  name: string;
}) {
  ctx.setCookie(name, "", {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: 0,
  });
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

function stringValue(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emitAuthLog(name: string, properties: StradaAuthEventProperties): void {
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
}
