import {
  ActivityIcon,
  BlocksIcon,
  BoxIcon,
  CircleDollarSignIcon,
  CircleDotIcon,
  InboxIcon,
  LinkIcon,
  MessageSquareTextIcon,
  SettingsIcon,
  SquareIcon,
  UserIcon,
  UsersIcon,
  WaypointsIcon,
} from 'lucide-react'
import type { SettingsNavItem } from '../components/settings-shell.tsx'

export const SETTINGS_NAV: SettingsNavItem[] = [
  { href: '/', label: 'Function', icon: <ActivityIcon className="size-3.5" /> },
  { href: '/sandboxes', label: 'Sandboxes', icon: <BoxIcon className="size-3.5" /> },
  { href: '/usage', label: 'Usage', icon: <CircleDollarSignIcon className="size-3.5" /> },
  { href: '/settings/general', label: 'General settings', icon: <CircleDotIcon className="size-3.5" /> },
  { href: '/settings/account', label: 'Account settings', icon: <SettingsIcon className="size-3.5" /> },
  { href: '/settings/inboxes', label: 'Inboxes', icon: <InboxIcon className="size-3.5" /> },
  { href: '/settings/agents', label: 'Agents', icon: <UserIcon className="size-3.5" /> },
  { href: '/settings/teams', label: 'Teams', icon: <UsersIcon className="size-3.5" /> },
  { href: '/settings/labels', label: 'Labels', icon: <SquareIcon className="size-3.5" /> },
  { href: '/settings/attributes', label: 'Custom attributes', icon: <LinkIcon className="size-3.5" /> },
  { href: '/settings/automation', label: 'Automation', icon: <WaypointsIcon className="size-3.5" /> },
  { href: '/settings/canned', label: 'Canned responses', icon: <MessageSquareTextIcon className="size-3.5" /> },
  { href: '/settings/integrations', label: 'Integrations', icon: <BlocksIcon className="size-3.5" /> },
  { href: '/plans', label: 'Plans', icon: <CircleDollarSignIcon className="size-3.5" /> },
]
