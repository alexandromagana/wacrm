/**
 * Shared display config for message_templates.status.
 *
 * The DB stores Meta's raw enum (DRAFT / APPROVED / PENDING / REJECTED /
 * PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION) — the UI maps it to
 * a human label + badge classes here, kept apart from the template
 * manager so any other surface that shows a status reads the same
 * badge. Status hues follow STATUS in globals.css: approved is done
 * (success); pending, paused and in appeal are waiting on Meta
 * (warning); rejected and disabled can't be sent (danger). Draft and
 * pending deletion stay neutral.
 */

import type { MessageTemplateStatus } from '@/types';

export interface TemplateStatusDisplay {
  label: string;
  classes: string;
}

export const templateStatusConfig: Record<
  MessageTemplateStatus,
  TemplateStatusDisplay
> = {
  DRAFT: {
    label: 'Draft',
    classes: 'bg-muted text-muted-foreground border-border',
  },
  PENDING: {
    label: 'Pending',
    classes: 'bg-warning/15 text-warning border-warning/30',
  },
  APPROVED: {
    label: 'Approved',
    classes: 'bg-success/15 text-success border-success/30',
  },
  REJECTED: {
    label: 'Rejected',
    classes: 'bg-danger/15 text-danger border-danger/30',
  },
  PAUSED: {
    label: 'Paused',
    classes: 'bg-warning/15 text-warning border-warning/30',
  },
  DISABLED: {
    label: 'Disabled',
    classes: 'bg-danger/10 text-danger border-danger/30',
  },
  IN_APPEAL: {
    label: 'In Appeal',
    classes: 'bg-warning/15 text-warning border-warning/30',
  },
  PENDING_DELETION: {
    label: 'Pending Deletion',
    classes: 'bg-muted/60 text-muted-foreground border-border',
  },
};
