// Progress bar panel showing a single item with animated fill.

'use client';

import * as React from 'react';
import NumberFlow from '@number-flow/react';

import { useAnimateNumber } from '@ui/hooks/use-animate-number.ts';
import { ProgressChart } from '@ui/components/progress-chart.tsx';
import { WidgetHeader } from '@ui/components/widget-card.tsx';

export type ProgressNavPanelDataItem = {
  id: string;
  label: string;
  /** Progress value 0-100. */
  value: number;
  detailLabel: string;
  detailValue: string;
  change: string;
  badge?: React.ReactNode;
  description?: React.ReactNode;
};

export type ProgressNavPanelProps = Pick<
  React.ComponentProps<typeof WidgetHeader>,
  'title' | 'badgeColor' | 'tooltip' | 'actionLabel' | 'action'
> & {
  item: ProgressNavPanelDataItem;
  valueSuffix?: string;
};

export function ProgressNavPanel({
  title,
  badgeColor,
  tooltip,
  actionLabel,
  action,
  item,
  valueSuffix = '%',
}: ProgressNavPanelProps) {

  const animateNumber = useAnimateNumber({
    start: 0,
    end: item.value,
    duration: 1250,
  });

  React.useEffect(() => {
    animateNumber.start();
  }, [item.value]);

  return (
    <>
      <WidgetHeader
        title={title}
        value={<NumberFlow value={item.value} suffix={valueSuffix} />}
        badge={item.badge}
        badgeColor={badgeColor}
        description={item.description}
        tooltip={tooltip}
        actionLabel={actionLabel}
        action={action}
      />

      <div className='mt-3.5'>
        <ProgressChart value={animateNumber.value} />
      </div>

      <div className='mt-3 flex items-center justify-between'>
        <div className='text-sm font-medium text-muted-foreground'>
          {item.label}
        </div>
        <div className='flex items-center gap-2'>
          <div className='text-sm font-medium text-muted-foreground'>
            {item.detailValue} {item.detailLabel}
          </div>
          <div className='text-xs font-medium text-foreground/40'>·</div>
          <div className='text-sm font-medium text-success'>
            {item.change}
          </div>
        </div>
      </div>
    </>
  );
}
