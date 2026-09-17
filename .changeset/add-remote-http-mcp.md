---
'strada': minor
'strada-website': minor
---

Add a remote HTTP MCP server at `https://strada.sh/mcp` with Better Auth OAuth.

Cursor, Claude, and VS Code can add that URL as an MCP server. The client
logs in with Google, consents once, then uses the same CLI tools over HTTP:
`issues_list`, `logs`, `query`, traces, analytics, alerts, and checks.

```json
{
  "mcpServers": {
    "strada": {
      "url": "https://strada.sh/mcp"
    }
  }
}
```

Local `strada mcp` over stdio still works. HTTP MCP uses OAuth JWTs bound to
`/mcp`. It does not reuse the CLI device-flow session.

Docs: [MCP overview](https://strada.sh/docs/mcp) and
[install](https://strada.sh/docs/mcp/install).
