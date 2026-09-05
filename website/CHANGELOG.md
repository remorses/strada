# Changelog

## 0.1.0

1. **Landing hero and docs refresh** — homepage uses **Syne** for heading and body type. The hero CTA is **Sign up with Google**. `/signup` redirects to `/login`. `/pricing` redirects to Tinybird pricing.

2. **Health checks and rewritten alerts** — URL health checks run as a Cloudflare Workflow. Error alerts support multiple named rules per org with project-scoped overrides. Destinations are org-scoped and shared with health checks.

3. **CLI docs tab** — generated pages for every `strada` command, plus alerts and health-checks guides.

4. **AI bot detection in analytics** — `BotName` on the analytics materialized views (`ChatGPT`, `Claude`, `Perplexity`, `Gemini`, `Copilot`, `Meta`, `other-bot`, or empty for humans).

5. **CLI sessions last one year** — Better Auth device-flow sessions expire after 365 days and refresh at most once per day.

6. **Device flow and query reliability** — device-flow poll reads the response body once. Drizzle D1 batch `findFirst` no longer crashes. Tinybird schema upgrades can wait for slow data migrations and apply destructive datasource cleanup.
