// Type-safe BetterAuth client for the dashboard.
// Used by client components (login button, sidebar logout, device flow).

import { createAuthClient } from 'better-auth/client'
import { deviceAuthorizationClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [deviceAuthorizationClient()],
})
