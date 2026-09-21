'use client'

import { useState, type ReactNode } from 'react'
import { Link, useRouterState } from 'spiceflow/react'
import { STORES, StoreMark, USERS, useWorkspace, WorkspaceProvider } from '../lib/workspace.tsx'
import { cn } from '../lib/utils.ts'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar.tsx'
import { Button } from './ui/button.tsx'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from './ui/combobox.tsx'

export type SettingsNavItem = {
  href: string
  label: string
  icon: ReactNode
}

export function SettingsShell({
  items,
  children,
}: {
  items: SettingsNavItem[]
  children: ReactNode
}) {
  return (
    <WorkspaceProvider>
      <SettingsFrame items={items}>{children}</SettingsFrame>
    </WorkspaceProvider>
  )
}

function SettingsFrame({ items, children }: { items: SettingsNavItem[]; children: ReactNode }) {
  const { pathname } = useRouterState()
  const { store, user, setStoreId, setUserId } = useWorkspace()

  return (
    <div className="flex min-h-screen bg-canvas text-foreground">
      <aside className="sticky top-0 flex h-dvh w-[220px] shrink-0 flex-col bg-sidebar">
        <div className="px-3 pt-3.5">
          <EntityPicker
            label="Switch store"
            items={STORES}
            value={store}
            onValueChange={(next) => setStoreId(next.id)}
            empty="No stores"
          >
            {(item, place) => (
              <>
                <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
                  <StoreMark id={item.mark} />
                </span>
                <span className="min-w-0 flex-1 leading-[1.15]">
                  {place === 'trigger' ? <span className="block text-[11px] font-normal text-[#9ca3af]">Store</span> : null}
                  <span className="block truncate text-[13px] font-medium text-foreground">{item.name}</span>
                  {place === 'item' ? <span className="block text-[11px] text-[#9ca3af]">{item.plan}</span> : null}
                </span>
              </>
            )}
          </EntityPicker>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-3">
          {items.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] text-[#6b7280] hover:bg-sidebar-accent hover:text-foreground',
                  active && 'bg-[#ececee] font-medium text-foreground',
                )}
              >
                <span className={cn('flex size-4 items-center justify-center text-[#9ca3af]', active && 'text-foreground')}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="px-3 pb-3">
          <EntityPicker
            label="Switch account"
            items={USERS}
            value={user}
            onValueChange={(next) => setUserId(next.id)}
            empty="No accounts"
          >
            {(item, place) => (
              <>
                <Avatar className="size-8">
                  <AvatarImage src={item.avatarSrc} alt="" />
                  <AvatarFallback>{item.name.slice(0, 1)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 leading-[1.15]">
                  <span className="block text-[11px] font-normal text-[#9ca3af]">{place === 'trigger' ? item.role : item.email}</span>
                  <span className="block truncate text-[13px] font-medium text-foreground">{item.name}</span>
                </span>
              </>
            )}
          </EntityPicker>
        </div>
      </aside>
      <div className="min-w-0 flex-1 py-3 pr-3">
        <div className="min-h-[calc(100dvh-1.5rem)] rounded-lg border border-black/6 bg-background">{children}</div>
      </div>
    </div>
  )
}

function EntityPicker<T extends { id: string; name: string }>({
  label,
  items,
  value,
  onValueChange,
  empty,
  children,
}: {
  label: string
  items: T[]
  value: T
  onValueChange: (value: T) => void
  empty: string
  children: (item: T, place: 'trigger' | 'item') => ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <Combobox
      items={items}
      value={value}
      onValueChange={(next) => {
        if (!next) return
        onValueChange(next)
      }}
      open={open}
      onOpenChange={setOpen}
      autoHighlight
      itemToStringValue={(item) => item.name}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2.5 px-1 py-1 text-left font-normal shadow-none ring-0 hover:bg-sidebar-accent focus:ring-0 focus-visible:ring-2 data-popup-open:ring-0 [&>[data-slot=combobox-icon]]:ml-auto"
          />
        }
        aria-label={label}
      >
        {children(value, 'trigger')}
      </ComboboxTrigger>
      <ComboboxContent className="min-w-64">
        <ComboboxInput showTrigger={false} placeholder={label} />
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList>
          {(item: T) => (
            <ComboboxItem key={item.id} value={item}>
              {children(item, 'item')}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

export function SettingsPage({
  title,
  description,
  children,
}: {
  title?: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-8 px-8 py-6">
        {title ? (
          <div className="flex max-w-[860px] flex-col gap-2">
            <h1 className="text-[22px] leading-none font-semibold tracking-tight">{title}</h1>
            {description ? <p className="text-[13px] leading-5 text-muted-foreground">{description}</p> : null}
          </div>
        ) : null}
        <div className={cn('flex flex-col gap-8', title && 'max-w-[860px] gap-10')}>{children}</div>
      </div>
    </div>
  )
}
