"use client";

import { useTranslations } from "next-intl";
import {
  CalendarClock,
  Circle,
  FileText,
  Pencil,
  StickyNote,
  Wrench,
} from "lucide-react";
import { Check, ExternalLink } from "@/components/animated-icons";
import { cn } from "@/lib/utils";
import { ColorDot } from "@/components/ui/color-label";
import { formatCurrency } from "@/lib/currency";
import { dealMilestones } from "@/lib/deals/milestones";
import type { Deal, PipelineStage } from "@/types";

/**
 * Where a deal stands: how far along its pipeline it is, what it's
 * worth, and which of the things a deal needs are actually filled in.
 *
 * The readiness list is derived from fields the deal already carries —
 * nothing here is stored separately, so there's no state to keep in
 * sync and no schema behind it.
 */

interface DealProgressCardProps {
  deal: Deal;
  /** Every stage of the deal's pipeline, in board order. */
  stages: PipelineStage[];
  /** Extra readiness rows the caller can prove but the deal can't
   *  see on its own (contact email, note count, …). */
  extraChecks?: ReadinessCheck[];
  /** When given, the deal heading and its stage row become a button
   *  that opens the editor. Left out, the card is read-only. */
  onEdit?: () => void;
  className?: string;
}

export interface ReadinessCheck {
  label: string;
  met: boolean;
}

/**
 * Renders its children as a button when there's somewhere to go, and
 * as a plain block otherwise. Children use inline elements throughout
 * because a <button> may not contain block-level content.
 */
function HeadingWrapper({
  onEdit,
  editLabel,
  children,
}: {
  onEdit?: () => void;
  editLabel: string;
  children: React.ReactNode;
}) {
  if (!onEdit) return <div>{children}</div>;
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={editLabel}
      className="-m-1 block w-[calc(100%+0.5rem)] rounded-lg p-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      {children}
    </button>
  );
}

export function DealProgressCard({
  deal,
  stages,
  extraChecks = [],
  onEdit,
  className,
}: DealProgressCardProps) {
  const t = useTranslations("DealProgress");

  const currentStage =
    stages.find((s) => s.id === deal.stage_id) ?? deal.stage ?? null;
  const currentPosition = currentStage?.position ?? -1;
  const currentIndex = stages.findIndex((s) => s.id === currentStage?.id);

  const checks: ReadinessCheck[] = [
    { label: t("checkValue"), met: deal.value > 0 },
    { label: t("checkPanels"), met: typeof deal.panel_count === "number" },
    { label: t("checkQuote"), met: Boolean(deal.quote_url) },
    { label: t("checkOwner"), met: Boolean(deal.assigned_to) },
    ...extraChecks,
  ];

  const milestones = dealMilestones(deal);

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card-2 p-3",
        className,
      )}
    >
      {/* Heading + stage row double as the way into the editor, so the
          stage you're looking at is the thing you click to change it.
          A plain <div> when there's no handler — a button that does
          nothing is worse than no button. */}
      <HeadingWrapper onEdit={onEdit} editLabel={t("editDeal")}>
        <span className="flex items-start gap-1.5">
          <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground">
            {deal.title}
          </span>
          {onEdit && (
            <Pencil
              className="mt-0.5 size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
        </span>

        {/* Where the deal stands, as one line plus a stepped bar. It
            used to be a pill per stage — five wrapping chips in a 280px
            column to say one thing. The stage keeps its board colour as
            the dot; every stage up to the current one fills in. */}
        {stages.length > 0 && (
          <span className="mt-2.5 block">
            <span className="flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <ColorDot color={currentStage?.color} />
                <span className="truncate font-medium text-foreground">
                  {currentStage?.name ?? "—"}
                </span>
              </span>
              {currentIndex >= 0 && (
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {t("stageOf", { current: currentIndex + 1, total: stages.length })}
                </span>
              )}
            </span>
            <span className="mt-1.5 flex gap-1" aria-hidden>
              {stages.map((stage) => (
                <span
                  key={stage.id}
                  title={stage.name}
                  className={cn(
                    "h-1 flex-1 rounded-full",
                    currentPosition >= 0 && stage.position <= currentPosition
                      ? "bg-primary"
                      : "bg-muted",
                  )}
                />
              ))}
            </span>
          </span>
        )}
      </HeadingWrapper>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("potentialValue")}
          </p>
          <p className="text-lg font-semibold text-foreground">
            {formatCurrency(deal.value, deal.currency)}
          </p>
        </div>
        {typeof deal.panel_count === "number" && (
          <div className="shrink-0 text-right">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("panels")}
            </p>
            <p className="text-lg font-semibold text-foreground">
              {deal.panel_count}
            </p>
          </div>
        )}
      </div>

      {/* Scheduled work. A past date isn't an error — the install
          happened — so it's dimmed rather than flagged, which keeps
          the red X vocabulary meaning "missing" further down. */}
      {milestones.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {milestones.map((m) => (
            <li key={m.kind} className="flex items-start gap-1.5">
              {m.kind === "installation" ? (
                <Wrench className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
              ) : (
                <CalendarClock className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t(m.kind === "installation" ? "installation" : "visit")}
                </p>
                <p
                  className={cn(
                    "text-xs font-medium",
                    m.past ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {m.kind === "installation"
                    ? m.date.toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })
                    : m.date.toLocaleString(undefined, {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The deal's own notes field, which the editor writes to. It
          used to be invisible here, so anyone who typed into "Notes"
          in the editor saved something they could then never see —
          the contact-notes list further down the panel is a separate
          table and doesn't show it. */}
      {deal.notes?.trim() && (
        <div className="mt-3 flex items-start gap-1.5">
          <StickyNote className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("dealNotes")}
            </p>
            <p className="whitespace-pre-wrap break-words text-xs text-foreground">
              {deal.notes.trim()}
            </p>
          </div>
        </div>
      )}

      {deal.quote_url && (
        <a
          href={deal.quote_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t("openQuote")}</span>
          <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
        </a>
      )}

      <ul className="mt-3 space-y-1">
        {checks.map((check) => (
          <li
            key={check.label}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            {/* Something not filled in yet is a to-do, not an error:
                an empty ring, with the word for screen readers, rather
                than a red cross on half the list. */}
            {check.met ? (
              <Check className="size-3 shrink-0 text-success" aria-hidden />
            ) : (
              <Circle className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
            )}
            <span className={cn(check.met && "text-foreground")}>
              {check.label}
              {!check.met && <span className="sr-only"> ({t("readinessMissing")})</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
