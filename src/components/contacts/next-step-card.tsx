"use client";

import { useTranslations } from "next-intl";
import { differenceInCalendarDays, format } from "date-fns";
import { CalendarClock, StickyNote, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DealMilestone } from "@/lib/deals/milestones";

/**
 * The accent-coloured card in the record's right column: what happens
 * next on this deal.
 *
 * Driven by the deal's scheduled work — the site survey or the install
 * — plus the latest thing anyone wrote down. The reference design puts
 * a richer task object here (attachments, a competitor comparison,
 * accept/decline actions); there is no task entity in the schema, so
 * rather than dress up placeholder content as real this sticks to what
 * the data can actually answer.
 */

interface NextStepCardProps {
  /** The deal's next scheduled milestone — a site survey or the
   *  install itself. Null when nothing is on the calendar yet. */
  milestone?: DealMilestone | null;
  /** Free text of the most recent contact note, if any. */
  latestNote?: string | null;
  /** When given, the whole card opens the deal editor — the empty
   *  state especially, since "nothing scheduled" is a prompt to go
   *  schedule something. */
  onEdit?: () => void;
  /** Accessible name for the button form of the card. */
  editLabel?: string;
  className?: string;
}

export function NextStepCard({
  milestone,
  latestNote,
  onEdit,
  editLabel,
  className,
}: NextStepCardProps) {
  const t = useTranslations("NextStep");

  const due = milestone?.date ?? null;
  const daysOut = due ? differenceInCalendarDays(due, new Date()) : null;

  const isEmpty = !due && !latestNote;

  const Root = onEdit ? "button" : "div";

  return (
    <Root
      {...(onEdit
        ? {
            type: "button" as const,
            onClick: onEdit,
            "aria-label": editLabel,
          }
        : {})}
      className={cn(
        "rounded-xl bg-primary p-3 text-primary-foreground",
        onEdit &&
          "w-full text-left transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider opacity-70">
        {t("title")}
      </p>

      {isEmpty ? (
        <p className="mt-1.5 text-xs opacity-80">{t("empty")}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {due && milestone && (
            <div className="flex items-start gap-1.5">
              {milestone.kind === "installation" ? (
                <Wrench className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              ) : (
                <CalendarClock
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden
                />
              )}
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wider opacity-70">
                  {t(
                    milestone.kind === "installation"
                      ? "installation"
                      : "visit",
                  )}
                </p>
                <p className="text-sm font-medium leading-snug">
                  {/* The survey carries a real appointment time; the
                      install is booked by day, so showing 00:00 on it
                      would be inventing precision. */}
                  {milestone.kind === "installation"
                    ? format(due, "MMM d, yyyy")
                    : format(due, "MMM d, yyyy · HH:mm")}
                </p>
                {daysOut !== null && (
                  <p className="text-[11px] opacity-75">
                    {daysOut < 0
                      ? t("overdue", { days: Math.abs(daysOut) })
                      : daysOut === 0
                        ? t("dueToday")
                        : t("dueIn", { days: daysOut })}
                  </p>
                )}
              </div>
            </div>
          )}

          {latestNote && (
            <div className="flex items-start gap-1.5">
              <StickyNote className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {/* Clamped: the column is narrow and a long note would
                  push the rest of the sidebar out of view. */}
              <p className="line-clamp-3 min-w-0 text-xs leading-relaxed opacity-90">
                {latestNote}
              </p>
            </div>
          )}
        </div>
      )}
    </Root>
  );
}
