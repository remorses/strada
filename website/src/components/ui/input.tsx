// Reusable Input and Textarea components with consistent styling.

import type * as React from "react";
import { cn } from "../../lib/utils.ts";

export function Input({
  className,
  inputSize = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { inputSize?: "default" | "sm"; size?: never }): React.ReactElement {
  return (
    <input
      className={cn(
        "rounded-md border border-input bg-background text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
        inputSize === "sm" ? "h-7 px-2" : "h-9 px-3",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y",
        className,
      )}
      {...props}
    />
  );
}
