/**
 * The dates a solar deal is actually run against.
 *
 * A quote doesn't move on an "expected close date" — it moves when
 * someone surveys the roof and then when the crew installs. Both
 * surfaces that summarise a deal (the kanban card and the inbox's
 * right panel) need the same answer to "what's the next thing on the
 * calendar for this deal?", so the pick lives here rather than being
 * re-derived, differently, in each of them.
 */

import type { Deal } from "@/types";

export type MilestoneKind = "visit" | "installation";

export interface DealMilestone {
  kind: MilestoneKind;
  /** Parsed date — for the visit this carries a meaningful time too. */
  date: Date;
  /** True when the milestone is in the past. */
  past: boolean;
}

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  // A bare "YYYY-MM-DD" parses as UTC midnight, which renders as the
  // previous day anywhere west of Greenwich. Pin those to local noon
  // so the date shown is the date that was entered.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The one milestone worth showing when there's only room for one.
 *
 * A booked installation outranks a survey even if the survey is
 * sooner: once the install is on the calendar it's the commitment the
 * team is working toward, and the CFE paperwork window starts from it.
 */
export function nextDealMilestone(
  deal: Pick<Deal, "technical_visit_at" | "installation_date">,
  now: Date = new Date(),
): DealMilestone | null {
  const install = parse(deal.installation_date);
  if (install) {
    return { kind: "installation", date: install, past: install < now };
  }
  const visit = parse(deal.technical_visit_at);
  if (visit) {
    return { kind: "visit", date: visit, past: visit < now };
  }
  return null;
}

/** Both milestones, in the order they happen. Empty when none are set. */
export function dealMilestones(
  deal: Pick<Deal, "technical_visit_at" | "installation_date">,
  now: Date = new Date(),
): DealMilestone[] {
  const out: DealMilestone[] = [];
  const visit = parse(deal.technical_visit_at);
  if (visit) out.push({ kind: "visit", date: visit, past: visit < now });
  const install = parse(deal.installation_date);
  if (install) {
    out.push({ kind: "installation", date: install, past: install < now });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}
