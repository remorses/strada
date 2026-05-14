import { describe, expect, it } from "vitest";
import type { BetterAuthPlugin } from "better-auth";
import {
  strataBetterAuth,
  type StradaAuthEventProperties,
  type StradaBetterAuthOptions,
} from "./better-auth.ts";

type CookieWrite = {
  name: string;
  value: string;
  options?: Record<string, string | number | boolean>;
};

type HookContext = {
  path?: string;
  context: {
    newSession?: { user?: { id?: string; email?: string; name?: string } } | null;
    session?: { user?: { id?: string; email?: string; name?: string } } | null;
  };
  getCookie?: (name: string) => string | null | undefined;
  setCookie: (name: string, value: string, options?: Record<string, string | number | boolean>) => void;
};

type SignupHook = (
  user: { id?: string; email?: string; name?: string },
  context: { path?: string } | null,
) => Promise<void>;

function makeHarness(options: StradaBetterAuthOptions = {}) {
  const events: Array<{ name: string; properties: StradaAuthEventProperties }> = [];
  const cookies: CookieWrite[] = [];
  const plugin: BetterAuthPlugin = strataBetterAuth({
    ...options,
    track: (name, properties) => {
      events.push({ name, properties });
    },
  });

  const after = plugin.hooks?.after?.[0]?.handler as ((ctx: HookContext) => Promise<Record<string, never>>) | undefined;
  const initResult = plugin.init?.({} as never) as {
    options?: {
      databaseHooks?: {
        user?: { create?: { after?: SignupHook } };
      };
    };
  } | undefined;
  const signupAfter = initResult?.options?.databaseHooks?.user?.create?.after;

  const setCookie = (
    name: string,
    value: string,
    cookieOptions?: Record<string, string | number | boolean>,
  ) => {
    cookies.push({ name, value, options: cookieOptions });
  };

  return { plugin, after, signupAfter, events, cookies, setCookie };
}

describe("strataBetterAuth", () => {
  it("sets a JS-readable user cookie and tracks email login", async () => {
    const harness = makeHarness();

    const result = await harness.after!({
      path: "/sign-in/email",
      context: {
        newSession: {
          user: { id: "user_123", email: "tommy@example.com", name: "Tommy" },
        },
      },
      setCookie: harness.setCookie,
    });

    expect(result).toEqual({});
    expect(harness.cookies).toMatchInlineSnapshot(`
      [
        {
          "name": "strada_uid",
          "options": {
            "httpOnly": false,
            "maxAge": 31536000,
            "path": "/",
            "sameSite": "lax",
          },
          "value": "user_123",
        },
      ]
    `);
    expect(harness.events).toMatchInlineSnapshot(`
      [
        {
          "name": "auth.login",
          "properties": {
            "authMethod": "email",
            "authPath": "/sign-in/email",
            "authProvider": "email",
            "userEmail": "tommy@example.com",
            "userId": "user_123",
            "userName": "Tommy",
          },
        },
      ]
    `);
  });

  it("tracks OAuth provider from callback path", async () => {
    const harness = makeHarness({ cookieName: "custom_uid" });

    await harness.after!({
      path: "/callback/google",
      context: { newSession: { user: { id: "user_oauth", email: "a@b.test" } } },
      setCookie: harness.setCookie,
    });

    expect(harness.cookies[0]).toMatchInlineSnapshot(`
      {
        "name": "custom_uid",
        "options": {
          "httpOnly": false,
          "maxAge": 31536000,
          "path": "/",
          "sameSite": "lax",
        },
        "value": "user_oauth",
      }
    `);
    expect(harness.events[0]).toMatchInlineSnapshot(`
      {
        "name": "auth.login",
        "properties": {
          "authMethod": "oauth",
          "authPath": "/callback/google",
          "authProvider": "google",
          "userEmail": "a@b.test",
          "userId": "user_oauth",
        },
      }
    `);
  });

  it("tracks account creation through database hooks", async () => {
    const harness = makeHarness();

    await harness.signupAfter!(
      { id: "new_user", email: "new@example.com", name: "New User" },
      { path: "/callback/github" },
    );

    expect(harness.events).toMatchInlineSnapshot(`
      [
        {
          "name": "auth.signup",
          "properties": {
            "authMethod": "oauth",
            "authPath": "/callback/github",
            "authProvider": "github",
            "isSignup": true,
            "userEmail": "new@example.com",
            "userId": "new_user",
            "userName": "New User",
          },
        },
      ]
    `);
  });

  it("sets the cookie but does not double-track login for email signup", async () => {
    const harness = makeHarness();

    await harness.after!({
      path: "/sign-up/email",
      context: { newSession: { user: { id: "new_user", email: "new@example.com" } } },
      setCookie: harness.setCookie,
    });

    expect(harness.cookies[0]?.value).toBe("new_user");
    expect(harness.events).toEqual([]);
  });

  it("clears the user cookie and tracks logout", async () => {
    const harness = makeHarness();

    await harness.after!({
      path: "/sign-out",
      context: {},
      getCookie: (name) => name === "strada_uid" ? "user_123" : undefined,
      setCookie: harness.setCookie,
    });

    expect(harness.cookies).toMatchInlineSnapshot(`
      [
        {
          "name": "strada_uid",
          "options": {
            "httpOnly": false,
            "maxAge": 0,
            "path": "/",
            "sameSite": "lax",
          },
          "value": "",
        },
      ]
    `);
    expect(harness.events).toMatchInlineSnapshot(`
      [
        {
          "name": "auth.logout",
          "properties": {
            "authPath": "/sign-out",
            "userId": "user_123",
          },
        },
      ]
    `);
  });

  it("can omit user details", async () => {
    const harness = makeHarness({ includeUserDetails: false });

    await harness.after!({
      path: "/sign-in/email",
      context: { newSession: { user: { id: "user_123", email: "hidden@example.com" } } },
      setCookie: harness.setCookie,
    });

    expect(harness.events[0]).toMatchInlineSnapshot(`
      {
        "name": "auth.login",
        "properties": {
          "authMethod": "email",
          "authPath": "/sign-in/email",
          "authProvider": "email",
          "userId": "user_123",
        },
      }
    `);
  });

  it("registers no hooks when disabled", () => {
    const harness = makeHarness({ enabled: false });

    expect(harness.plugin.hooks).toBeUndefined();
    expect(harness.signupAfter).toBeUndefined();
  });
});
