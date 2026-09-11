import * as React from "react"
import { type VariantProps } from "class-variance-authority"

import { buttonVariants } from "./button"

export function IconButton({
  label,
  ...props
}: { label: string } & VariantProps<typeof buttonVariants>) {
  return <button aria-label={label} className="rounded-full bg-[#ff00aa] text-slate-500" {...props} />
}
