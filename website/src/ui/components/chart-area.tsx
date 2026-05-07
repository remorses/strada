// Reusable area chart component wrapping recharts.
// Supports single and stacked areas with a consistent data interface.

'use client';

import * as React from 'react';
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';

export type AreaChartDataPoint = {
  date: string;
  [key: string]: string | number;
};

export type AreaConfig = {
  dataKey: string;
  /** Line stroke color. Use 'none' to hide */
  stroke?: string;
  strokeWidth?: number;
  /** Fill color */
  fill: string;
  fillOpacity?: number;
  /** Interpolation type */
  type?: 'linear' | 'monotone' | 'step';
};

export type ChartAreaProps = {
  data: AreaChartDataPoint[];
  areas: AreaConfig[];
  height?: number | string;
  /** Show X axis */
  showXAxis?: boolean;
  /** X axis tick formatter */
  xAxisFormatter?: (value: string) => string;
  /** X axis height (for tick labels) */
  xAxisHeight?: number;
  /** X axis tick margin */
  xAxisTickMargin?: number;
  /** X axis className for tick styling */
  xAxisClassName?: string;
  /** Y-axis domain */
  yDomain?: [string | number, string | number];
  /** Margin overrides */
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
  className?: string;
};

export function ChartArea({
  data,
  areas,
  height = 108,
  showXAxis = false,
  xAxisFormatter,
  xAxisHeight = 24,
  xAxisTickMargin = 8,
  xAxisClassName,
  yDomain = [0, 'auto'],
  margin = { top: 0, right: 0, left: 0, bottom: 0 },
  className,
}: ChartAreaProps) {
  return (
    <ResponsiveContainer width='100%' height={height as number} className={className}>
      <AreaChart data={data} margin={margin}>
        <XAxis
          dataKey='date'
          type='category'
          axisLine={false}
          tickLine={false}
          hide={!showXAxis}
          tickFormatter={xAxisFormatter}
          interval='preserveEnd'
          minTickGap={20}
          tickMargin={xAxisTickMargin}
          height={xAxisHeight}
          className={xAxisClassName}
        />
        <YAxis hide domain={yDomain} />
        {areas.map((area) => (
          <Area
            key={area.dataKey}
            type={area.type ?? 'linear'}
            dataKey={area.dataKey}
            stroke={area.stroke ?? 'none'}
            strokeWidth={area.strokeWidth ?? 0}
            fill={area.fill}
            fillOpacity={area.fillOpacity ?? 1}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
