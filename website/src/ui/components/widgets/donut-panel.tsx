// Generic donut chart panel with configurable legend rows.

'use client';

import * as React from 'react';

import { LegendDot } from '@ui/components/legend-dot.tsx';
import PieChart from '@ui/components/pie-chart.tsx';
import { ShowMore } from '@ui/components/show-more.tsx';
import { WidgetHeader } from '@ui/components/widget-card.tsx';

export type DonutPanelDataItem = {
  id: string;
  label: string;
  value: number;
  fillClassName: string;
  dotClassName: string;
  hiddenFromLegend?: boolean;
};

export type DonutPanelProps = Pick<
  React.ComponentProps<typeof WidgetHeader>,
  'title' | 'value' | 'badge' | 'badgeColor' | 'description' | 'tooltip' | 'actionLabel' | 'action'
> & {
  data: DonutPanelDataItem[];
  circleSize?: number;
  currency?: string;
  locale?: string;
  /** Custom value formatter. When provided, overrides the default currency formatter. */
  formatValue?: (value: number) => string;
};

export function DonutPanel({
  title,
  value,
  badge,
  badgeColor,
  description,
  tooltip,
  actionLabel,
  action,
  data,
  circleSize = 98,
  currency = 'USD',
  locale = 'en-US',
  formatValue,
}: DonutPanelProps) {
  const totalValue = data.reduce(
    (sum, segment) => sum + segment.value,
    0,
  );

  const segmentsWithPercentage = data.map((segment) => ({
    ...segment,
    percentage: Math.round((segment.value / totalValue) * 100),
  }));
  const chartData = data.map((item) => ({
    id: item.id,
    value: item.value,
    fill: item.fillClassName,
  }));

   return (
    <ShowMore maxHeight={200}>
      <WidgetHeader
        title={title}
        value={value}
        badge={badge}
        badgeColor={badgeColor}
        description={description}
        tooltip={tooltip}
        actionLabel={actionLabel}
        action={action}
      />

      <div className='mt-4 flex items-start gap-4'>
        <PieChart data={chartData} circleSize={circleSize} className='shrink-0' />

        <div className='grid min-w-0 flex-1 grid-cols-[12px_1fr_auto_auto_auto] items-center gap-x-1.5 gap-y-2'>
          {segmentsWithPercentage
            .filter((s) => !s.hiddenFromLegend)
            .map((s) => (
              <React.Fragment key={s.id}>
                <LegendDot className={s.dotClassName} />
                <div className='truncate text-sm font-medium text-muted-foreground'>
                  {s.label}
                </div>
                <div className='text-right text-sm font-medium tabular-nums text-muted-foreground'>
                  {formatValue
                    ? formatValue(s.value)
                    : new Intl.NumberFormat(locale, {
                        style: 'currency',
                        currency,
                        maximumFractionDigits: 0,
                      }).format(s.value)}
                </div>
                <div className='text-sm font-normal text-foreground/25'>·</div>
                <div className='text-sm font-normal tabular-nums text-foreground/40'>
                  {s.percentage}%
                </div>
              </React.Fragment>
            ))}
        </div>
      </div>
    </ShowMore>
  );
}
