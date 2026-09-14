---
'@strada.sh/sdk': minor
'strada': minor
'strada-website': minor
---

Track unique visitors the way a typical analytics product does.

**Two cookies.** `strada_vid` is the anonymous visitor (`visitor.id`). `strada_uid` stays the signed-in account (`user.id`). Login and logout do not touch `strada_vid`. No localStorage.

**Pageviews.** Unique visitors in the pages MV use `visitor.id`, with `session.id` as fallback for old data. Tab focus no longer starts a extra pageview. SPA clicks use the Navigation API only, and only `sameDocument` navigations, so a full page load is not counted twice.

**CLI without SQL.** New commands:

```sh
strada analytics overview -p my-app --since 7d
strada analytics timeseries -p my-app --since 30d
strada analytics visitors -p my-app --since 7d
```

`overview` prints unique visitors, first visits, pageviews, sessions, bounce rate, top pages, and top referrers. Run `strada database upgrade` so the pages MV unique-counts `visitor.id`.
