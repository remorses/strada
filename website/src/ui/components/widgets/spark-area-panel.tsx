// Generic compact area-chart panel with a side usage summary.

'use client';

import * as React from 'react';

import { ChartArea, type AreaChartDataPoint } from '@ui/components/chart-area.tsx';
import { WidgetHeader } from '@ui/components/widget-card.tsx';

export type SparkAreaPanelDataItem = AreaChartDataPoint & {
  value: number;
};

export type SparkAreaPanelProps = Pick<
  React.ComponentProps<typeof WidgetHeader>,
  'title' | 'value' | 'badge' | 'badgeColor' | 'tooltip' | 'actionLabel' | 'action'
> & {
  data: SparkAreaPanelDataItem[];
  usageValue: string;
  usageLabel: string;
};

export function SparkAreaPanel({
  title,
  value,
  badge,
  badgeColor,
  tooltip,
  actionLabel,
  action,
  data,
  usageValue,
  usageLabel,
}: SparkAreaPanelProps) {
  return (
    <div className='flex flex-col gap-0 overflow-hidden'>
      <WidgetHeader
        className='p-5 pb-4'
        title={title}
        value={value}
        badge={badge}
        badgeColor={badgeColor}
        actionLabel={actionLabel}
        action={action}
        tooltip={tooltip}
      />

      <div className='grid h-[86px] grid-cols-2 border-t border-muted'>
        <ChartArea
          data={data}
          height='100%'
          areas={[
            {
              dataKey: 'value',
              stroke: 'var(--color-primary)',
              strokeWidth: 2,
              fill: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
            },
          ]}
        />
        <div className='flex flex-col items-start justify-end border-l-2 border-primary px-4 pb-4'>
          <div className='text-base font-medium text-foreground'>{usageValue}</div>
          <div className='text-xs font-medium text-foreground/40'>{usageLabel}</div>
        </div>
      </div>
    </div>
  );
}
