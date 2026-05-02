/**
 * Vite plugin for injecting Strada release metadata into browser builds.
 * Reads platform-provided commit/branch/deployment variables at build time,
 * falls back to local git when available, and exposes the result to the
 * browser SDK through globalThis.STRADA_RELEASE and import.meta.env values.
 */

import { execSync } from "node:child_process";
import type { Plugin } from "vite";
import type { StradaReleaseMetadata } from "./shared.ts";

export interface StradaVitePluginOptions {
  /** service.version release name. Defaults to STRADA_RELEASE_VERSION, STRADA_RELEASE, SENTRY_RELEASE, or npm_package_version. */
  version?: string;
  /** Full git commit SHA. Defaults to platform env vars, then local git. */
  releaseCommit?: string;
  /** Git branch/ref name. Defaults to platform env vars, then local git. */
  releaseBranch?: string;
  /** Platform deployment/build id. Defaults to platform env vars. */
  deploymentId?: string;
}

function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

function git(command: string): string | undefined {
  try {
    return (
      execSync(`git ${command}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function resolveMetadata(options: StradaVitePluginOptions): StradaReleaseMetadata {
  const commit =
    options.releaseCommit ??
    firstEnv([
      "STRADA_RELEASE_COMMIT",
      "VERCEL_GIT_COMMIT_SHA",
      "RENDER_GIT_COMMIT",
      "CF_PAGES_COMMIT_SHA",
      "WORKERS_CI_COMMIT_SHA",
      "GITHUB_SHA",
      "GIT_COMMIT",
      "CI_COMMIT_SHA",
    ]) ??
    git("rev-parse HEAD");

  return {
    version:
      options.version ??
      firstEnv(["STRADA_RELEASE_VERSION", "STRADA_RELEASE", "SENTRY_RELEASE", "npm_package_version"]),
    commit,
    branch:
      options.releaseBranch ??
      firstEnv([
        "STRADA_RELEASE_BRANCH",
        "VERCEL_GIT_COMMIT_REF",
        "RENDER_GIT_BRANCH",
        "CF_PAGES_BRANCH",
        "WORKERS_CI_BRANCH",
        "GITHUB_HEAD_REF",
        "GITHUB_REF_NAME",
        "CI_COMMIT_BRANCH",
      ]) ??
      git("branch --show-current"),
    deploymentId:
      options.deploymentId ??
      firstEnv([
        "STRADA_DEPLOYMENT_ID",
        "VERCEL_DEPLOYMENT_ID",
        "WORKERS_CI_BUILD_UUID",
        "RENDER_INSTANCE_ID",
        "FLY_MACHINE_VERSION",
        "GITHUB_RUN_ID",
      ]) ??
      commit,
  };
}

function injectionCode(metadata: StradaReleaseMetadata): string {
  return `globalThis.STRADA_RELEASE=${JSON.stringify(metadata)};`;
}

export function stradaVitePlugin(options: StradaVitePluginOptions = {}): Plugin {
  const metadata = resolveMetadata(options);
  const code = injectionCode(metadata);

  return {
    name: "strada-release-metadata",
    config() {
      return {
        define: {
          "import.meta.env.VITE_STRADA_RELEASE_VERSION": JSON.stringify(metadata.version ?? ""),
          "import.meta.env.VITE_STRADA_RELEASE_COMMIT": JSON.stringify(metadata.commit ?? ""),
          "import.meta.env.VITE_STRADA_RELEASE_BRANCH": JSON.stringify(metadata.branch ?? ""),
          "import.meta.env.VITE_STRADA_DEPLOYMENT_ID": JSON.stringify(metadata.deploymentId ?? ""),
        },
      };
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          children: code,
          injectTo: "head-prepend",
        },
      ];
    },
    renderChunk(chunk) {
      return `${code}\n${chunk}`;
    },
  };
}
