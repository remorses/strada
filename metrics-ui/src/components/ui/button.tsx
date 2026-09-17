'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium outline-none transition-[transform,background-color,color,border-color] duration-150 ease-out active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5',
  {
    defaultVariants: {
      size: 'default',
      variant: 'ghost',
    },
    variants: {
      size: {
        default: 'h-8 px-2.5 text-sm',
        sm: 'h-7 px-2 text-xs',
        xs: 'h-6 px-1.5 text-xs',
        icon: 'size-8',
        'icon-sm': 'size-7',
      },
      variant: {
        default: 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
        ghost: 'border-transparent text-foreground hover:bg-accent',
        outline: 'border-border bg-card text-foreground hover:bg-accent',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
      },
    },
  },
)

export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ className, size, variant }))} {...props} />
}
