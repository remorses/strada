---
'strada': minor
'strada-website': minor
---

Add `strada mcp`, a stdio MCP server on the same CLI binary. Cursor, Claude Desktop, and VS Code can spawn `strada mcp` and call supported non-interactive CLI commands as tools (`issues_list`, `logs`, `query`). Log in with `strada login` first. `login`, `logout`, `database create`, and `database upgrade` are not MCP tools.

```bash
npx @playwriter/install-mcp 'strada mcp' --client cursor
```
