// Client component for the login page sign-in button.
// Uses the type-safe BetterAuth client to trigger the Google OAuth flow.
// This approach lets BetterAuth handle the full OAuth redirect, state cookie,
// and session cookie internally, avoiding issues with manual cookie forwarding.

"use client"

import { useState } from "react"
import { Button } from "./ui/button.tsx"
import { authClient } from "../auth-client.ts"

export function LoginButton({ callbackURL = "/" }: { callbackURL?: string }) {
  const [loading, setLoading] = useState(false)

  async function handleSignIn() {
    setLoading(true)
    await authClient.signIn.social({
      provider: "google",
      callbackURL,
    })
  }

  return (
    <Button
      onClick={handleSignIn}
      loading={loading}
      size="lg"
      className="w-full"
    >
      Sign in with Google
    </Button>
  )
}
