"use client";

import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { getConversationStatus } from "@/lib/conversation-status";
import { InboxStatTiles } from "@/components/inbox/inbox-stat-tiles";
import { getWhatsAppSessionInfo } from "@/lib/whatsapp/session-window";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X, Clock, LayoutTemplate } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

type InboxFilter = ConversationStatus | "all" | "unread";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  // Status pill labels ("Open"/"Pending"/"Closed") live under the
  // messageThread namespace — reused here rather than duplicated so
  // the list and the thread header's status dropdown always agree.
  const tStatus = useTranslations("Inbox.messageThread");
  const tTimer = useTranslations("Inbox.sessionTimer");

  // Drives the session-window indicator below. Unlike everything else in
  // this list, the 24h window turns over purely from time passing, with
  // no conversation event to trigger a re-render — so without this tick
  // a row's countdown would sit stale for hours. 60s is coarse on
  // purpose: nothing here depends on catching the exact second, and each
  // tick is an O(1) timestamp comparison per row (see the memo below).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  /**
   * Describes a conversation whose 24h window is STILL OPEN; null for
   * expired and never-started ones.
   *
   * Closed conversations get a countdown too. They used to be excluded
   * — no point nagging about a thread someone already wrapped up — but
   * now that the list groups by window, a closed-but-still-open row
   * sits under "can reply now" regardless, and hiding its timer there
   * just makes it look like the one row missing its data.
   *
   * Returns plain strings (unpacked into separate props at the call
   * site) so the row's memo keeps comparing by value; handing it a fresh
   * object each tick would defeat the memo entirely.
   */
  function describeOpenWindow(conv: Conversation) {
    const info = getWhatsAppSessionInfo(
      conv.last_customer_message_at,
      new Date(nowTick),
    );
    if (!info.hasCustomerMessage || info.windowExpired) return null;
    if (info.remaining.kind === "hoursRemaining") {
      return {
        compact: `${info.remaining.hours}h`,
        label: tTimer("xhRemaining", { hours: info.remaining.hours }),
      };
    }
    if (info.remaining.kind === "minutesRemaining") {
      return {
        compact: `${info.remaining.minutes}m`,
        label: tTimer("xmRemaining", { minutes: info.remaining.minutes }),
      };
    }
    return null;
  }

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  /**
   * Split the list by WhatsApp's 24h window, because that's the divide
   * that decides what you can actually do: inside it you can reply in
   * free text, outside it only an approved template will send.
   *
   * Grouped on the window alone, deliberately ignoring `status` — a
   * conversation someone marked closed can still be inside its window,
   * and that's a real "you can still write to this person".
   *
   * "Needs template" also collects contacts who have never messaged in.
   * WhatsApp treats them the same as a lapsed window (templates only);
   * the row keeps its own label so a fresh lead doesn't read as an
   * expired conversation.
   */
  const groups = useMemo(() => {
    const now = new Date(nowTick);
    const openWindow: Conversation[] = [];
    const needsTemplate: Conversation[] = [];

    for (const conv of filtered) {
      const info = getWhatsAppSessionInfo(conv.last_customer_message_at, now);
      if (info.hasCustomerMessage && !info.windowExpired) openWindow.push(conv);
      else needsTemplate.push(conv);
    }

    // Both groups keep the query's order: newest message first. This
    // used to sort the open-window group by the window closing soonest,
    // which buried a conversation that just came in at the bottom of the
    // list — surprising when you glance at the inbox after a new reply.
    // Urgency isn't lost: every row still carries its countdown badge,
    // and the "Pending" tile counts what's waiting.
    return { openWindow, needsTemplate };
  }, [filtered, nowTick]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  // Shared by both groups. `needsTemplate` decides which of the two
  // trailing markers the row shows — a countdown or a template cue.
  function renderRow(conv: Conversation, needsTemplate: boolean) {
    // Computed here rather than inside the row so the memo can skip
    // rows whose countdown didn't change.
    const openWindow = describeOpenWindow(conv);
    return (
      <ConversationItem
        key={conv.id}
        conversation={conv}
        isActive={conv.id === activeConversationId}
        onSelect={handleSelect}
        t={t}
        tStatus={tStatus}
        remainingCompact={openWindow?.compact ?? null}
        remainingLabel={openWindow?.label ?? null}
        needsTemplate={needsTemplate}
        neverReplied={!conv.last_customer_message_at}
      />
    );
  }

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Counts + Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <InboxStatTiles
          conversations={conversations}
          active={filter}
          onSelect={setFilter}
          labels={{
            all: t("filterAll"),
            unread: t("filterUnread"),
            open: t("filterOpen"),
            pending: t("filterPending"),
          }}
        />
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {groups.openWindow.length > 0 && (
              <>
                <GroupHeader
                  label={t("groupOpenWindow")}
                  count={groups.openWindow.length}
                  dotClassName="bg-emerald-400"
                />
                {groups.openWindow.map((conv) => renderRow(conv, false))}
              </>
            )}
            {groups.needsTemplate.length > 0 && (
              <>
                <GroupHeader
                  label={t("groupNeedsTemplate")}
                  count={groups.needsTemplate.length}
                  dotClassName="bg-amber-400"
                />
                {groups.needsTemplate.map((conv) => renderRow(conv, true))}
              </>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * Sticky label above each session-window group. Sticks so that once
 * you've scrolled into the (usually much longer) template group, it's
 * still obvious these are the ones you can't free-text.
 */
function GroupHeader({
  label,
  count,
  dotClassName,
}: {
  label: string;
  count: number;
  dotClassName: string;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border/60 bg-card px-3 py-1.5">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", dotClassName)}
        aria-hidden
      />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-[10px] font-medium text-muted-foreground/70">
        {count}
      </span>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  tStatus: ReturnType<typeof useTranslations>;
  /** Time left in the 24h window, e.g. "3h" — null once it's expired
   *  (or never started). Computed by the parent from the 60s tick, and
   *  passed as plain strings so this row only re-renders when its own
   *  countdown actually changes — see the memo wrapper below. */
  remainingCompact: string | null;
  /** Full phrase for tooltip/screen readers, e.g. "3h remaining". */
  remainingLabel: string | null;
  /** True when this row sits in the template-only group — its window
   *  has lapsed, or the contact has never messaged in. */
  needsTemplate: boolean;
  /** Distinguishes the two template-only cases: a fresh lead who has
   *  never replied isn't the same thing as a conversation that ran
   *  out of time, even though WhatsApp restricts both identically. */
  neverReplied: boolean;
}

// Memoized so the list's 60s tick doesn't re-render every row — only
// ones whose countdown (or other props) actually changed.
const ConversationItem = memo(function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  tStatus,
  remainingCompact,
  remainingLabel,
  needsTemplate,
  neverReplied,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const statusDisplay = getConversationStatus(conversation.status);
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            {needsTemplate && (
              // Same bare-marker treatment as the countdown opposite it
              // — it answers the same question ("what can I do here?"),
              // just with the other answer.
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-amber-400"
                title={
                  neverReplied
                    ? t("neverRepliedHint")
                    : t("expiredHint")
                }
              >
                <LayoutTemplate className="h-3 w-3" />
                {neverReplied ? t("neverRepliedShort") : t("expiredShort")}
              </span>
            )}
            {remainingCompact && (
              // Orthogonal to `status` on purpose (not a 4th status
              // value) — a conversation can be open/pending AND still
              // have time left on its WhatsApp window. Deliberately NOT
              // a bordered chip: that shape is the status vocabulary
              // right next to it, and reusing it here (in green, beside
              // a green "Open" chip) would read as a second status. A
              // bare clock + number reads as "time left" instead.
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-emerald-400"
                title={remainingLabel ?? undefined}
                aria-label={remainingLabel ?? undefined}
              >
                <Clock className="h-3 w-3" />
                {remainingCompact}
              </span>
            )}
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium leading-none whitespace-nowrap",
                statusDisplay.classes
              )}
            >
              {tStatus(`status${statusDisplay.labelKey}`)}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
});
