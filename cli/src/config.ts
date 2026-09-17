// CLI config file management. Stores auth and cwd-scoped org/project defaults in ~/.strada/config.json.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".strada");
const DEFAULT_CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface CachedProject {
  id: string;
  slug: string;
}

export interface ScopedEntry {
  /** BetterAuth session token (bearer token from device flow) */
  sessionToken?: string;
  /** Website base URL */
  baseUrl?: string;
  /** Default org for this directory scope */
  orgId?: string;
  orgName?: string;
  /** Default project for this directory scope */
  projectId?: string;
  projectSlug?: string;
}

export interface CliConfig {
  /** Directory-scoped auth and org/project defaults. Longest matching scope wins per field. */
  scoped?: Record<string, ScopedEntry>;
  /** Cached project slug→id mappings keyed by org ID, refreshed on cache miss */
  projectCacheByOrg?: Record<string, CachedProject[]>;
}

const scopedEntryKeys: Array<keyof ScopedEntry> = [
  "sessionToken",
  "baseUrl",
  "orgId",
  "orgName",
  "projectId",
  "projectSlug",
];

function configFilePath() {
  return process.env.STRADA_CONFIG_FILE || DEFAULT_CONFIG_FILE;
}

export function normalizeScope(scope: string): string {
  if (scope === "/") return "/";
  return path.resolve(scope);
}

function isScopeMatch(cwd: string, scope: string): boolean {
  if (scope === "/") return true;
  if (!cwd.startsWith(scope)) return false;
  return cwd.length === scope.length || cwd[scope.length] === path.sep;
}

export function resolveScopedEntry(config: CliConfig, cwd = process.cwd()): ScopedEntry {
  const normalizedCwd = normalizeScope(cwd);
  const result: ScopedEntry = {};
  const best: Record<keyof ScopedEntry, number> = {
    sessionToken: -1,
    baseUrl: -1,
    orgId: -1,
    orgName: -1,
    projectId: -1,
    projectSlug: -1,
  };

  for (const [rawScope, entry] of Object.entries(config.scoped ?? {})) {
    const scope = normalizeScope(rawScope);
    if (!isScopeMatch(normalizedCwd, scope)) continue;

    for (const key of scopedEntryKeys) {
      const value = entry[key];
      if (value !== undefined && scope.length >= best[key]) {
        result[key] = value;
        best[key] = scope.length;
      }
    }
  }

  return result;
}

export function loadConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf-8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: CliConfig): void {
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

/** Merge partial fields into the existing config without overwriting other keys. */
export function updateConfig(partial: Partial<CliConfig>): void {
  const existing = loadConfig();
  saveConfig({ ...existing, ...partial });
}

export function setScope(scope: string, updates: ScopedEntry): void {
  const config = loadConfig();
  const normalizedScope = normalizeScope(scope);
  const scoped = { ...config.scoped };
  scoped[normalizedScope] = { ...scoped[normalizedScope], ...updates };
  saveConfig({ ...config, scoped });
}

export function clearScope(scope: string): void {
  const config = loadConfig();
  const normalizedScope = normalizeScope(scope);
  const scoped = { ...config.scoped };
  delete scoped[normalizedScope];
  saveConfig({ ...config, scoped });
}

export type AuthCtx = {
  process?: { env?: Record<string, string | undefined>; cwd?: string };
};

export function getResolvedConfig(cwd = process.cwd()): ScopedEntry {
  return resolveScopedEntry(loadConfig(), cwd);
}

export function getSessionToken(): string | undefined {
  return getResolvedConfig().sessionToken;
}

export function getBaseUrl(): string {
  return getResolvedConfig().baseUrl || "https://strada.sh";
}

export function requireAuth(ctx?: AuthCtx): { sessionToken: string; baseUrl: string } {
  const env = ctx?.process?.env ?? {};
  if (env.STRADA_SESSION_TOKEN) {
    return {
      sessionToken: env.STRADA_SESSION_TOKEN,
      baseUrl: env.STRADA_API_URL || "https://strada.sh",
    };
  }
  const config = getResolvedConfig(ctx?.process?.cwd);
  if (!config.sessionToken) {
    throw new Error("Not logged in. Run `strada login` first.");
  }
  return {
    sessionToken: config.sessionToken,
    baseUrl: config.baseUrl || "https://strada.sh",
  };
}
