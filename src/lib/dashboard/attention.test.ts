import { describe, expect, it } from "vitest";
import {
  buildReplyQueue,
  summarizeFollowUps,
  type ReplyQueueRow,
} from "./attention";

const NOW = new Date("2026-10-07T12:00:00");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

function row(
  id: string,
  sender: string | null,
  customerHoursAgo: number,
  extra: Partial<ReplyQueueRow> = {},
): ReplyQueueRow {
  return {
    id,
    assigned_agent_id: null,
    last_customer_message_at: hoursAgo(customerHoursAgo),
    last_message_text: `msg ${id}`,
    ai_autoreply_disabled: false,
    ai_handoff_summary: null,
    contact: { name: `Contact ${id}`, phone: `+52${id}` },
    messages: sender
      ? [{ sender_type: sender, created_at: hoursAgo(customerHoursAgo) }]
      : [],
    ...extra,
  };
}

describe("buildReplyQueue", () => {
  it("keeps only threads whose newest message is the customer's", () => {
    const queue = buildReplyQueue(
      [
        row("a", "customer", 2),
        row("b", "agent", 2),
        row("c", "bot", 2),
        row("d", null, 2),
      ],
      NOW,
    );
    expect(queue.map((i) => i.conversationId)).toEqual(["a"]);
  });

  it("puts open windows first, closing soonest on top, then lapsed newest first", () => {
    const queue = buildReplyQueue(
      [
        row("fresh", "customer", 1),
        row("lapsed-old", "customer", 24 * 30),
        row("closing", "customer", 22),
        row("lapsed-new", "customer", 30),
      ],
      NOW,
    );
    expect(queue.map((i) => i.conversationId)).toEqual([
      "closing",
      "fresh",
      "lapsed-new",
      "lapsed-old",
    ]);
  });

  // Same truncation as the inbox's session badge (session-window.ts), so
  // the two surfaces never disagree about how long is left.
  it("reports whole hours left as the inbox does, null once lapsed", () => {
    const queue = buildReplyQueue(
      [
        row("a", "customer", 5),
        row("b", "customer", 23.5),
        row("c", "customer", 25),
      ],
      NOW,
    );
    const left = Object.fromEntries(
      queue.map((i) => [i.conversationId, i.hoursLeft]),
    );
    expect(left).toEqual({ a: 19, b: 1, c: null });
  });

  it("marks a handoff only when the bot is paused and left a note", () => {
    const queue = buildReplyQueue(
      [
        row("note", "customer", 1, {
          ai_autoreply_disabled: true,
          ai_handoff_summary: "Wants a visit",
        }),
        row("paused", "customer", 1, { ai_autoreply_disabled: true }),
        row("stale-note", "customer", 1, { ai_handoff_summary: "old" }),
      ],
      NOW,
    );
    const handedOff = Object.fromEntries(
      queue.map((i) => [i.conversationId, i.handedOff]),
    );
    expect(handedOff).toEqual({ note: true, paused: false, "stale-note": false });
  });

  it("names the contact, falling back to the phone, from an embedded array", () => {
    const [item] = buildReplyQueue(
      [row("a", "customer", 1, { contact: [{ name: null, phone: "+5211" }] })],
      NOW,
    );
    expect(item.contactName).toBe("+5211");
  });

  it("falls back to the message time when the column was never set", () => {
    const [item] = buildReplyQueue(
      [row("a", "customer", 3, { last_customer_message_at: null })],
      NOW,
    );
    expect(item.customerAt).toBe(hoursAgo(3));
    expect(item.hoursLeft).toBe(21);
  });
});

describe("summarizeFollowUps", () => {
  const deal = (
    visit: string | null,
    install: string | null,
    quoted: string | null = null,
  ) => ({
    technical_visit_at: visit,
    installation_date: install,
    quoted_at: quoted,
  });

  it("counts visits that already happened without an install date", () => {
    const summary = summarizeFollowUps(
      [
        deal("2026-10-01T10:00:00", null),
        deal("2026-10-01T10:00:00", "2026-10-20"),
        deal("2026-10-09T10:00:00", null),
        deal(null, null),
      ],
      NOW,
    );
    expect(summary.visitDoneNoInstall).toBe(1);
    expect(summary.openDeals).toBe(4);
  });

  it("counts visits and installs inside the next 7 days, including an install today", () => {
    const summary = summarizeFollowUps(
      [
        deal("2026-10-08T09:00:00", null),
        deal("2026-10-07T09:00:00", null),
        deal("2026-10-20T09:00:00", null),
        deal(null, "2026-10-07"),
        deal(null, "2026-10-13"),
        deal(null, "2026-10-15"),
      ],
      new Date("2026-10-07T15:00:00"),
    );
    expect(summary.visitsNext7).toBe(1);
    expect(summary.installsNext7).toBe(2);
  });

  it("counts open deals that already have a quote", () => {
    const summary = summarizeFollowUps(
      [
        deal(null, null, "2026-09-01T00:00:00Z"),
        deal(null, null, null),
        deal(null, null, "2026-10-01T00:00:00Z"),
      ],
      NOW,
    );
    expect(summary.quotedOpen).toBe(2);
  });
});
