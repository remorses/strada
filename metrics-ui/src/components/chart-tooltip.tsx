export type TooltipRow = {
  color: string
  label: string
  value: string
}

export function ChartTooltip({ time, rows }: { time: string; rows: TooltipRow[] }) {
  return (
    <div className="min-w-[188px] rounded-lg border border-border bg-card px-3 py-2 text-[12px] leading-4 shadow-[0_8px_24px_--alpha(var(--foreground)/10%)]">
      <div className="mb-1.5 whitespace-nowrap text-muted-foreground">{time}</div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5">
            <span className="size-2 rounded-[2px]" style={{ background: row.color }} />
            <span className="text-foreground">{row.label}</span>
            <span className="tabular-nums text-foreground">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
