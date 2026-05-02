/**
 * Badge component based on shadcn/ui (new-york-v4).
 * Inlined without class-variance-authority or radix-ui dependencies.
 */
import * as React from "react"
import { cn } from "../../lib/utils.ts"

const base =
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3"

const variantStyles = {
  default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
  destructive:
    "bg-destructive/15 text-destructive [a&]:hover:bg-destructive/25 dark:bg-destructive/20 dark:text-destructive",
  warning:
    "bg-warning/15 text-warning-foreground [a&]:hover:bg-warning/25 dark:bg-warning/20 dark:text-warning-foreground",
  outline:
    "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
  ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
} as const

export type BadgeVariant = keyof typeof variantStyles

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(base, variantStyles[variant], className)}
      {...props}
    />
  )
}

export { Badge }
