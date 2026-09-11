import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

export const buttonVariants = cva(
  "inline-flex items-center rounded-md text-sm focus-visible:ring-2 focus-visible:ring-ring",
  {
    variants: {
      intent: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        danger: "bg-danger text-white",
      },
      size: {
        sm: "h-8 px-3",
        md: "h-10 px-4",
      },
    },
    defaultVariants: {
      intent: "primary",
      size: "md",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a button. */
  asChild?: boolean
  /** Shows a spinner and disables the button. */
  loading?: boolean
  tone: "solid" | "subtle"
}

/** Triggers an action. Use for the primary call to action on a surface. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, intent, size, asChild = false, loading = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ intent, size, className }))}
        ref={ref}
        aria-busy={loading}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"
