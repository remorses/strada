---
'strada': patch
'strada-website': patch
---

Fix `strada database upgrade` when Tinybird already has a deploy in progress.

Upgrade used to treat Tinybird's HTTP 400 body as a hard failure. The body
includes a phantom next deployment id (`8`), so the CLI polled
`/v1/deployments/8` and got 404. It now:

- parses numeric Tinybird deployment ids
- reads Tinybird `feedback` messages such as "already a deployment in progress"
- returns `in_progress` so the CLI waits and retries until Tinybird finishes

Run `strada database upgrade` again if a previous attempt failed with
`Deployment not found`.
