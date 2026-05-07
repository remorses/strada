'use client';

import { Cell, Pie, PieChart as RechartsPieChart, Sector } from 'recharts';

import { cn } from '@ui/utils/cn.ts';

export const CIRCLE_SIZE = 90;
const INNER_RADIUS = 32;
const OUTER_RADIUS = 45;

const renderActiveShape = (props: any) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, ...rest } =
    props;

  return (
    <Sector
      cx={cx}
      cy={cy}
      innerRadius={innerRadius + 1}
      outerRadius={outerRadius - 1}
      startAngle={startAngle}
      endAngle={endAngle}
      {...rest}
      cornerRadius={0}
    />
  );
};

export default function PieChart({
  data,
  className,
  circleSize = CIRCLE_SIZE,
}: {
  data: any[];
  className?: string;
  circleSize?: number;
}) {
  return (
    <div
      className={className}
      style={{
        width: circleSize,
      }}
    >
      <RechartsPieChart
        width={circleSize}
        height={circleSize}
        margin={{
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
        }}
      >
        <Pie
          dataKey='value'
          width={circleSize}
          height={circleSize}
          cx={circleSize / 2}
          cy={circleSize / 2}
          innerRadius={INNER_RADIUS}
          outerRadius={OUTER_RADIUS}
          data={data}
          startAngle={90}
          endAngle={450}
          paddingAngle={2}
          cornerRadius={2}
          {...{
            activeIndex: data.findIndex((d: any) => d.id === 'others'),
            activeShape: renderActiveShape,
          } as any}
        >
          {data.map((entry: any) => (
            <Cell
              key={entry.id}
              className={cn('stroke-background', entry.fill)}
            />
          ))}
        </Pie>
      </RechartsPieChart>
    </div>
  );
}
