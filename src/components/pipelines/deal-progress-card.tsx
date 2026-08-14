"use client";

import { useTranslations } from "next-intl";
import {
  CalendarClock,
  Check,
  Circle,
  ExternalLink,
  FileText,
  Pencil,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
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

  const currentPosition =
    stages.find((s) => s.id === deal.stage_id)?.position ??
    deal.stage?.position ??
    -1;

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

        {/* Stage pills — everything up to and including the current
            stage reads as done; the rest are still ahead. */}
        {stages.length > 0 && (
          <span className="mt-2.5 flex flex-wrap gap-1">
            {stages.map((stage) => {
              const done =
                currentPosition >= 0 && stage.position <= currentPosition;
              const current = stage.id === deal.stage_id;
              return (
                <span
                  key={stage.id}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                    current
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : done
                        ? "border-border bg-muted text-muted-foreground"
                        : "border-dashed border-border text-muted-foreground/70",
                  )}
                >
                  {done ? (
                    <Check className="size-2.5" aria-hidden />
                  ) : (
                    <Circle className="size-2.5" aria-hidden />
                  )}
                  {stage.name}
                </span>
              );
            })}
          </span>
        )}
      </HeadingWrapper>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("potentialValue")}
          </p>
          <p className="text-lg font-semibold text-foreground">
            {formatCurrency(deal.value, deal.currency)}
          </p>
        </div>
        {typeof deal.panel_count === "number" && (
          <div className="shrink-0 text-right">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
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
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
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
            {check.met ? (
              <Check className="size-3 shrink-0 text-primary" aria-hidden />
            ) : (
              <X className="size-3 shrink-0 text-destructive" aria-hidden />
            )}
            <span className={cn(check.met && "text-foreground")}>
              {check.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
