// AlignUI Badge v0.0.0

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import type { PolymorphicComponentProps } from '@ui/utils/polymorphic.ts';
import { recursiveCloneChildren } from '@ui/utils/recursive-clone-children.tsx';
import { tv, type VariantProps } from '@ui/utils/tv.ts';

const BADGE_ROOT_NAME = 'BadgeRoot';
const BADGE_ICON_NAME = 'BadgeIcon';
const BADGE_DOT_NAME = 'BadgeDot';

export const badgeVariants = tv({
  slots: {
    root: 'inline-flex items-center justify-center rounded-full leading-none transition duration-200 ease-out',
    icon: 'shrink-0',
    dot: [
      // base
      'dot',
      'flex items-center justify-center',
      // before
      'before:size-1 before:rounded-full before:bg-current',
    ],
  },
  variants: {
    size: {
      small: {
        root: 'h-4 gap-1.5 px-2 text-xs font-medium uppercase has-[>.dot]:gap-2',
        icon: '-mx-1 size-3',
        dot: '-mx-2 size-4',
      },
      medium: {
        root: 'h-5 gap-1.5 px-2 text-xs font-medium',
        icon: '-mx-1 size-4',
        dot: '-mx-1.5 size-4',
      },
    },
    variant: {
      filled: {
        root: 'text-primary-foreground',
      },
      light: {},
      lighter: {},
      stroke: {
        root: 'ring-1 ring-inset ring-current',
      },
    },
    color: {
      gray: {},
      blue: {},
      orange: {},
      red: {},
      green: {},
      yellow: {},
      purple: {},
      sky: {},
      pink: {},
      teal: {},
    },
    disabled: {
      true: {
        root: 'pointer-events-none',
      },
    },
    square: {
      true: {},
    },
  },
  compoundVariants: [
    //#region variant=filled
    {
      variant: 'filled',
      color: 'gray',
      class: {
        root: 'bg-muted-foreground',
      },
    },
    {
      variant: 'filled',
      color: 'blue',
      class: {
        root: 'bg-info',
      },
    },
    {
      variant: 'filled',
      color: 'orange',
      class: {
        root: 'bg-warning',
      },
    },
    {
      variant: 'filled',
      color: 'red',
      class: {
        root: 'bg-destructive',
      },
    },
    {
      variant: 'filled',
      color: 'green',
      class: {
        root: 'bg-success',
      },
    },
    {
      variant: 'filled',
      color: 'yellow',
      class: {
        root: 'bg-yellow-500',
      },
    },
    {
      variant: 'filled',
      color: 'purple',
      class: {
        root: 'bg-purple-500',
      },
    },
    {
      variant: 'filled',
      color: 'sky',
      class: {
        root: 'bg-sky-500',
      },
    },
    {
      variant: 'filled',
      color: 'pink',
      class: {
        root: 'bg-pink-500',
      },
    },
    {
      variant: 'filled',
      color: 'teal',
      class: {
        root: 'bg-teal-500',
      },
    },
    // #endregion

    //#region variant=light
    {
      variant: 'light',
      color: 'gray',
      class: {
        root: 'bg-border text-foreground',
      },
    },
    {
      variant: 'light',
      color: 'blue',
      class: {
        root: 'bg-info/20 text-info/80',
      },
    },
    {
      variant: 'light',
      color: 'orange',
      class: {
        root: 'bg-warning/20 text-warning/80',
      },
    },
    {
      variant: 'light',
      color: 'red',
      class: {
        root: 'bg-destructive/20 text-destructive/80',
      },
    },
    {
      variant: 'light',
      color: 'green',
      class: {
        root: 'bg-success/20 text-success/80',
      },
    },
    {
      variant: 'light',
      color: 'yellow',
      class: {
        root: 'bg-yellow-200 text-yellow-950',
      },
    },
    {
      variant: 'light',
      color: 'purple',
      class: {
        root: 'bg-purple-200 text-purple-950',
      },
    },
    {
      variant: 'light',
      color: 'sky',
      class: {
        root: 'bg-sky-200 text-sky-950',
      },
    },
    {
      variant: 'light',
      color: 'pink',
      class: {
        root: 'bg-pink-200 text-pink-950',
      },
    },
    {
      variant: 'light',
      color: 'teal',
      class: {
        root: 'bg-teal-200 text-teal-950',
      },
    },
    //#endregion

    //#region variant=lighter
    {
      variant: 'lighter',
      color: 'gray',
      class: {
        root: 'bg-muted text-muted-foreground',
      },
    },
    {
      variant: 'lighter',
      color: 'blue',
      class: {
        root: 'bg-info/10 text-info',
      },
    },
    {
      variant: 'lighter',
      color: 'orange',
      class: {
        root: 'bg-warning/10 text-warning',
      },
    },
    {
      variant: 'lighter',
      color: 'red',
      class: {
        root: 'bg-destructive/10 text-destructive',
      },
    },
    {
      variant: 'lighter',
      color: 'green',
      class: {
        root: 'bg-success/10 text-success',
      },
    },
    {
      variant: 'lighter',
      color: 'yellow',
      class: {
        root: 'bg-yellow-50 text-yellow-500',
      },
    },
    {
      variant: 'lighter',
      color: 'purple',
      class: {
        root: 'bg-purple-50 text-purple-500',
      },
    },
    {
      variant: 'lighter',
      color: 'sky',
      class: {
        root: 'bg-sky-50 text-sky-500',
      },
    },
    {
      variant: 'lighter',
      color: 'pink',
      class: {
        root: 'bg-pink-50 text-pink-500',
      },
    },
    {
      variant: 'lighter',
      color: 'teal',
      class: {
        root: 'bg-teal-50 text-teal-500',
      },
    },
    //#endregion

    //#region variant=stroke
    {
      variant: 'stroke',
      color: 'gray',
      class: {
        root: 'text-muted-foreground',
      },
    },
    {
      variant: 'stroke',
      color: 'blue',
      class: {
        root: 'text-info',
      },
    },
    {
      variant: 'stroke',
      color: 'orange',
      class: {
        root: 'text-warning',
      },
    },
    {
      variant: 'stroke',
      color: 'red',
      class: {
        root: 'text-destructive',
      },
    },
    {
      variant: 'stroke',
      color: 'green',
      class: {
        root: 'text-success',
      },
    },
    {
      variant: 'stroke',
      color: 'yellow',
      class: {
        root: 'text-yellow-500',
      },
    },
    {
      variant: 'stroke',
      color: 'purple',
      class: {
        root: 'text-purple-500',
      },
    },
    {
      variant: 'stroke',
      color: 'sky',
      class: {
        root: 'text-sky-500',
      },
    },
    {
      variant: 'stroke',
      color: 'pink',
      class: {
        root: 'text-pink-500',
      },
    },
    {
      variant: 'stroke',
      color: 'teal',
      class: {
        root: 'text-teal-500',
      },
    },
    //#endregion

    //#region square
    {
      size: 'small',
      square: true,
      class: {
        root: 'min-w-4 px-1',
      },
    },
    {
      size: 'medium',
      square: true,
      class: {
        root: 'min-w-5 px-1',
      },
    },
    //#endregion

    //#region disabled
    {
      disabled: true,
      variant: ['stroke', 'filled', 'light', 'lighter'],
      color: [
        'red',
        'gray',
        'blue',
        'orange',
        'green',
        'yellow',
        'purple',
        'sky',
        'pink',
        'teal',
      ],
      class: {
        root: [
          'ring-1 ring-inset ring-border',
          'bg-transparent text-foreground/25',
        ],
      },
    },
    //#endregion
  ],
  defaultVariants: {
    variant: 'filled',
    size: 'small',
    color: 'gray',
  },
});

type BadgeSharedProps = VariantProps<typeof badgeVariants>;

type BadgeRootProps = VariantProps<typeof badgeVariants> &
  React.HTMLAttributes<HTMLDivElement> & {
    asChild?: boolean;
  };

const BadgeRoot = React.forwardRef<HTMLDivElement, BadgeRootProps>(
  (
    {
      asChild,
      size,
      variant,
      color,
      disabled,
      square,
      children,
      className,
      ...rest
    },
    forwardedRef,
  ) => {
    const uniqueId = React.useId();
    const Component = asChild ? Slot : 'div';
    const { root } = badgeVariants({ size, variant, color, disabled, square });

    const sharedProps: BadgeSharedProps = {
      size,
      variant,
      color,
    };

    const extendedChildren = recursiveCloneChildren(
      children as React.ReactElement[],
      sharedProps,
      [BADGE_ICON_NAME, BADGE_DOT_NAME],
      uniqueId,
      asChild,
    );

    return (
      <Component
        ref={forwardedRef}
        className={root({ class: className })}
        {...rest}
      >
        {extendedChildren}
      </Component>
    );
  },
);
BadgeRoot.displayName = BADGE_ROOT_NAME;

function BadgeIcon<T extends React.ElementType>({
  className,
  size,
  variant,
  color,
  as,
  ...rest
}: PolymorphicComponentProps<T, BadgeSharedProps>) {
  const Component = as || 'div';
  const { icon } = badgeVariants({ size, variant, color });

  return <Component className={icon({ class: className })} {...rest} />;
}
BadgeIcon.displayName = BADGE_ICON_NAME;

type BadgeDotProps = BadgeSharedProps &
  Omit<React.HTMLAttributes<HTMLDivElement>, 'color'>;

function BadgeDot({ size, variant, color, className, ...rest }: BadgeDotProps) {
  const { dot } = badgeVariants({ size, variant, color });

  return <div className={dot({ class: className })} {...rest} />;
}
BadgeDot.displayName = BADGE_DOT_NAME;

export { BadgeRoot as Root, BadgeIcon as Icon, BadgeDot as Dot };
