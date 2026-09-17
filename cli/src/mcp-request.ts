// Request-scoped MCP principal. Set only after requireMcpAuth verifies the JWT.
// getSession() reads this so /api/v0 never sees the MCP access token.
import { AsyncLocalStorage } from "node:async_hooks";

export type InProcessMcp = {
  userId: string;
  user: { name: string; email: string };
  baseUrl: string;
  fetch: typeof fetch;
};

export const inProcessMcp = new AsyncLocalStorage<InProcessMcp>();
