"use client";

import { useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X, ExternalLink, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

interface MediaLightboxProps {
  /**
   * Already-resolved image source. For proxied WhatsApp media this is
   * the `blob:` URL the bubble fetched — reusing it means opening the
   * viewer costs nothing and works offline-of-the-network, instead of
   * re-downloading a 2 MB photo of a CFE bill.
   */
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Full-screen image viewer for the inbox.
 *
 * Customers send photos of their electricity bills, meters, and roofs —
 * a 240px thumbnail is enough to know one arrived and nowhere near
 * enough to read a tariff or a kWh figure off it. Hence the zoom
 * toggle: "fit the screen" answers *what is this*, "actual size"
 * answers *what does it say*.
 */
export function MediaLightbox({
  src,
  alt,
  open,
  onOpenChange,
}: MediaLightboxProps) {
  const t = useTranslations("Inbox.bubble");
  const [zoomed, setZoomed] = useState(false);

  const handleOpenChange = (next: boolean) => {
    // Reopening should always start fitted — inheriting the zoom from
    // whatever the last image needed is disorienting.
    if (!next) setZoomed(false);
    onOpenChange(next);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/90 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed inset-0 z-50 flex flex-col outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0">
          {/* The popup covers the whole viewport, so the backdrop never
              receives a click and base-ui's own outside-press dismissal
              can't fire. Escape still works; click-to-close is wired up
              on the image area below. */}
          <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>

          <div className="flex shrink-0 items-center justify-end gap-1 p-2">
            <button
              type="button"
              onClick={() => setZoomed((z) => !z)}
              aria-label={zoomed ? t("lightboxFit") : t("lightboxZoom")}
              title={zoomed ? t("lightboxFit") : t("lightboxZoom")}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              {zoomed ? (
                <ZoomOut className="h-5 w-5" />
              ) : (
                <ZoomIn className="h-5 w-5" />
              )}
            </button>
            {/* `download` is honoured for blob: and same-origin sources
                and quietly ignored cross-origin, where target=_blank
                takes over — either way the full-resolution file opens. */}
            <a
              href={src}
              download
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("lightboxOpenOriginal")}
              title={t("lightboxOpenOriginal")}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <ExternalLink className="h-5 w-5" />
            </a>
            <DialogPrimitive.Close
              aria-label={t("lightboxClose")}
              title={t("lightboxClose")}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>

          <div
            className={cn(
              "flex min-h-0 flex-1 p-2 sm:p-4",
              zoomed ? "overflow-auto" : "overflow-hidden",
            )}
            // Clicking the empty space around the image closes, the way
            // every other image viewer behaves. Guarded on the target so
            // a click that lands on the image itself only toggles zoom.
            onClick={(e) => {
              if (e.target === e.currentTarget) handleOpenChange(false);
            }}
          >
            {/* `m-auto` rather than flex centering: a centred flex item
                that overflows its scroll container can't be scrolled
                back to its top-left edge, which is exactly the part of a
                zoomed bill you want to read first. */}
            <button
              type="button"
              onClick={() => setZoomed((z) => !z)}
              aria-label={zoomed ? t("lightboxFit") : t("lightboxZoom")}
              className={cn(
                "m-auto block",
                zoomed ? "cursor-zoom-out" : "max-w-full cursor-zoom-in",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={alt}
                className={cn(
                  "block",
                  zoomed
                    ? "max-w-none"
                    : // Viewport units, not percentages: the button is
                      // shrink-to-fit, so a percentage max-height would
                      // resolve against an auto height and be dropped.
                      // 6rem covers the toolbar plus the padding here.
                      "max-h-[calc(100dvh-6rem)] max-w-full object-contain",
                )}
              />
            </button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
