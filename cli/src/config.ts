// CLI config file management. Stores auth session token in ~/.strada/config.json.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".strada");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface CachedProject {
  id: string;
  slug: string;
}

export interface CliConfig {
  /** BetterAuth session token (bearer token from device flow) */
  sessionToken?: string;
  /** Website base URL */
  baseUrl?: string;
  /** Currently selected org ID. When unset, the CLI falls back to ensure-default. */
  currentOrgId?: string;
  /** Cached project slug→id mappings keyed by org ID, refreshed on cache miss */
  projectsByOrg?: Record<string, CachedProject[]>;
}

export function loadConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: CliConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/** Merge partial fields into the existing config without overwriting other keys. */
export function updateConfig(partial: Partial<CliConfig>): void {
  const existing = loadConfig();
  saveConfig({ ...existing, ...partial });
}

export function getSessionToken(): string | undefined {
  return loadConfig().sessionToken;
}

export function getBaseUrl(): string {
  return loadConfig().baseUrl || "https://strada.sh";
}

export function requireAuth(): { sessionToken: string; baseUrl: string } {
  const config = loadConfig();
  if (!config.sessionToken) {
    throw new Error("Not logged in. Run `strada login` first.");
  }
  return {
    sessionToken: config.sessionToken,
    baseUrl: config.baseUrl || "https://strada.sh",
  };
}
