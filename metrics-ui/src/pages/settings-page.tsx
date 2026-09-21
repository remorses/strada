'use client'

import { SettingsPage, SettingsShell } from '../components/settings-shell.tsx'
import { SETTINGS_NAV } from '../lib/settings-nav.tsx'

export function SettingsSectionPage({ section }: { section: string }) {
  const item = SETTINGS_NAV.find((entry) => entry.href.endsWith(`/${section}`))
  const title = item?.label ?? 'Settings'

  return (
    <SettingsShell items={SETTINGS_NAV}>
      <SettingsPage
        title={title}
        description="Nothing here yet."
      >
        <p className="text-[13px] text-muted-foreground">This section is empty.</p>
      </SettingsPage>
    </SettingsShell>
  )
}
