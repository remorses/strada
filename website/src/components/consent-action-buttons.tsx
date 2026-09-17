'use client'

import { ErrorBoundary } from 'spiceflow/react'
import { Button } from './ui/button.tsx'

type ConsentAction = (formData: FormData) => Promise<void>

function ConsentActionError() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
      <ErrorBoundary.ResetButton className="text-sm font-medium text-destructive underline underline-offset-4">
        Try again
      </ErrorBoundary.ResetButton>
    </div>
  )
}

export function ConsentActionButtons({
  approveAction,
  denyAction,
}: {
  approveAction: ConsentAction
  denyAction: ConsentAction
}) {
  return (
    <ErrorBoundary fallback={<ConsentActionError />}>
      <div className="flex flex-col gap-3 sm:flex-row">
        <form action={approveAction} className="flex-1">
          <Button className="w-full" type="submit">
            Allow access
          </Button>
        </form>
        <form action={denyAction} className="flex-1">
          <Button className="w-full" type="submit" variant="outline">
            Deny
          </Button>
        </form>
      </div>
    </ErrorBoundary>
  )
}
