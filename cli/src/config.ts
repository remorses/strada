// CLI config file management. Stores auth session token in ~/.strada/config.json.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".strada");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface CliConfig {
  /** BetterAuth session token (bearer token from device flow) */
  sessionToken?: string;
  /** Website base URL */
  baseUrl?: string;
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
