---
'strada': patch
'strada-website': patch
---

Drop unused `BotName` from analytics schema so Tinybird can add `FirstVisits` as a cheap `ALTER`.

`BotName` never shipped to live. Live `otel_analytics_pages` columns are still the April schema: no `BotName`, no `FirstVisits`. Putting `BotName` in the pages sorting key forced a full table rewrite. Staging deploy 7 sat on that rewrite for months.

This upgrade adds `FirstVisits` to `otel_analytics_pages` and changes the existing pages MV with `DEPLOYMENT_METHOD alter`. The target column and MV output must change together because Tinybird requires exact column matching. Both changes use metadata-only `ALTER` operations, with no historical backfill. Device still classifies crawlers as `bot`.

After website prod deploy:

```sh
strada database upgrade
```

Stop if Tinybird reports a rewrite, populate, or backfill.
