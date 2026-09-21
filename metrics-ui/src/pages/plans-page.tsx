'use client'

import { PlanCards, PlanFeatureTable, type PlanColumn, type PlanFeatureRow } from '../components/plan-comparison.tsx'
import { SettingsPage, SettingsShell } from '../components/settings-shell.tsx'
import { SETTINGS_NAV } from '../lib/settings-nav.tsx'

const PLANS: PlanColumn[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$13',
    period: '/ Month',
    billed: 'Billed yearly',
    yearly: true,
    action: 'Upgrade to Starter',
  },
  {
    id: 'growth',
    name: 'Growth',
    price: '$95',
    period: '/ Month',
    billed: 'Billed yearly',
    yearly: true,
    action: 'Upgrade to Growth',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$295',
    period: '/ Month',
    billed: 'Billed yearly',
    yearly: true,
    action: 'Upgrade to Pro',
  },
]

const ROWS: PlanFeatureRow[] = [
  { label: 'Agents Included', values: ['Unlimited', 'Unlimited', 'Unlimited'] },
  { label: 'Channels supported', values: ['Email, Chat, FB, IG', '+ WhatsApp', '+ SMS, Voice'] },
  { label: 'Help Center', values: ['Basic', 'Customizable', 'Advanced + Multilingual'] },
  { label: 'AI Reply Suggestions', values: ['Up to 200/month', 'Up to 2000/month', 'Unlimited'] },
  { label: 'AI Auto-Responder', values: [false, true, true] },
]

export function PlansPage() {
  return (
    <SettingsShell items={SETTINGS_NAV}>
      <SettingsPage
        title="Plans"
        description={
          <>
            You&apos;re currently on the <span className="font-medium text-foreground">Free plan</span>. Choose the
            plan that best fits your store&apos;s needs.
          </>
        }
      >
        <PlanCards plans={PLANS} />
        <PlanFeatureTable rows={ROWS} columns={PLANS.length} />
      </SettingsPage>
    </SettingsShell>
  )
}
