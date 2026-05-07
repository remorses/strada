import * as React from 'react';

import { cn } from '../lib/utils.ts';

type LegendDotProps = {} & React.HTMLAttributes<HTMLDivElement>;

export function LegendDot({ className, ...rest }: LegendDotProps) {
  return (
    <div
      className={cn(
        'size-3 shrink-0 rounded-full border-2 border-background bg-accent shadow-xs',
        className,
      )}
      {...rest}
    />
  );
}
