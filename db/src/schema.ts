// Schema for the Strada D1 database.
// Contains BetterAuth core tables, org/project hierarchy, database config,
// and project tokens for ingest authentication.

import { defineRelations } from 'drizzle-orm'
import * as sqliteCore from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

// Integer column that stores epoch milliseconds as a plain number.
// Accepts Date objects in toDriver so BetterAuth's internal Date params
// don't crash D1's .bind() which only accepts string | number | null | ArrayBuffer.
export const epochMs = sqliteCore.customType<{ data: number; driverParam: number }>({
  dataType() { return 'integer' },
  toDriver(value: unknown): number {
    if (value instanceof Date) return value.getTime()
    return value as number
  },
  fromDriver(value: unknown): number { return value as number },
})

// ── BetterAuth core tables ──────────────────────────────────────────

export const user = sqliteCore.sqliteTable('user', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  email: sqliteCore.text('email').notNull().unique(),
  emailVerified: sqliteCore.integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: sqliteCore.text('image'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

export const session = sqliteCore.sqliteTable('session', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: sqliteCore.text('token').notNull().unique(),
  expiresAt: epochMs('expires_at').notNull(),
  ipAddress: sqliteCore.text('ip_address'),
  userAgent: sqliteCore.text('user_agent'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('session_user_id_idx').on(table.userId),
])

export const account = sqliteCore.sqliteTable('account', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: sqliteCore.text('account_id').notNull(),
  providerId: sqliteCore.text('provider_id').notNull(),
  accessToken: sqliteCore.text('access_token'),
  refreshToken: sqliteCore.text('refresh_token'),
  accessTokenExpiresAt: epochMs('access_token_expires_at'),
  refreshTokenExpiresAt: epochMs('refresh_token_expires_at'),
  scope: sqliteCore.text('scope'),
  idToken: sqliteCore.text('id_token'),
  password: sqliteCore.text('password'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('account_user_id_idx').on(table.userId),
])

export const verification = sqliteCore.sqliteTable('verification', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  identifier: sqliteCore.text('identifier').notNull(),
  value: sqliteCore.text('value').notNull(),
  expiresAt: epochMs('expires_at').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

// ── Org tables ──────────────────────────────────────────────────────

export const org = sqliteCore.sqliteTable('org', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

export const orgMember = sqliteCore.sqliteTable('org_member', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: sqliteCore.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: sqliteCore.text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('org_member_org_id_idx').on(table.orgId),
  sqliteCore.index('org_member_user_id_idx').on(table.userId),
  sqliteCore.uniqueIndex('org_member_org_id_user_id_unique').on(table.orgId, table.userId),
])

// ── Database config ─────────────────────────────────────────────────
// One database config per org. Stores either Tinybird or ClickHouse credentials.
// The collector reads this at ingest time to know where to forward data.

export const database = sqliteCore.sqliteTable('database', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: sqliteCore.text('org_id').notNull().unique().references(() => org.id, { onDelete: 'cascade' }),
  backend: sqliteCore.text('backend', { enum: ['tinybird', 'clickhouse'] }).notNull(),

  // Tinybird fields (null when backend = clickhouse)
  tinybirdEndpoint: sqliteCore.text('tinybird_endpoint'),
  tinybirdAdminToken: sqliteCore.text('tinybird_admin_token'),
  tinybirdReadToken: sqliteCore.text('tinybird_read_token'),

  // ClickHouse fields (null when backend = tinybird)
  clickhouseUrl: sqliteCore.text('clickhouse_url'),
  clickhouseDatabase: sqliteCore.text('clickhouse_database'),
  clickhouseUser: sqliteCore.text('clickhouse_user'),
  clickhousePassword: sqliteCore.text('clickhouse_password'),

  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('database_org_id_idx').on(table.orgId),
])

// ── Projects ────────────────────────────────────────────────────────
// Each project maps to a ProjectId in the OTel tables. The project.id (ULID)
// IS the ProjectId used in ClickHouse/Tinybird. Globally unique.
// The ingest hostname is {projectId}-ingest.strada.sh.

export const project = sqliteCore.sqliteTable('project', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  slug: sqliteCore.text('slug').notNull(),
  orgId: sqliteCore.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  databaseId: sqliteCore.text('database_id').notNull().references(() => database.id, { onDelete: 'cascade' }),
  // Tinybird JWT scoped to this project's ProjectId. Generated on first query,
  // cached here so subsequent queries reuse it. The JWT has DATASOURCES:READ
  // scopes with filter "ProjectId = '<id>'" on every datasource, so Tinybird
  // enforces row-level isolation server-side on every query.
  tinybirdJwt: sqliteCore.text('tinybird_jwt'),
  // Comma-joined datasource names the JWT was created with. If TINYBIRD_DATASOURCES
  // changes (new table added), this won't match and the JWT gets regenerated.
  tinybirdJwtDatasources: sqliteCore.text('tinybird_jwt_datasources'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('project_org_id_idx').on(table.orgId),
  sqliteCore.index('project_database_id_idx').on(table.databaseId),
  sqliteCore.uniqueIndex('project_org_id_slug_unique').on(table.orgId, table.slug),
])

// ── Project tokens ──────────────────────────────────────────────────
// Bearer tokens for ingest and read access. The collector validates the
// token hash to authenticate incoming OTLP data. The full key is shown
// once at creation; only the SHA-256 hash is stored.

export const projectToken = sqliteCore.sqliteTable('project_token', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  projectId: sqliteCore.text('project_id').notNull().references(() => project.id, { onDelete: 'cascade' }),
  name: sqliteCore.text('name').notNull(),
  // First 12 chars after "str_" prefix, for display
  prefix: sqliteCore.text('prefix').notNull(),
  // SHA-256 hex digest of the full key
  hashedKey: sqliteCore.text('hashed_key').notNull().unique(),
  scope: sqliteCore.text('scope', { enum: ['ingest', 'read'] }).notNull(),
  createdBy: sqliteCore.text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('project_token_project_id_idx').on(table.projectId),
  sqliteCore.index('project_token_hashed_key_idx').on(table.hashedKey),
])

// ── Device flow (BetterAuth device authorization plugin) ────────────

export const deviceCode = sqliteCore.sqliteTable('device_code', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  deviceCode: sqliteCore.text('device_code').notNull().unique(),
  userCode: sqliteCore.text('user_code').notNull().unique(),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: epochMs('expires_at').notNull(),
  status: sqliteCore.text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull().default('pending'),
  lastPolledAt: epochMs('last_polled_at'),
  pollingInterval: sqliteCore.integer('polling_interval', { mode: 'number' }),
  clientId: sqliteCore.text('client_id'),
  scope: sqliteCore.text('scope'),
}, (table) => [
  sqliteCore.index('device_code_user_id_idx').on(table.userId),
])

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, org, orgMember, database, project, projectToken, deviceCode },
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
      database: r.one.database({ from: r.project.databaseId, to: r.database.id }),
      tokens: r.many.projectToken(),
    },
    projectToken: {
      project: r.one.project({ from: r.projectToken.projectId, to: r.project.id }),
      creator: r.one.user({ from: r.projectToken.createdBy, to: r.user.id }),
    },
    deviceCode: {
      user: r.one.user({ from: r.deviceCode.userId, to: r.user.id }),
    },
  }),
)
