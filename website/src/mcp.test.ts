import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { handleMcpRequest } from "./mcp.ts";
import { mcpClientMetadataDocument } from "./mcp-resource.ts";

async function mcpRequest(init: RequestInit & { url?: string }) {
  return handleMcpRequest(new Request(init.url ?? "http://localhost/mcp", init));
}

describe("remote HTTP MCP", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM org_member"),
      env.DB.prepare("DELETE FROM project"),
      env.DB.prepare("DELETE FROM database"),
      env.DB.prepare("DELETE FROM org"),
      env.DB.prepare("DELETE FROM user"),
    ]);
  });

  test("POST /mcp without a token returns JSON-RPC 401 and WWW-Authenticate", async () => {
    const response = await mcpRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const wwwAuthenticate = response.headers.get("www-authenticate");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(wwwAuthenticate).toMatch(/resource_metadata=/);
    expect(body).toMatchObject({ jsonrpc: "2.0" });
  });

  test("GET /mcp returns 405 with Allow POST", async () => {
    const response = await mcpRequest({ method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("rejects a present Origin that is not allowed", async () => {
    const response = await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    }));
    expect(response.status).toBe(403);
  });

  test("CIMD document is JSON with a JSON content type", async () => {
    const response = Response.json(mcpClientMetadataDocument());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const body: { client_id: string; redirect_uris: string[] } = await response.json();
    expect(body.client_id).toContain("/.well-known/oauth-client");
    expect(body.redirect_uris).toContain("http://127.0.0.1:8765/callback");
  });
});
