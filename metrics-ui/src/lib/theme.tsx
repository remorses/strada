'use client'

import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { cn } from './utils.ts'

export const THEME_KEY = 'metrics-ui-theme'
export type ThemeChoice = 'light' | 'dark' | 'system'

const THEME_EVENT = 'metrics-ui-theme'

function readChoice(): ThemeChoice {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'system'
}

export function applyTheme(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

function subscribe(onStoreChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY) onStoreChange()
  }
  window.addEventListener(THEME_EVENT, onStoreChange)
  window.addEventListener('storage', onStorage)
  media.addEventListener('change', onStoreChange)
  return () => {
    window.removeEventListener(THEME_EVENT, onStoreChange)
    window.removeEventListener('storage', onStorage)
    media.removeEventListener('change', onStoreChange)
  }
}

function getServerChoice(): ThemeChoice {
  return 'system'
}

export function useTheme() {
  const choice = useSyncExternalStore(subscribe, readChoice, getServerChoice)
  return {
    choice,
    setChoice(next: ThemeChoice) {
      localStorage.setItem(THEME_KEY, next)
      applyTheme(next)
      window.dispatchEvent(new Event(THEME_EVENT))
    },
  }
}

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
}

const LABEL: Record<ThemeChoice, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

export function ThemeSwitcher({ className }: { className?: string }) {
  const { choice, setChoice } = useTheme()
  const Icon = choice === 'dark' ? MoonIcon : choice === 'light' ? SunIcon : MonitorIcon
  return (
    <button
      type="button"
      onClick={() => setChoice(NEXT[choice])}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{LABEL[choice]}</span>
    </button>
  )
}
