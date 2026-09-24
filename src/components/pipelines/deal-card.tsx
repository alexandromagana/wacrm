"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, PanelsTopLeft, Wrench } from "lucide-react";
import { Check, X } from "@/components/animated-icons";
import { formatCurrency } from "@/lib/currency";
import { nextDealMilestone } from "@/lib/deals/milestones";
import {
  formatMonth,
  isCarriedOver,
  monthKeyOf,
  statusAsOfMonthEnd,
  type MonthRange,
} from "@/lib/deals/month";
import { useLostReasonLabel } from "./lost-reason-label";
import { useTranslations } from "next-intl";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  /** The month on screen; without it the card shows the deal as it is now. */
  range?: MonthRange;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(date: Date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, range, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const lostReasonLabel = useLostReasonLabel();
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;

  const next = nextDealMilestone(deal);
  const milestone = next
    ? { kind: next.kind, label: formatDate(next.date) }
    : null;

  // Browsing a past month the deal shows as it stood then; a close that
  // came later gets a chip saying when.
  const status = range ? statusAsOfMonthEnd(deal, range) : (deal.status ?? "open");
  const closedLater =
    status === "open" && deal.status && deal.status !== "open" && deal.closed_at
      ? { status: deal.status, month: formatMonth(monthKeyOf(new Date(deal.closed_at)), "short") }
      : null;
  const carriedFrom =
    range && isCarriedOver(deal, range)
      ? formatMonth(monthKeyOf(new Date(deal.created_at)), "short")
      : null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 pl-4 pr-3 py-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {deal.title}
        </h4>
        {status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            <Check className="h-3 w-3" />
            {t("won")}
          </span>
        )}
        {status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
            <X className="h-3 w-3" />
            {t("lost")}
          </span>
        )}
      </div>

      {(carriedFrom || closedLater || (status === "lost" && deal.lost_reason)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {carriedFrom && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("carriedFrom", { month: carriedFrom })}
            </span>
          )}
          {closedLater && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t(closedLater.status === "won" ? "wonIn" : "lostIn", { month: closedLater.month })}
            </span>
          )}
          {status === "lost" && deal.lost_reason && (
            <span className="truncate rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
              {lostReasonLabel(deal.lost_reason)}
            </span>
          )}
        </div>
      )}

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className="truncate text-xs text-muted-foreground">{contactLabel}</span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-primary">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {typeof deal.panel_count === "number" && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <PanelsTopLeft className="h-3 w-3" />
            {t("panels", { count: deal.panel_count })}
          </span>
        )}
      </div>

      {/* The next scheduled milestone, not a close date — an install
          already booked is the more useful thing to see at a glance,
          so it wins over an upcoming survey when both are set. */}
      {milestone && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
          {milestone.kind === "installation" ? (
            <Wrench className="h-3 w-3 shrink-0" />
          ) : (
            <Calendar className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">
            {t(milestone.kind === "installation" ? "installOn" : "visitOn", {
              date: milestone.label,
            })}
          </span>
        </div>
      )}

      {assigneeLabel && (
        <div className="mt-2 flex items-center justify-end">
          <span
            title={assigneeLabel}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {initials(assigneeLabel)}
          </span>
        </div>
      )}
    </button>
  );
}
