---
'@strada.sh/sdk': minor
'strada': minor
'strada-website': minor
---

Track unique visitors the way a typical analytics product does.

**Two cookies.** `strada_vid` is the anonymous visitor (`visitor.id`). `strada_uid` stays the signed-in account (`user.id`). Login and logout do not touch `strada_vid`. No localStorage.

**Pageviews.** Unique visitors in the pages MV use `visitor.id`, with `session.id` as fallback for old data. First visits use the same MV `FirstVisits` column. Tab focus no longer starts an extra pageview. SPA navigations use the Navigation API only, and only `sameDocument` navigations, so a full page load is not counted twice. `identifyUser()` updates `strada_uid` without restarting the active pageview.

**CLI without SQL.** New commands:

```sh
strada analytics overview -p my-app --since 7d
strada analytics timeseries -p my-app --since 30d
strada analytics visitors -p my-app --since 7d
```

`overview` prints unique visitors, first visits, pageviews, sessions, bounce rate, top pages, and top referrers. The pages target adds `FirstVisits` with an automatic Tinybird `ALTER`, and the existing MV starts writing it with `DEPLOYMENT_METHOD alter`. Existing analytics rows are not backfilled.
