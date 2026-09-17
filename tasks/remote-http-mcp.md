---
title: Remote HTTP MCP for Strada
description: >
  Plan, then after Tommy greenlights, implement hosted Streamable HTTP MCP
  at https://strada.sh/mcp with Better Auth OAuth + CIMD. Reuse the goke
  CLI command tree. Deploy preview only.
---

# Remote HTTP MCP for Strada

Parent Discord thread: HTTP MCP support (`1549715519291261010`).
Parent session: `ses_f566d1228ffelbCd8G40F7pfFF`.

## Goal

Ship **`https://strada.sh/mcp`** (preview URL first) so Cursor / Claude / VS Code can add Strada as a **remote HTTP MCP** with OAuth. Reuse the existing goke CLI tools. Replace the current MCP story as needed. Keep local `strada mcp` stdio working unless replacing it is required for reuse.

**Plan first.** Write a concrete plan in the Discord thread: files, schema, auth, CLI reuse, tests, preview deploy. Do not implement until Tommy replies to proceed in **this new thread**.

After greenlight:

1. Implement
2. Deploy **preview only** (`pnpm --dir website deploy`). Never production.

## Non-goals

- Production website deploy
- npm publish
- Rewriting tools as website-only handlers that duplicate CLI SQL
- Replacing CLI device-flow login (`strada login`)
- MCP SDK v2 / protocol `2026-07-28` JSON-RPC changes beyond what Better Auth CIMD profile needs
- Enabling Dynamic Client Registration

## Read these skills first, in full

Load with the skill tool, then fetch the canonical docs they name. Never truncate READMEs.

1. **better-auth** skill, then **`mcp.md`** next to it (`/Users/morse/.agents/skills/better-auth/mcp.md`)
2. **goke** skill, then full goke README + `@goke/mcp` README from `/Users/morse/Documents/GitHub/goke` (local checkout, not stale opensrc cache)
3. **spiceflow** skill, then full spiceflow README
4. **cloudflare-workers** skill
5. **drizzle** skill (D1 migrations are hand-written SQL in `db/drizzle/`)
6. **errore** skill if returning errors from TS
7. **changesets** skill before any commit (only commit if Tommy asks)

Canonical Better Auth / MCP docs to fetch in full:

- https://better-auth.com/docs/plugins/mcp
- https://better-auth.com/docs/plugins/cimd
- https://better-auth.com/docs/plugins/oauth-provider
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

Goke HTTP recipe lives in `/Users/morse/Documents/GitHub/goke/mcp/README.md` under **Multi-tenant remote MCP over HTTP**. That repo already dropped the session Map.

## What already exists

### Stdio MCP (today)

`cli/src/cli.ts` exposes tools with `createMcpAction` from `@goke/mcp`:

```ts
createMcpAction({
  cli,
  commandFilter: isMcpCommand,
  serverName: "strada",
  serverVersion: packageJson.version,
})
```

`isMcpCommand` **skips**:

- `login`, `logout`
- `database create`, `database upgrade`
- `projects retention update`
- `mcp`
- anything starting with `completions`
- the TUI (empty command)

Keep that skip list. Do not expose those as HTTP tools either.

Docs: `website/src/docs/mcp/index.mdx`, `website/src/docs/mcp/install.mdx`, generated `website/src/docs/cli/mcp.mdx`.

### Auth (today)

Website Better Auth in `website/src/db.ts`:

- Google social login
- `deviceAuthorization({ verificationUri: '/device' })` for CLI
- `bearer()` for CLI session tokens
- No `jwt()`, no `@better-auth/mcp`, no `cimd()`

CLI auth: `cli/src/config.ts` reads `~/.strada/config.json` via **`node:fs` + `os.homedir()` + `process.cwd()`**. `getApiClient()` → `requireAuth()` → disk. That **bypasses** goke `ctx`. HTTP MCP clone isolation will not work until config/API client read `ctx.process.env` / `ctx.fs`.

### Website already depends on CLI pieces

`website/package.json` has `"strada": "workspace:^"` and `"@goke/mcp": "^0.0.13"` as a **devDependency**. Website already imports `strada/src/tinybird`. Do not import `cli/src/cli.ts` if that pulls termcast / bun TUI / Node-only modules into the Worker bundle.

## Required architecture

```
Cursor / Claude
      │
      │  POST https://preview.../mcp  (no token)
      ▼
401 + WWW-Authenticate  →  RFC 9728 protected resource
      │
      ▼
/.well-known/oauth-protected-resource
      │
      ▼
/oauth2/authorize  ►  existing /login  ►  new /consent
      │
      ▼
/oauth2/token  (PKCE, resource-bound JWT, CIMD client_id URL)
      │
      ▼
POST /mcp  behind requireMcpAuth
      │
      ▼
resolve user from JWT
cli.clone({ env: { STRADA_SESSION_TOKEN or equivalent, STRADA_API_URL } })
addCliToolsToMcp({ cli: clone, server, commandFilter: isMcpCommand })
WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,   // stateless, no Map
  enableJsonResponse: true,
})
handleRequest → Response → close transport + server
```

### Goke HTTP rules (local goke checkout)

Stateless Streamable HTTP (SDK v1, protocol through `2025-11-25`):

- `sessionIdGenerator: undefined`
- **No** `Map<sessionId, transport>`
- Fresh `Server` + transport **per POST**
- Close them after the response
- Tenant / user from **this request** (JWT), not from MCP session id
- Check **Origin** when present; 403 if disallowed. Missing Origin is OK for non-browser MCP clients
- GET/DELETE → 405 with `Allow: POST`
- Commands must use **`ctx`**, not `node:fs` / `process.cwd()` / `process.env` at module load / `process.exit`

This is **not** MCP 2026-07-28 dropping `initialize`. Do not migrate to MCP SDK v2 for transport. Better Auth CIMD still uses `metadataProfile: 'mcp-2026-07-28'` for client metadata.

### Better Auth rules (from mcp.md)

- Package is **`@better-auth/mcp`**. Never `mcp` from `better-auth/plugins` (deprecated).
- Need **`jwt()`** + **`mcp({ loginPage, consentPage, resource })`** + **`cimd()`**.
- Do **not** also register `oauthProvider()`. `mcp()` is the OAuth provider.
- `resource` is an HTTPS URL with no query/fragment. Same string for `requireMcpAuth`. Preview vs prod URLs must be correct for the Worker env (preview hostname vs `https://strada.sh/mcp`).
- `/login` already exists. Add **`/consent`** that calls `auth.api.oauth2Consent`.
- CIMD: do **not** use `@better-auth/cimd/node` on Workers. Need a Workers-safe fetch that:
  1. Parses HTTPS before resolving
  2. Resolves DNS once, rejects RFC 6890 special-use / private IPs
  3. Connects to that address, keeps TLS hostname for the original host
  4. Refuses redirects
- `oauthClient.clientId` must accept **URLs** (CIMD ids like `https://cursor.com/.well-known/oauth-client`).
- Generate schema with Better Auth, then **hand-write** `db/drizzle/NNNN_*.sql`. Do not invent columns. Read existing migrations first. Highest number + 1. D1: no `ALTER TABLE ... ADD CONSTRAINT`.
- Keep existing `deviceCode` / CLI device flow. Do not replace it.
- Forward OAuth discovery to `auth.handler`:
  - `{issuer}/.well-known/oauth-authorization-server`
  - `/.well-known/oauth-authorization-server/[issuer-path]`
  - `/.well-known/oauth-protected-resource`
- Mount MCP `POST /mcp` **next to the API**, not under `/api/auth`.
- Unauthenticated MCP: JSON-RPC 401 + `WWW-Authenticate`. Missing scopes: 403 `insufficient_scope`.

## CLI reuse (this is the hard part)

Do **not** duplicate `issues_list` / `query` / analytics as new website tools.

Reuse `addCliToolsToMcp({ cli, commandFilter: isMcpCommand })`.

Problems to solve in the plan:

1. **TUI / termcast / bun spawn** in `cli/src/cli.ts`. Worker cannot import that. Split a **command tree without TUI** (e.g. `buildCli()` used by bin and by HTTP MCP).
2. **`requireAuth` / `getApiClient` / `loadConfig`** must take goke `ctx` (or read `ctx.process.env` / `ctx.fs`). Today they use Node globals and disk.
3. HTTP session clone should inject the OAuth user as env the CLI already understands, or a small adapter:
   - Prefer: `cli.clone({ env: { STRADA_SESSION_TOKEN, STRADA_API_URL, ... } })` after teaching `requireAuth` to prefer env over disk.
   - Do not invent a second auth path inside every command.
4. **Project defaults.** Stdio uses cwd-scoped `~/.strada/config.json`. HTTP has no folder. Tools that currently say "run `strada setup`" must work with `--project` / `--org` flags (already exist on many commands). MCP `required` should follow goke schema rules: positionals + schema-required flags only. Optional `--project` stays optional in schema; document that remote MCP clients should pass it.
5. **Worker bundle.** If `cli` still pulls Node `fs`, clack, termcast, keep HTTP MCP on a **subset module** that only registers query/mutate commands needed as tools. Same `isMcpCommand` filter.
6. Bump `@goke/mcp` in strada to the version that documents stateless HTTP (goke `main` has this; published may still be older). Use the local goke checkout as source of truth.

## Website / Worker

- Spiceflow app: `POST /mcp` only for the MCP handler. `method: '*'` is OK if GET/DELETE return 405.
- Multi-tenant: org boundary is the **org**, not project. JWT user must be a member. Never leak another org.
- Preview resource URL must match the preview Worker origin, not always `https://strada.sh/mcp`.
- Origin allowlist for MCP POSTs: MCP spec MUST-check. Missing Origin allowed. Present disallowed Origin → 403.
- Do not keep transports in isolate memory.

## Docs

After commands/auth change:

- Update `website/src/docs/mcp/index.mdx` and `install.mdx` for **URL + OAuth** as well as stdio.
- If CLI command text changes, `pnpm --dir website generate:cli-docs`.
- Progressive disclosure. No emdashes. Bold key words.

## Tests

TDD. Failing tests first.

- Better Auth OAuth / CIMD / consent at the level this repo already tests workers
- `POST /mcp` without token → 401 + WWW-Authenticate
- With a valid token, `tools/list` includes `issues_list`, `logs`, `query` and excludes `login`, `mcp`
- Origin 403
- Tenant isolation: token for org A cannot read org B
- CLI `requireAuth` from `ctx.process.env` without touching real `~/.strada`

Never mock modules. Prefer end-to-end Worker tests if the repo has them.

## Deploy

Preview only:

```bash
pnpm --dir website deploy
```

That runs D1 migration then build then wrangler preview. If migration fails, **stop**. Do not `deploy:prod`.

If Tinybird schema is untouched, do not run `strada database upgrade`.

## Report

In Discord, ASD-STE100 for chat. Plan sections:

1. Approach (CLI reuse vs blockers)
2. Files to change
3. D1 migration
4. Auth plugins and consent page
5. Tests
6. Preview deploy steps

Honest about anything fragile (Workers CIMD fetch, CLI ctx port, bundle size).
