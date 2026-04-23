# CLI

Strada CLI. Authenticates via device flow, manages projects, queries data, lists errors.

## Typed fetch client (safeFetch)

The CLI uses spiceflow's typed fetch client. Before writing any code that calls `safeFetch`, read the docs first:

```bash
curl -s https://raw.githubusercontent.com/remorses/spiceflow/main/README.md
```

Key rules:

- **Pass `App` type as generic** to `createSpiceflowFetch<App>()`. No `declare module` augmentation.
- **Use `:param` paths with `params` object**, never interpolate IDs into the path string. Interpolation breaks type inference.
- **`body` is a plain object**, not `JSON.stringify()`. The client serializes it automatically.
- **No `Content-Type` header needed.** It's set automatically for JSON bodies.
- **Auth header is global.** Set once in `createApiClient()`, not per request.
- **Response is `Error | Data`.** Check with `instanceof Error`, then the happy path has the narrowed type.

```ts
// GOOD: :param path, params object, body as object, response is typed
const res = await safeFetch("/api/orgs/:orgId/projects", {
  method: "POST",
  params: { orgId: org.id },
  body: { slug },
});
if (res instanceof Error) throw res;
// res.id, res.slug, res.ingestEndpoint are all typed

// BAD: interpolated path is just `string`, breaks all type inference
const res = await safeFetch(`/api/orgs/${org.id}/projects`, {
  method: "POST",
  body: { slug },
});
```

## API client pattern

Never pass `safeFetch` as function arguments. Instead, call `getApiClient()` inside each function that needs it. This reads auth from the config file automatically.

```ts
// GOOD: each function creates its own client
export async function ensureDefaultOrg() {
  const { safeFetch } = getApiClient();
  // ...
}

// BAD: threading safeFetch through args
export async function ensureDefaultOrg(
  safeFetch: ...,
  authHeaders: ...,
) { ... }
```

`getApiClient()` calls `requireAuth()` internally, so it throws if not logged in. Use `createApiClient(baseUrl, token)` only when you have explicit credentials that don't come from the config file.

## Project cache

Project slug→id mappings are cached in `~/.strada/config.json` as an array of `{ id, slug }` objects. The cache is refreshed automatically when a slug lookup misses. Commands that mutate projects (`create`, `delete`) update the cache inline.

## Colors

All terminal colors come from `src/colors.ts`, a vendored version of picocolors with zero dependencies. Never import `picocolors` directly.

## Testing

```bash
pnpm vitest run              # all tests
pnpm vitest run src/file.ts  # single file
```
