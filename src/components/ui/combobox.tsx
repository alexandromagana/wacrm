"use client"

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

const Combobox = ComboboxPrimitive.Root

/**
 * The closed control: a text input dressed as a SelectTrigger, so a
 * picker you can type into does not read as a different species of
 * field from the pickers beside it. Text sizing follows Input rather
 * than SelectTrigger — this one really is an input, and 16px on small
 * screens is what stops iOS zooming the page on focus.
 */
function ComboboxInput({
  className,
  clearLabel = "Borrar selección",
  openLabel = "Abrir la lista",
  ...props
}: ComboboxPrimitive.Input.Props & {
  clearLabel?: string
  openLabel?: string
}) {
  return (
    <ComboboxPrimitive.InputGroup
      data-slot="combobox-input-group"
      className={cn(
        "group/combobox relative flex h-8 w-full items-center rounded-lg border border-input bg-transparent transition-colors hover:border-ring/50 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className
      )}
    >
      <ComboboxPrimitive.Input
        data-slot="combobox-input"
        className="h-full w-full min-w-0 flex-1 bg-transparent pr-16 pl-2.5 text-base font-medium text-foreground outline-none placeholder:font-normal placeholder:italic placeholder:text-muted-foreground md:text-sm"
        {...props}
      />
      <div className="absolute inset-y-0 right-0 flex items-center pr-0.5">
        {/* Only mounts once there is something to clear, so an empty
            field is not offering to empty itself. */}
        <ComboboxPrimitive.Clear
          aria-label={clearLabel}
          className="flex h-full w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </ComboboxPrimitive.Clear>
        <ComboboxPrimitive.Trigger
          aria-label={openLabel}
          className="flex h-full w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDownIcon className="size-4 transition-transform duration-150 group-data-[popup-open]/combobox:rotate-180 group-data-[popup-open]/combobox:text-foreground" />
        </ComboboxPrimitive.Trigger>
      </div>
    </ComboboxPrimitive.InputGroup>
  )
}

/** Same floating surface as SelectContent, for the same reasons. */
function ComboboxContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "relative isolate z-50 max-w-(--available-width) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg shadow-black/20 ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        "max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain scroll-py-1 p-1 data-empty:p-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * Stays mounted even when the list has matches — screen readers only
 * announce the change reliably if the region never leaves the DOM.
 */
function ComboboxEmpty({
  className,
  children,
  ...props
}: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty data-slot="combobox-empty" {...props}>
      <div
        className={cn(
          "px-3 py-6 text-center text-sm text-muted-foreground",
          className
        )}
      >
        {children}
      </div>
    </ComboboxPrimitive.Empty>
  )
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        // `data-selected:` is redefined by shadcn/tailwind.css to match
        // only [data-selected="true"]; Base UI writes the bare
        // attribute, so the bracket form is the one that fires.
        "relative flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-8 pl-2 text-sm transition-colors outline-hidden select-none data-highlighted:bg-primary/15 data-highlighted:text-foreground data-[selected]:font-medium data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none text-primary" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
}
