// AlignUI Tooltip v0.0.0

'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { tv, type VariantProps } from '@ui/utils/tv.ts';

const TooltipProvider = TooltipPrimitive.Provider;
const TooltipRoot = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export const tooltipVariants = tv({
  slots: {
    content: [
      'z-50 shadow-tooltip',
      'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
    ],
    arrow:
      '-translate-y-1/2 -rotate-45 border [clip-path:polygon(0_100%,0_0,100%_100%)]',
  },
  variants: {
    size: {
      xsmall: {
        content: 'rounded-sm px-1.5 py-0.5 text-xs font-normal',
        arrow: 'rounded-bl-sm',
      },
      small: {
        content: 'rounded-md px-2.5 py-1 text-sm font-normal',
        arrow: 'rounded-bl-[3px]',
      },
      medium: {
        content: 'rounded-xl p-3 text-sm font-medium',
        arrow: 'rounded-bl-sm',
      },
    },
    variant: {
      dark: {
        content: 'bg-foreground text-background',
        arrow: 'border-ring bg-foreground',
      },
      light: {
        content:
          'bg-background text-foreground ring-1 ring-border',
        arrow: 'border-border bg-background',
      },
    },
  },
  compoundVariants: [
    {
      size: 'xsmall',
      variant: 'dark',
      class: {
        arrow: 'size-1.5',
      },
    },
    {
      size: 'xsmall',
      variant: 'light',
      class: {
        arrow: 'size-2',
      },
    },
    {
      size: ['small', 'medium'],
      variant: 'dark',
      class: {
        arrow: 'size-2',
      },
    },
    {
      size: ['small', 'medium'],
      variant: 'light',
      class: {
        arrow: 'size-2.5',
      },
    },
  ],
  defaultVariants: {
    size: 'small',
    variant: 'dark',
  },
});

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> &
    VariantProps<typeof tooltipVariants>
>(
  (
    { size, variant, className, children, sideOffset = 4, ...rest },
    forwardedRef,
  ) => {
    const { content, arrow } = tooltipVariants({
      size,
      variant,
    });

    return (
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          ref={forwardedRef}
          sideOffset={sideOffset}
          className={content({ class: className })}
          {...rest}
        >
          {children}
          <TooltipPrimitive.Arrow asChild>
            <div className={arrow()} />
          </TooltipPrimitive.Arrow>
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    );
  },
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export {
  TooltipProvider as Provider,
  TooltipRoot as Root,
  TooltipTrigger as Trigger,
  TooltipContent as Content,
};
