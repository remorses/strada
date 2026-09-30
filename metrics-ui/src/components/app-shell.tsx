'use client'

import {
  ActivityIcon,
  BarChart3Icon,
  CircleDollarSignIcon,
  CreditCardIcon,
  HeartPulseIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useRouterState } from 'spiceflow/react'
import { PROJECTS } from '../lib/mock-data.ts'
import { ProjectMark, USERS, useWorkspace, WorkspaceProvider } from '../lib/workspace.tsx'
import { cn } from '../lib/utils.ts'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar.tsx'
import { Button } from './ui/button.tsx'
import { ThemeSwitcher } from '../lib/theme.tsx'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxFooter,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from './ui/combobox.tsx'

type NavItem = {
  href: string
  label: string
  icon: ReactNode
  badge?: string
  badgeTone?: 'destructive'
}

const MAIN_NAV: NavItem[] = [
  { href: '/issues', label: 'Issues', icon: <TriangleAlertIcon className="size-3.5" />, badge: '7' },
  { href: '/traces', label: 'Traces', icon: <ActivityIcon className="size-3.5" /> },
  { href: '/logs', label: 'Logs', icon: <ScrollTextIcon className="size-3.5" /> },
  { href: '/health-checks', label: 'Health checks', icon: <HeartPulseIcon className="size-3.5" />, badge: '1 down', badgeTone: 'destructive' },
  { href: '/analytics', label: 'Analytics', icon: <BarChart3Icon className="size-3.5" /> },
]

const SETTINGS_NAV: NavItem[] = [
  { href: '/usage', label: 'Usage', icon: <CircleDollarSignIcon className="size-3.5" /> },
  { href: '/plans', label: 'Plans', icon: <CreditCardIcon className="size-3.5" /> },
]

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <AppFrame>{children}</AppFrame>
    </WorkspaceProvider>
  )
}

function AppFrame({ children }: { children: ReactNode }) {
  const { project, user, setProjectId, setUserId } = useWorkspace()

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[var(--page-width)] bg-background text-foreground">
      <aside className="sticky top-0 h-dvh w-[248px] shrink-0 py-4 pr-4 pl-3">
        <div className="flex h-full flex-col rounded-xl bg-sidebar">
          <div className="px-2 pt-2">
            <EntityPicker
              label="Switch project"
              items={PROJECTS}
              itemLabel={(item) => item.slug}
              value={project}
              onValueChange={(next) => setProjectId(next.id)}
              empty="No projects"
            >
              {(item, place) => (
                <>
                  <span className="flex size-7 shrink-0 overflow-hidden rounded-md">
                    <ProjectMark project={item} />
                  </span>
                  <span className="min-w-0 flex-1 leading-[1.15]">
                    <span className="block text-[11px] font-normal text-muted-foreground">
                      {place === 'trigger' ? 'strada.sh' : `${item.services.length} services`}
                    </span>
                    <span className="block truncate text-[13px] font-medium text-foreground">{item.slug}</span>
                  </span>
                </>
              )}
            </EntityPicker>
          </div>
          <nav className="flex flex-1 flex-col gap-0.5 px-2 pt-3">
            <NavLinks items={MAIN_NAV} />
            <div className="px-2 pt-5 pb-1 text-[11px] font-medium text-muted-foreground">Settings</div>
            <NavLinks items={SETTINGS_NAV} />
          </nav>
          <div className="px-2 pb-2">
            <EntityPicker
              label="Switch account"
              items={USERS}
              itemLabel={(item) => item.name}
              value={user}
              onValueChange={(next) => setUserId(next.id)}
              empty="No accounts"
              footer={<ThemeSwitcher />}
            >
              {(item, place) => (
                <>
                  <Avatar className="size-8">
                    <AvatarImage src={item.avatarSrc} alt="" />
                    <AvatarFallback>{item.name.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1 leading-[1.15]">
                    <span className="block text-[11px] font-normal text-muted-foreground">{place === 'trigger' ? item.role : item.email}</span>
                    <span className="block truncate text-[13px] font-medium text-foreground">{item.name}</span>
                  </span>
                </>
              )}
            </EntityPicker>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1 bg-background">{children}</div>
    </div>
  )
}

function NavLinks({ items }: { items: NavItem[] }) {
  const { pathname } = useRouterState()
  return items.map((item) => {
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
    return (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          'flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
          active && 'bg-sidebar-accent font-medium text-foreground',
        )}
      >
        <span className={cn('flex size-4 items-center justify-center text-muted-foreground', active && 'text-foreground')}>
          {item.icon}
        </span>
        <span className="flex-1">{item.label}</span>
        {item.badge ? (
          <span
            className={cn(
              'text-[11px] tabular-nums text-muted-foreground',
              item.badgeTone === 'destructive' && 'rounded-full bg-destructive/12 px-1.5 py-px font-medium text-destructive',
            )}
          >
            {item.badge}
          </span>
        ) : null}
      </Link>
    )
  })
}

function EntityPicker<T extends { id: string }>({
  label,
  items,
  itemLabel,
  value,
  onValueChange,
  empty,
  footer,
  children,
}: {
  label: string
  items: T[]
  itemLabel: (item: T) => string
  value: T
  onValueChange: (value: T) => void
  empty: string
  footer?: ReactNode
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
      itemToStringValue={itemLabel}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2.5 px-1 py-1 text-left font-normal shadow-none ring-0 hover:bg-sidebar-accent focus-visible:ring-2 data-popup-open:ring-0 [&>[data-slot=combobox-icon]]:ml-auto"
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
        {footer ? <ComboboxFooter>{footer}</ComboboxFooter> : null}
      </ComboboxContent>
    </Combobox>
  )
}

// Wide layout for the telemetry tabs.
export function DashboardPage({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[var(--dash-width)] flex-col gap-6 px-6 py-6">{children}</div>
  )
}

// Narrow layout for settings pages (usage, plans).
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
      <div className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-8 px-6 py-6">
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
