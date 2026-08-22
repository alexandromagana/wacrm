/**
 * Shared grouping for message_templates and automations.
 *
 * WhatsApp locks a template's `name` once Meta approves it, so the name
 * can't carry the filing — `seguimiento_coti` and `sin_respuesta` are
 * both follow-up nudges but sort nowhere near each other. The
 * `template_group` column (migration 042) is the editable filing on top
 * of that frozen name, and this module is the single place that knows
 * the group vocabulary, its display order, and its badge colors, so the
 * settings manager, the inbox picker, and the automations list all
 * render the same groups in the same order.
 *
 * Values are stored verbatim in the DB, in Spanish, for the same reason
 * automation names already are: they're the operator's own vocabulary,
 * not chrome, so they don't route through next-intl.
 */

/** Filing shown for a row whose `template_group` is NULL. */
export const UNGROUPED = 'Sin categoría';

export interface GroupDisplay {
  /** Badge classes, matching the dark-theme palette of templateStatusConfig. */
  classes: string;
  /** One line on the group header — what belongs in here, and why. */
  hint: string;
}

/**
 * Insertion order is display order: the groups a lead moves through,
 * earliest stage first, with the catch-alls last.
 */
export const TEMPLATE_GROUP_CONFIG: Record<string, GroupDisplay> = {
  Seguimiento: {
    classes: 'bg-primary/20 text-primary border-primary/30',
    hint: 'Nudges after a quote or a fresh lead',
  },
  'Sin respuesta': {
    classes: 'bg-orange-600/20 text-orange-400 border-orange-600/30',
    hint: 'Last push when the customer has gone quiet',
  },
  Visitas: {
    classes: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
    hint: 'Before and after a site visit',
  },
  Recibo: {
    classes: 'bg-yellow-600/20 text-yellow-400 border-yellow-600/30',
    hint: 'Asking for the electricity bill so we can quote',
  },
  Sistema: {
    classes: 'bg-slate-600/20 text-muted-foreground border-slate-600/30',
    hint: 'Meta samples and test templates, not for customers',
  },
};

export const AUTOMATION_GROUP_CONFIG: Record<string, GroupDisplay> = {
  'Leads nuevos': {
    classes: 'bg-primary/20 text-primary border-primary/30',
    hint: 'First contact, routing a lead into the pipeline',
  },
  'Seguimiento de cotización': {
    classes: 'bg-orange-600/20 text-orange-400 border-orange-600/30',
    hint: 'The 48h / 5-day nudges and the tag bookkeeping that stops them',
  },
  'Respuestas de botón': {
    classes: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
    hint: 'What happens when the customer taps a template button',
  },
  Pipeline: {
    classes: 'bg-purple-600/20 text-purple-400 border-purple-600/30',
    hint: 'Moving deals between stages',
  },
};

/** The picker options, in display order. `UNGROUPED` is appended by the UI. */
export const TEMPLATE_GROUPS = Object.keys(TEMPLATE_GROUP_CONFIG);
export const AUTOMATION_GROUPS = Object.keys(AUTOMATION_GROUP_CONFIG);

const FALLBACK_DISPLAY: GroupDisplay = {
  classes: 'bg-slate-600/20 text-muted-foreground border-slate-600/30',
  hint: '',
};

export function groupDisplay(
  config: Record<string, GroupDisplay>,
  group: string
): GroupDisplay {
  return config[group] ?? FALLBACK_DISPLAY;
}

export interface Group<T> {
  name: string;
  items: T[];
}

/**
 * Bucket rows by `template_group`, in the configured display order.
 *
 * Empty groups are dropped — a group header with nothing under it is
 * just a row to scroll past. A value the config doesn't know (someone
 * typed a new group straight into the DB) still gets its own bucket,
 * sorted after the known ones, so nothing silently disappears from a
 * list; NULL collects into `UNGROUPED`, always last.
 */
export function groupByTemplateGroup<T extends { template_group?: string | null }>(
  rows: T[],
  config: Record<string, GroupDisplay>
): Group<T>[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.template_group?.trim() || UNGROUPED;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const known = Object.keys(config).filter((name) => buckets.has(name));
  const unknown = [...buckets.keys()]
    .filter((name) => name !== UNGROUPED && !(name in config))
    .sort();
  const order = [...known, ...unknown];
  if (buckets.has(UNGROUPED)) order.push(UNGROUPED);

  return order.map((name) => ({ name, items: buckets.get(name)! }));
}

/**
 * `gama_seguimiento_lead` → `Gama seguimiento lead`.
 *
 * Meta's naming rules force snake_case, which reads as a database key
 * rather than as the message an agent just sent. Only ever a display
 * label — every send, sync, and lookup still keys off the raw `name`.
 */
export function humanizeTemplateName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
