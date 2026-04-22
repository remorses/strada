// Typed API client for the Strada website. Uses spiceflow's typed fetch client
// with the website App type for compile-time route validation.

import { createSpiceflowFetch } from "spiceflow/client";
import type { App } from "strada-website/src/app.tsx";

// Register the website app type so createSpiceflowFetch gets typed routes
declare module "spiceflow/client" {
  interface SpiceflowFetchRegister {
    app: App;
  }
}

export function createApiClient(baseUrl: string, sessionToken: string) {
  const authHeaders = {
    Authorization: `Bearer ${sessionToken}`,
  } as const;

  const safeFetch = createSpiceflowFetch(baseUrl);

  return { safeFetch, authHeaders };
}
