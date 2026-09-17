import { AsyncLocalStorage } from "node:async_hooks";

export type InProcessMcp = {
  userId: string;
  user: { name: string; email: string };
  baseUrl: string;
  fetch: typeof fetch;
};

export const inProcessMcp = new AsyncLocalStorage<InProcessMcp>();
