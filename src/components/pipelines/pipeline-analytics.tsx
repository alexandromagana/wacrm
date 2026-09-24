"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import {
  DollarSign,
  FileText,
  TrendingUp,
  Trophy,
  Info,
} from "lucide-react";
import { CircleX, Plus } from "@/components/animated-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { computeMonthStats, type MonthRange } from "@/lib/deals/month";
import { panelValueSize } from "@/lib/stat-type";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useLostReasonLabel } from "./lost-reason-label";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
  /** The month on screen — every tile counts within it. */
  range: MonthRange;
}

export function PipelineAnalytics({ stages, deals, range }: PipelineAnalyticsProps) {
  const t = useTranslations("Pipelines.analytics");
  const { defaultCurrency } = useAuth();
  const lostReasonLabel = useLostReasonLabel();

  const stats = useMemo(
    () => computeMonthStats(deals, stages, range),
    [deals, stages, range],
  );

  const lostBreakdown = Object.entries(stats.lostByReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${lostReasonLabel(reason)} (${count})`)
    .join(", ");

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          icon={<Plus className="h-4 w-4 text-muted-foreground" />}
          label={t("newDeals")}
          value={String(stats.newCount)}
          tooltip={t("newDealsTooltip")}
          t={t}
        />
        <Metric
          icon={<FileText className="h-4 w-4 text-blue-400" />}
          label={t("quoted")}
          value={String(stats.quotedCount)}
          tooltip={t("quotedTooltip")}
          t={t}
        />
        <Metric
          icon={<Trophy className="h-4 w-4 text-primary" />}
          label={t("won")}
          value={String(stats.wonCount)}
          tooltip={t("wonTooltip", { value: formatCurrency(stats.wonValue, defaultCurrency) })}
          t={t}
        />
        <Metric
          icon={<CircleX className="h-4 w-4 text-red-400" />}
          label={t("lost")}
          value={String(stats.lostCount)}
          tooltip={
            lostBreakdown
              ? t("lostTooltipBreakdown", { breakdown: lostBreakdown })
              : t("lostTooltip")
          }
          t={t}
        />
        <Metric
          icon={<DollarSign className="h-4 w-4 text-primary" />}
          label={t("openValue")}
          value={formatCurrency(stats.openValue, defaultCurrency)}
          tooltip={t("openValueTooltip", { count: stats.openCount })}
          t={t}
        />
        <Metric
          icon={<TrendingUp className="h-4 w-4 text-purple-400" />}
          label={t("weightedValue")}
          value={formatCurrency(stats.weightedValue, defaultCurrency)}
          tooltip={t("weightedValueTooltip")}
          t={t}
        />
      </div>
    </TooltipProvider>
  );
}

function Metric({
  icon,
  label,
  value,
  tooltip,
  t,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tooltip: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("howCalculated", { label })}
                className="ml-auto text-muted-foreground hover:text-foreground focus:outline-none"
              />
            }
          >
            <Info className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <p
        className={cn(
          'mt-1 leading-none font-bold tracking-tight tabular-nums text-foreground',
          panelValueSize(value),
        )}
      >
        {value}
      </p>
    </div>
  );
}
