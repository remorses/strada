import { describe, expect, test } from "vitest";
import { requireAuth } from "./config.ts";

describe("requireAuth", () => {
  test("reads session token and API URL from ctx process env without disk", () => {
    const auth = requireAuth({
      process: {
        env: {
          STRADA_SESSION_TOKEN: "env-session-token",
          STRADA_API_URL: "https://preview.strada.sh",
        },
      },
    });

    expect(auth).toEqual({
      sessionToken: "env-session-token",
      baseUrl: "https://preview.strada.sh",
    });
  });
});
