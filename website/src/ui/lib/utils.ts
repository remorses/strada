// Shared utilities for the dashboard UI components.
// Only the subset actually used by the widget/chart components.

import * as React from "react"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── Dark mode detection (hydration-safe) ───────────────────────

function getIsDark(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.classList.contains("dark")
}
const getServerIsDark = () => false

function subscribeTheme(cb: () => void) {
  if (typeof window === "undefined") return () => {}
  const observer = new MutationObserver(cb)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

export function useIsDark() {
  return React.useSyncExternalStore(subscribeTheme, getIsDark, getServerIsDark)
}

// ─── Container size hook ────────────────────────────────────────

export function useContainerSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = React.useState({ width: 0, height: 0 })

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return size
}
