---
'strada': patch
'strada-website': patch
---

Align remote HTTP MCP with Better Auth MCP, CIMD, and JWT plugins.

Same-origin CIMD returns the Worker metadata document. Third-party CIMD
resolves DNS once, rejects RFC 6890 special-use addresses, pins the IP,
and keeps TLS SNI. Consent uses `auth.api.oauth2Consent` and shows the
client, scopes, resource, and redirect. Cookie cache is on again because
Better Auth date columns now return `Date`.
