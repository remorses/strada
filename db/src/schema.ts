// Schema for the Strada D1 database.
// Contains BetterAuth core tables, org/project hierarchy, database config,
// and org-wide ingest tokens for collector authentication.

import { defineRelations } from "drizzle-orm";
import * as s from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

// Integer column that stores epoch milliseconds as a plain number.
// Accepts Date objects in toDriver so BetterAuth's internal Date params
// don't crash D1's .bind() which only accepts string | number | null | ArrayBuffer.
export const epochMs = s.customType<{ data: number; driverParam: number }>({
  dataType() {
    return "integer";
  },
  toDriver(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    return value as number;
  },
  fromDriver(value: unknown): number {
    return value as number;
  },
});

// ── BetterAuth core tables ──────────────────────────────────────────

export const user = s.sqliteTable("user", {
  id: s
    .text("id")
    .primaryKey()
    .notNull()
    .$defaultFn(() => ulid()),
  name: s.text("name").notNull(),
  email: s.text("email").notNull().unique(),
  emailVerified: s
    .integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: s.text("image"),
  createdAt: epochMs("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
  updatedAt: epochMs("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const session = s.sqliteTable(
  "session",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    userId: s
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: s.text("token").notNull().unique(),
    expiresAt: epochMs("expires_at").notNull(),
    ipAddress: s.text("ip_address"),
    userAgent: s.text("user_agent"),
    createdAt: epochMs("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: epochMs("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [s.index("session_user_id_idx").on(table.userId)],
);

export const account = s.sqliteTable(
  "account",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    userId: s
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: s.text("account_id").notNull(),
    providerId: s.text("provider_id").notNull(),
    accessToken: s.text("access_token"),
    refreshToken: s.text("refresh_token"),
    accessTokenExpiresAt: epochMs("access_token_expires_at"),
    refreshTokenExpiresAt: epochMs("refresh_token_expires_at"),
    scope: s.text("scope"),
    idToken: s.text("id_token"),
    password: s.text("password"),
    createdAt: epochMs("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: epochMs("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [s.index("account_user_id_idx").on(table.userId)],
);

export const verification = s.sqliteTable("verification", {
  id: s
    .text("id")
    .primaryKey()
    .notNull()
    .$defaultFn(() => ulid()),
  identifier: s.text("identifier").notNull(),
  value: s.text("value").notNull(),
  expiresAt: epochMs("expires_at").notNull(),
  createdAt: epochMs("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
  updatedAt: epochMs("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

// ── Org tables ──────────────────────────────────────────────────────

export const org = s.sqliteTable("org", {
  id: s
    .text("id")
    .primaryKey()
    .notNull()
    .$defaultFn(() => ulid()),
  name: s.text("name").notNull(),
  createdAt: epochMs("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
  updatedAt: epochMs("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const orgMember = s.sqliteTable(
  "org_member",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    orgId: s
      .text("org_id")
      .notNull()
      .references(() => org.id, { onDelete: "cascade" }),
    userId: s
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: s
      .text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    createdAt: epochMs("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    s.index("org_member_org_id_idx").on(table.orgId),
    s.index("org_member_user_id_idx").on(table.userId),
    s
      .uniqueIndex("org_member_org_id_user_id_unique")
      .on(table.orgId, table.userId),
  ],
);

// ── Database config ─────────────────────────────────────────────────
// One database config per org. Stores either Tinybird or ClickHouse credentials.
// The collector reads this at ingest time to know where to forward data.

export const database = s.sqliteTable(
  "database",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    orgId: s
      .text("org_id")
      .notNull()
      .unique()
      .references(() => org.id, { onDelete: "cascade" }),
    backend: s.text("backend", { enum: ["tinybird", "clickhouse"] }).notNull(),

    // Tinybird fields (null when backend = clickhouse)
    tinybirdEndpoint: s.text("tinybird_endpoint"),
    tinybirdAdminToken: s.text("tinybird_admin_token"),
    tinybirdReadToken: s.text("tinybird_read_token"),

    // ClickHouse fields (null when backend = tinybird)
    clickhouseUrl: s.text("clickhouse_url"),
    clickhouseDatabase: s.text("clickhouse_database"),
    clickhouseUser: s.text("clickhouse_user"),
    clickhousePassword: s.text("clickhouse_password"),

    createdAt: epochMs("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: epochMs("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [s.index("database_org_id_idx").on(table.orgId)],
);

// ── Projects ────────────────────────────────────────────────────────
// Each project maps to a ProjectId in the OTel tables. The project.id (ULID)
// IS the ProjectId used in ClickHouse/Tinybird. Globally unique.
// The ingest hostname is {projectId}-ingest.strada.sh.

export const project = s.sqliteTable(
  "project",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    slug: s.text("slug").notNull(),
    orgId: s
      .text("org_id")
      .notNull()
      .references(() => org.id, { onDelete: "cascade" }),
    databaseId: s
      .text("database_id")
      .notNull()
      .references(() => database.id, { onDelete: "cascade" }),
    // Tinybird JWT scoped to this project's ProjectId. Generated on first query,
    // cached here so subsequent queries reuse it. The JWT has DATASOURCES:READ
    // scopes with filter "ProjectId = '<id>'" on every datasource, so Tinybird
    // enforces row-level isolation server-side on every query.
    tinybirdJwt: s.text("tinybird_jwt"),
    // Comma-joined datasource names the JWT was created with. If TINYBIRD_DATASOURCES
    // changes (new table added), this won't match and the JWT gets regenerated.
    tinybirdJwtDatasources: s.text("tinybird_jwt_datasources"),
    createdAt: epochMs("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: epochMs("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    s.index("project_org_id_idx").on(table.orgId),
    s.index("project_database_id_idx").on(table.databaseId),
    s.uniqueIndex("project_org_id_slug_unique").on(table.orgId, table.slug),
  ],
);

// ── Org ingest tokens ────────────────────────────────────────────────
// Bearer tokens for server-side ingest. The collector validates the token
// hash against the project's org. The full key is shown once at creation;
// only the SHA-256 hash is stored. Browser ingest intentionally omits this
// token and is rate limited at the Cloudflare Worker layer instead.

export const orgToken = s.sqliteTable(
  "org_token",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    orgId: s
      .text("org_id")
      .notNull()
      .references(() => org.id, { onDelete: "cascade" }),
    name: s.text("name").notNull(),
    // First 12 chars after "str_" prefix, for display
    prefix: s.text("prefix").notNull(),
    // SHA-256 hex digest of the full key
    hashedKey: s.text("hashed_key").notNull().unique(),
    scope: s
      .text("scope", { enum: ["ingest"] })
      .notNull()
      .default("ingest"),
    createdBy: s
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: epochMs("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    s.index("org_token_org_id_idx").on(table.orgId),
    s.index("org_token_hashed_key_idx").on(table.hashedKey),
  ],
);

// ── Alerts ──────────────────────────────────────────────────────────
//
// Three tables form the alerting system: rules, destinations, and a
// junction table linking them many-to-many.
//
//   alert_rule  ◄──  alert_rule_destination  ──►  alert_destination
//   (what to watch)        (N:M link)           (where to send)
//
// RULES define what triggers an alert. Each rule has a `type`:
//   - error_threshold: fires when >= N errors of the same fingerprint
//     occur within a time window. The cron in alert-check.ts queries
//     ClickHouse otel_errors every 5 minutes.
//   - health_check (future): fires when a URL fails consecutive checks.
//     check_* fields will be added to this table later. Check results
//     go to a ClickHouse otel_health_checks table (not D1). Consecutive
//     failure detection is derived at query time from that table. See
//     plans/health-checks-status-pages.md for the full plan.
//
// DESTINATIONS define where alerts are sent. They are org-scoped so
// one destination (e.g. a Slack webhook for #incidents) can be reused
// across many rules. Supported channels:
//   - email: sends an HTML email via Cloudflare Email Workers.
//   - webhook: POSTs JSON to a URL.
//   - slack (future): posts to a Slack incoming webhook.
//
// Type-specific fields are prefixed with their type so they're easy to
// distinguish: error_threshold, error_window_minutes on rules.
// Shared fields like cooldown_minutes are unprefixed.

export const alertRule = s.sqliteTable(
  "alert_rule",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    orgId: s
      .text("org_id")
      .notNull()
      .references(() => org.id, { onDelete: "cascade" }),
    type: s
      .text("type", { enum: ["error_threshold", "health_check"] })
      .notNull()
      .default("error_threshold"),
    name: s.text("name").notNull(),
    enabled: s.integer("enabled", { mode: "boolean" }).notNull().default(true),
    // Minutes to wait before re-alerting the same rule. Shared across all types.
    cooldownMinutes: s.integer("cooldown_minutes").notNull().default(60),
    // Last time this rule fired an alert. Used by health_check rules for dedup
    // (error_threshold rules track cooldown per-fingerprint in otel_issue_state).
    lastAlertedAt: epochMs("last_alerted_at"),

    // ── error_threshold fields (null when type != 'error_threshold') ──
    // Alert when >= errorThreshold errors of the same fingerprint occur
    // within errorWindowMinutes. Checked by the cron every 5 minutes.
    errorThreshold: s.integer("error_threshold"),
    errorWindowMinutes: s.integer("error_window_minutes"),

    // ── health_check fields (future, not yet added) ──
    // check_url, check_interval_minutes, check_expected_status_min,
    // check_expected_status_max, check_max_latency_ms,
    // check_failure_threshold, check_regions

    createdAt: epochMs("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: epochMs("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    s.index("alert_rule_org_id_idx").on(table.orgId),
    s
      .uniqueIndex("alert_rule_org_id_type_name_unique")
      .on(table.orgId, table.type, table.name),
  ],
);

export const alertDestination = s.sqliteTable(
  "alert_destination",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    orgId: s
      .text("org_id")
      .notNull()
      .references(() => org.id, { onDelete: "cascade" }),
    channel: s
      .text("channel", { enum: ["email", "webhook", "slack"] })
      .notNull(),
    // Email address, webhook URL, or Slack webhook URL
    destination: s.text("destination").notNull(),

    createdAt: epochMs("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    s.index("alert_destination_org_id_idx").on(table.orgId),
    s
      .uniqueIndex("alert_destination_unique")
      .on(table.orgId, table.channel, table.destination),
  ],
);

// Junction table. One rule can fire to many destinations, and one destination
// (e.g. ops@company.com) can be attached to many rules.
export const alertRuleDestination = s.sqliteTable(
  "alert_rule_destination",
  {
    ruleId: s
      .text("rule_id")
      .notNull()
      .references(() => alertRule.id, { onDelete: "cascade" }),
    destinationId: s
      .text("destination_id")
      .notNull()
      .references(() => alertDestination.id, { onDelete: "cascade" }),
  },
  (table) => [
    s
      .uniqueIndex("alert_rule_destination_unique")
      .on(table.ruleId, table.destinationId),
    s.index("alert_rule_destination_rule_id_idx").on(table.ruleId),
    s
      .index("alert_rule_destination_destination_id_idx")
      .on(table.destinationId),
  ],
);

// ── Device flow (BetterAuth device authorization plugin) ────────────

export const deviceCode = s.sqliteTable(
  "device_code",
  {
    id: s
      .text("id")
      .primaryKey()
      .notNull()
      .$defaultFn(() => ulid()),
    deviceCode: s.text("device_code").notNull().unique(),
    userCode: s.text("user_code").notNull().unique(),
    userId: s
      .text("user_id")
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: epochMs("expires_at").notNull(),
    status: s
      .text("status", { enum: ["pending", "approved", "denied", "expired"] })
      .notNull()
      .default("pending"),
    lastPolledAt: epochMs("last_polled_at"),
    pollingInterval: s.integer("polling_interval", { mode: "number" }),
    clientId: s.text("client_id"),
    scope: s.text("scope"),
  },
  (table) => [s.index("device_code_user_id_idx").on(table.userId)],
);

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  {
    user,
    session,
    account,
    verification,
    org,
    orgMember,
    database,
    project,
    orgToken,
    deviceCode,
    alertRule,
    alertDestination,
    alertRuleDestination,
  },
  (r) => ({
    user: {
      sessions: r.many.session(),
      accounts: r.many.account(),
      orgs: r.many.org({
        from: r.user.id.through(r.orgMember.userId),
        to: r.org.id.through(r.orgMember.orgId),
      }),
    },
    session: {
      user: r.one.user({ from: r.session.userId, to: r.user.id }),
    },
    account: {
      user: r.one.user({ from: r.account.userId, to: r.user.id }),
    },
    verification: {},
    org: {
      members: r.many.orgMember(),
      database: r.one.database(),
      projects: r.many.project(),
      tokens: r.many.orgToken(),
      alertRules: r.many.alertRule(),
      alertDestinations: r.many.alertDestination(),
      users: r.many.user({
        from: r.org.id.through(r.orgMember.orgId),
        to: r.user.id.through(r.orgMember.userId),
      }),
    },
    orgMember: {
      org: r.one.org({ from: r.orgMember.orgId, to: r.org.id }),
      user: r.one.user({ from: r.orgMember.userId, to: r.user.id }),
    },
    database: {
      org: r.one.org({ from: r.database.orgId, to: r.org.id }),
      projects: r.many.project(),
    },
    project: {
      org: r.one.org({ from: r.project.orgId, to: r.org.id }),
      database: r.one.database({
        from: r.project.databaseId,
        to: r.database.id,
      }),
    },
    orgToken: {
      org: r.one.org({ from: r.orgToken.orgId, to: r.org.id }),
      creator: r.one.user({ from: r.orgToken.createdBy, to: r.user.id }),
    },
    deviceCode: {
      user: r.one.user({ from: r.deviceCode.userId, to: r.user.id }),
    },
    alertRule: {
      org: r.one.org({ from: r.alertRule.orgId, to: r.org.id }),
      destinations: r.many.alertDestination({
        from: r.alertRule.id.through(r.alertRuleDestination.ruleId),
        to: r.alertDestination.id.through(r.alertRuleDestination.destinationId),
      }),
    },
    alertDestination: {
      org: r.one.org({ from: r.alertDestination.orgId, to: r.org.id }),
      rules: r.many.alertRule({
        from: r.alertDestination.id.through(
          r.alertRuleDestination.destinationId,
        ),
        to: r.alertRule.id.through(r.alertRuleDestination.ruleId),
      }),
    },
    alertRuleDestination: {
      rule: r.one.alertRule({
        from: r.alertRuleDestination.ruleId,
        to: r.alertRule.id,
      }),
      destination: r.one.alertDestination({
        from: r.alertRuleDestination.destinationId,
        to: r.alertDestination.id,
      }),
    },
  }),
);
