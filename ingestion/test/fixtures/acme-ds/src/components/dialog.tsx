import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/button"

const Dialog = DialogPrimitive.Root

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Content
    ref={ref}
    className={cn("fixed bg-black/80 w-[--dialog-width] rounded-lg", className)}
    {...props}
  >
    {children}
    <DialogPrimitive.Close asChild>
      <Button tone="subtle">Close</Button>
    </DialogPrimitive.Close>
  </DialogPrimitive.Content>
))
DialogContent.displayName = "DialogContent"

const DIALOG_Z = 50

export { Dialog, DialogContent, DIALOG_Z }
