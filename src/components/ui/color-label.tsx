import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * How a coloured *value* is shown: a contact tag, a pipeline stage.
 *
 * The colour lives in a small dot and the name stays in the regular
 * text colour. Tinting the whole chip and writing the name in the tag's
 * own colour (the old pattern) put yellow or cyan text on a pale fill —
 * unreadable in light mode — and made a red "Hot lead" tag read like an
 * error. The dot keeps the colour as a reference without either.
 *
 * Shape is part of the vocabulary: labels are squared (`rounded-md`),
 * states (Open, Pending, Failed…) are round pills in the status hues.
 */

export function ColorDot({
  color,
  className,
}: {
  color?: string | null
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        // The inset ring keeps a pale colour visible on a white card and
        // a dark one visible on charcoal.
        "size-2 shrink-0 rounded-full ring-1 ring-foreground/15 ring-inset",
        className,
      )}
      style={{ backgroundColor: color || "var(--muted-foreground)" }}
    />
  )
}

interface ColorLabelProps {
  name: string
  color?: string | null
  /** `sm` for dense rows (tables, cards), `md` for panels and settings. */
  size?: "sm" | "md"
  className?: string
  /** Trailing control, e.g. a remove button. */
  children?: React.ReactNode
}

export function ColorLabel({ name, color, size = "sm", className, children }: ColorLabelProps) {
  return (
    <span
      title={name}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center rounded-md border border-border font-medium whitespace-nowrap text-foreground",
        size === "sm" ? "h-5 gap-1 px-1.5 text-xs" : "h-6 gap-1.5 px-2 text-xs",
        className,
      )}
    >
      <ColorDot color={color} />
      <span className="min-w-0 truncate">{name}</span>
      {children}
    </span>
  )
}

interface ColorLabelToggleProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  name: string
  color?: string | null
  selected: boolean
}

/**
 * A label you switch on and off (tag pickers). Selection is carried by
 * a check mark and `aria-pressed`, not by dimming the others — dimmed
 * labels fell below readable contrast.
 */
export function ColorLabelToggle({
  name,
  color,
  selected,
  className,
  ...props
}: ColorLabelToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      {...props}
    >
      <ColorDot color={color} />
      <span className="min-w-0 truncate">{name}</span>
      {selected && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />}
    </button>
  )
}
