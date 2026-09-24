'use client'

import { PlanCards, PlanFeatureTable, type PlanColumn, type PlanFeatureRow } from '../components/plan-comparison.tsx'
import { AppShell, SettingsPage } from '../components/app-shell.tsx'

const PLANS: PlanColumn[] = [
  {
    id: 'hobby',
    name: 'Hobby',
    price: '$0',
    period: '/ Month',
    billed: 'Bring your own Tinybird',
    yearly: false,
    action: 'Current plan',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$29',
    period: '/ Month',
    billed: 'Billed yearly',
    yearly: true,
    action: 'Upgrade to Pro',
  },
  {
    id: 'team',
    name: 'Team',
    price: '$99',
    period: '/ Month',
    billed: 'Billed yearly',
    yearly: true,
    action: 'Upgrade to Team',
  },
]

const ROWS: PlanFeatureRow[] = [
  { label: 'Projects', values: ['3', 'Unlimited', 'Unlimited'] },
  { label: 'Members', values: ['1', '5', 'Unlimited'] },
  { label: 'Retention', values: ['14 days', '90 days', 'Up to 365 days'] },
  { label: 'Health checks', values: ['5 checks, 15 min', '50 checks, 5 min', 'Unlimited, 1 min'] },
  { label: 'Email alerts', values: [false, true, true] },
]

export function PlansPage() {
  return (
    <AppShell>
      <SettingsPage
        title="Plans"
        description={
          <>
            You&apos;re currently on the <span className="font-medium text-foreground">Hobby plan</span>. Upgrade for
            longer retention, more health checks, and team alerts.
          </>
        }
      >
        <PlanCards plans={PLANS} />
        <PlanFeatureTable rows={ROWS} columns={PLANS.length} />
      </SettingsPage>
    </AppShell>
  )
}
