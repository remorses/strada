// Generic sparkline panel with repeated source metrics below the chart.
// Uses the ECharts-based TimeseriesChart for rendering.

'use client';

import * as React from 'react';
import {
  RiArrowDownLine,
  RiArrowUpLine,
} from '@remixicon/react';

import { TimeseriesChart, type TimeseriesChartProps } from '@ui/components/charts.tsx';
import { WidgetHeader } from '@ui/components/widget-card.tsx';

export type SparklinePanelMetric = {
  label: string;
  value: string;
  change: string;
  direction: 'up' | 'down';
  icon: React.ComponentType<{ className?: string }>;
};

export type SparklinePanelProps = Pick<
  React.ComponentProps<typeof WidgetHeader>,
  'title' | 'value' | 'badge' | 'badgeColor' | 'actionLabel' | 'action'
> & {
  /** ECharts instance (caller must register chart types and renderer). */
  echarts: TimeseriesChartProps['echarts'];
  /** Timeseries data for the ECharts chart. */
  data: TimeseriesChartProps['data'];
  /** Whether to show a gradient fill under the line. */
  gradient?: boolean;
  metrics: SparklinePanelMetric[];
};

export function SparklinePanel({
  title,
  value,
  badge,
  badgeColor,
  actionLabel,
  action,
  echarts,
  data,
  gradient,
  metrics,
}: SparklinePanelProps) {
  return (
    <>
      <WidgetHeader
        title={title}
        value={value}
        badge={badge}
        badgeColor={badgeColor}
        actionLabel={actionLabel}
        action={action}
      />

      <TimeseriesChart
        echarts={echarts}
        data={data}
        height={180}
        gradient={gradient}
        yAxisTickCount={3}
      />

      <div className='grid w-full grid-cols-[20px_1fr_auto_20px_auto] items-center gap-x-1.5 gap-y-4'>
        {metrics.map((metric) => {
          const Icon = metric.icon;
          const TrendIcon = metric.direction === 'up' ? RiArrowUpLine : RiArrowDownLine;
          return (
            <React.Fragment key={metric.label}>
              <Icon className='size-5 shrink-0 text-foreground/40' />
              <div className='text-sm font-medium text-muted-foreground'>{metric.label}</div>
              <div className='text-right text-sm font-normal tabular-nums text-muted-foreground'>
                {metric.value}
              </div>
              <TrendIcon className={metric.direction === 'up' ? 'size-5 shrink-0 text-success' : 'size-5 shrink-0 text-destructive'} />
              <div className='text-sm font-normal tabular-nums text-muted-foreground'>{metric.change}</div>
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}
