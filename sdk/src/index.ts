/**
 * Default entry point for @strada.sh/sdk.
 *
 * In Node.js / Bun / Deno this re-exports the Node runtime implementation.
 * In browsers, bundlers resolve the "browser" condition in package.json
 * exports to browser.ts instead of this file.
 *
 * Users who want explicit control can import from:
 * - "@strada.sh/sdk/node"
 * - "@strada.sh/sdk/browser"
 */

export {
  initStrada,
  captureException,
  flush,
  shutdown,
  setUser,
  setTags,
  type StradaOptions,
  type CaptureExceptionOptions,
  type UserContext,
} from "./node.ts";
