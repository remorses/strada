// AlignUI Button v0.0.0

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import type { PolymorphicComponentProps } from '@ui/utils/polymorphic.ts';
import { recursiveCloneChildren } from '@ui/utils/recursive-clone-children.tsx';
import { tv, type VariantProps } from '@ui/utils/tv.ts';

const BUTTON_ROOT_NAME = 'ButtonRoot';
const BUTTON_ICON_NAME = 'ButtonIcon';

export const buttonVariants = tv({
  slots: {
    root: [
      // base
      'group relative inline-flex items-center justify-center whitespace-nowrap outline-hidden',
      'transition duration-200 ease-out',
      // focus
      'focus:outline-hidden',
      // disabled
      'disabled:pointer-events-none disabled:bg-muted disabled:text-foreground/25 disabled:ring-transparent',
    ],
    icon: [
      // base
      'flex size-5 shrink-0 items-center justify-center',
    ],
  },
  variants: {
    variant: {
      primary: {},
      neutral: {},
      error: {},
    },
    mode: {
      filled: {},
      stroke: {
        root: 'ring-1 ring-inset',
      },
      lighter: {
        root: 'ring-1 ring-inset',
      },
      ghost: {
        root: 'ring-1 ring-inset',
      },
    },
    size: {
      medium: {
        root: 'h-10 gap-3 rounded-10 px-3.5 text-sm font-medium',
        icon: '-mx-1',
      },
      small: {
        root: 'h-9 gap-3 rounded-lg px-3 text-sm font-medium',
        icon: '-mx-1',
      },
      xsmall: {
        root: 'h-8 gap-2.5 rounded-lg px-2.5 text-sm font-medium',
        icon: '-mx-1',
      },
      xxsmall: {
        root: 'h-7 gap-2.5 rounded-lg px-2 text-sm font-medium',
        icon: '-mx-1',
      },
    },
  },
  compoundVariants: [
    //#region variant=primary
    {
      variant: 'primary',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-primary text-primary-foreground',
          // hover
          'hover:bg-primary/90',
          // focus
          'focus-visible:shadow-button-primary-focus',
        ],
      },
    },
    {
      variant: 'primary',
      mode: 'stroke',
      class: {
        root: [
          // base
          'bg-background text-primary ring-primary',
          // hover
          'hover:bg-primary/10 hover:ring-transparent',
          // focus
          'focus-visible:shadow-button-primary-focus',
        ],
      },
    },
    {
      variant: 'primary',
      mode: 'lighter',
      class: {
        root: [
          // base
          'bg-primary/10 text-primary ring-transparent',
          // hover
          'hover:bg-background hover:ring-primary',
          // focus
          'focus-visible:bg-background focus-visible:shadow-button-primary-focus focus-visible:ring-primary',
        ],
      },
    },
    {
      variant: 'primary',
      mode: 'ghost',
      class: {
        root: [
          // base
          'bg-transparent text-primary ring-transparent',
          // hover
          'hover:bg-primary/10',
          // focus
          'focus-visible:bg-background focus-visible:shadow-button-primary-focus focus-visible:ring-primary',
        ],
      },
    },
    //#endregion

    //#region variant=neutral
    {
      variant: 'neutral',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-foreground text-background',
          // hover
          'hover:bg-foreground/80',
          // focus
          'focus-visible:shadow-button-important-focus',
        ],
      },
    },
    {
      variant: 'neutral',
      mode: 'stroke',
      class: {
        root: [
          // base
          'bg-background text-muted-foreground shadow-xs ring-border',
          // hover
          'hover:bg-muted hover:text-foreground hover:shadow-none hover:ring-transparent',
          // focus
          'focus-visible:text-foreground focus-visible:shadow-button-important-focus focus-visible:ring-ring',
        ],
      },
    },
    {
      variant: 'neutral',
      mode: 'lighter',
      class: {
        root: [
          // base
          'bg-muted text-muted-foreground ring-transparent',
          // hover
          'hover:bg-background hover:text-foreground hover:shadow-xs hover:ring-border',
          // focus
          'focus-visible:bg-background focus-visible:text-foreground focus-visible:shadow-button-important-focus focus-visible:ring-ring',
        ],
      },
    },
    {
      variant: 'neutral',
      mode: 'ghost',
      class: {
        root: [
          // base
          'bg-transparent text-muted-foreground ring-transparent',
          // hover
          'hover:bg-muted hover:text-foreground',
          // focus
          'focus-visible:bg-background focus-visible:text-foreground focus-visible:shadow-button-important-focus focus-visible:ring-ring',
        ],
      },
    },
    //#endregion

    //#region variant=error
    {
      variant: 'error',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-destructive text-primary-foreground',
          // hover
          'hover:bg-red-700',
          // focus
          'focus-visible:shadow-button-error-focus',
        ],
      },
    },
    {
      variant: 'error',
      mode: 'stroke',
      class: {
        root: [
          // base
          'bg-background text-destructive ring-destructive',
          // hover
          'hover:bg-destructive/10 hover:ring-transparent',
          // focus
          'focus-visible:shadow-button-error-focus',
        ],
      },
    },
    {
      variant: 'error',
      mode: 'lighter',
      class: {
        root: [
          // base
          'bg-destructive/10 text-destructive ring-transparent',
          // hover
          'hover:bg-background hover:ring-destructive',
          // focus
          'focus-visible:bg-background focus-visible:shadow-button-error-focus focus-visible:ring-destructive',
        ],
      },
    },
    {
      variant: 'error',
      mode: 'ghost',
      class: {
        root: [
          // base
          'bg-transparent text-destructive ring-transparent',
          // hover
          'hover:bg-destructive/10',
          // focus
          'focus-visible:bg-background focus-visible:shadow-button-error-focus focus-visible:ring-destructive',
        ],
      },
    },
    //#endregion
  ],
  defaultVariants: {
    variant: 'primary',
    mode: 'filled',
    size: 'medium',
  },
});

type ButtonSharedProps = VariantProps<typeof buttonVariants>;

type ButtonRootProps = VariantProps<typeof buttonVariants> &
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
  };

const ButtonRoot = React.forwardRef<HTMLButtonElement, ButtonRootProps>(
  (
    { children, variant, mode, size, asChild, className, ...rest },
    forwardedRef,
  ) => {
    const uniqueId = React.useId();
    const Component = asChild ? Slot : 'button';
    const { root } = buttonVariants({ variant, mode, size });

    const sharedProps: ButtonSharedProps = {
      variant,
      mode,
      size,
    };

    const extendedChildren = recursiveCloneChildren(
      children as React.ReactElement[],
      sharedProps,
      [BUTTON_ICON_NAME],
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
ButtonRoot.displayName = BUTTON_ROOT_NAME;

function ButtonIcon<T extends React.ElementType>({
  variant,
  mode,
  size,
  as,
  className,
  ...rest
}: PolymorphicComponentProps<T, ButtonSharedProps>) {
  const Component = as || 'div';
  const { icon } = buttonVariants({ mode, variant, size });

  return <Component className={icon({ class: className })} {...rest} />;
}
ButtonIcon.displayName = BUTTON_ICON_NAME;

export { ButtonRoot as Root, ButtonIcon as Icon };
