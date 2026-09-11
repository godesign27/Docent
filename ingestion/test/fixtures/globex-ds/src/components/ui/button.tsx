import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center rounded-[var(--radius-button)] text-body transition-colors",
  {
    variants: {
      variant: {
        default: "bg-primary text-neutral-white hover:bg-brand-orange-400",
        outline: "border bg-surface text-brand-teal",
      },
      size: { sm: "px-3 py-1.5", default: "px-4 py-2" },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
