'use client'

import { CheckIcon, XIcon } from 'lucide-react'
import { Button } from './ui/button.tsx'
import { Switch } from './ui/switch.tsx'

export type PlanColumn = {
  id: string
  name: string
  price: string
  period: string
  billed: string
  yearly: boolean
  action: string
}

export type PlanFeatureCell = string | boolean

export type PlanFeatureRow = {
  label: string
  values: PlanFeatureCell[]
}

export function PlanCards({ plans }: { plans: PlanColumn[] }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {plans.map((plan) => (
        <article key={plan.id} className="flex flex-col gap-3 rounded-xl border border-black/8 bg-card p-1">
          <div className="flex items-center justify-between rounded-lg bg-[#f3f4f6] px-3 py-1.5">
            <span className="text-[13px] font-medium">{plan.name}</span>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              Yearly
              <Switch size="sm" defaultChecked={plan.yearly} aria-label={`${plan.name} yearly billing`} />
            </label>
          </div>
          <div className="flex flex-col gap-0.5 px-2.5">
            <div className="flex items-baseline gap-1">
              <span className="text-[26px] leading-none font-semibold tracking-tight">{plan.price}</span>
              <span className="text-[13px] text-foreground/75">{plan.period}</span>
            </div>
            <div className="text-[12px] text-muted-foreground">{plan.billed}</div>
          </div>
          <Button variant="outline" className="mx-1.5 mb-1.5 h-8 rounded-lg text-[13px] font-normal">
            {plan.action}
          </Button>
        </article>
      ))}
    </div>
  )
}

export function PlanFeatureTable({ rows, columns }: { rows: PlanFeatureRow[]; columns: number }) {
  return (
    <div className="flex flex-col">
      {rows.map((row) => (
        <div key={row.label} className="border-b border-border/70 py-5">
          <div className="pb-4 text-[13px] text-muted-foreground">{row.label}</div>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {row.values.map((value, index) => (
              <div key={index} className="pr-3 text-[13.5px]">
                <PlanFeatureValue value={value} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function PlanFeatureValue({ value }: { value: PlanFeatureCell }) {
  if (value === true) return <CheckIcon className="size-4 text-info" strokeWidth={2.5} />
  if (value === false) return <XIcon className="size-3.5 text-muted-foreground" strokeWidth={2} />
  return <span>{value}</span>
}
