import { describe, expect, it } from "vitest";
import { getWhatsAppSessionInfo } from "./session-window";

describe("getWhatsAppSessionInfo", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");

  it("reports no customer message for null/undefined input, and does not mark it as an expired window", () => {
    for (const value of [null, undefined]) {
      const info = getWhatsAppSessionInfo(value, now);
      expect(info.hasCustomerMessage).toBe(false);
      expect(info.windowExpired).toBe(false);
      expect(info.remaining).toEqual({ kind: "noCustomerMessage" });
    }
  });

  it("is not expired just under 24h since the last customer message", () => {
    const lastMessage = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString();
    const info = getWhatsAppSessionInfo(lastMessage, now);
    expect(info.hasCustomerMessage).toBe(true);
    expect(info.windowExpired).toBe(false);
    expect(info.remaining).toEqual({ kind: "hoursRemaining", hours: 1 });
  });

  it("truncates partial hours (differenceInHours semantics) rather than rounding — 23.9h since the last customer message still reads as 1h remaining, not expired", () => {
    const lastMessage = new Date(now.getTime() - 23.9 * 60 * 60 * 1000).toISOString();
    const info = getWhatsAppSessionInfo(lastMessage, now);
    expect(info.windowExpired).toBe(false);
    expect(info.remaining).toEqual({ kind: "hoursRemaining", hours: 1 });
  });

  it("is expired at exactly 24h (boundary is inclusive)", () => {
    const lastMessage = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const info = getWhatsAppSessionInfo(lastMessage, now);
    expect(info.hasCustomerMessage).toBe(true);
    expect(info.windowExpired).toBe(true);
    expect(info.remaining).toEqual({ kind: "expired" });
  });

  it("stays expired well past 24h", () => {
    const lastMessage = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
    const info = getWhatsAppSessionInfo(lastMessage, now);
    expect(info.windowExpired).toBe(true);
    expect(info.remaining).toEqual({ kind: "expired" });
  });

  it("defaults `now` to the current time when omitted", () => {
    // Sanity check the default param wiring — not exact, just "recent".
    const info = getWhatsAppSessionInfo(new Date().toISOString());
    expect(info.windowExpired).toBe(false);
  });
});
