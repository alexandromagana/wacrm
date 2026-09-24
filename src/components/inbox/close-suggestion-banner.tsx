"use client";

import { useState } from "react";
import { Archive, BellOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import type { Conversation } from "@/types";
import { useLostReasonLabel } from "@/components/pipelines/lost-reason-label";
import { Banner, BannerButton } from "./ai-thread-banner";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The lifecycle sweep never closes a chat a person owns; it flags it
 * instead (`close_suggested_at`, src/lib/lifecycle/rules.ts). This is
 * where that person decides: close it — losing the deal with the same
 * reason the sweep would have used — or keep it open, which stops the
 * sweep suggesting it again until the customer writes.
 */
export function CloseSuggestionBanner({
  conversation,
  onClosed,
}: {
  conversation: Conversation;
  onClosed: () => void;
}) {
  const t = useTranslations("Inbox.closeSuggestion");
  const reasonLabel = useLostReasonLabel();
  const [busy, setBusy] = useState<"close" | "keep" | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  if (
    !conversation.close_suggested_at ||
    conversation.status === "closed" ||
    dismissedFor === conversation.id
  ) {
    return null;
  }

  // Silence as of when the sweep flagged it — stable across renders.
  const since = conversation.last_customer_message_at ?? conversation.created_at;
  const days = Math.max(
    0,
    Math.floor((Date.parse(conversation.close_suggested_at) - Date.parse(since)) / DAY_MS),
  );

  async function close() {
    setBusy("close");
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/close`, { method: "POST" });
      if (!res.ok) {
        toast.error(t("closeError"));
        return;
      }
      toast.success(t("closed"));
      onClosed();
    } catch {
      toast.error(t("closeError"));
    } finally {
      setBusy(null);
    }
  }

  async function keepOpen() {
    setBusy("keep");
    const { error } = await createClient()
      .from("conversations")
      .update({
        close_suggested_at: null,
        close_suggested_reason: null,
        close_suggestion_dismissed_at: new Date().toISOString(),
      })
      .eq("id", conversation.id);
    setBusy(null);
    if (error) {
      toast.error(t("keepError"));
      return;
    }
    setDismissedFor(conversation.id);
  }

  return (
    <Banner tone="muted">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{t("title")}</p>
        <p className="truncate text-muted-foreground">
          {t("detail", {
            reason: reasonLabel(conversation.close_suggested_reason),
            days,
          })}
        </p>
      </div>
      <BannerButton onClick={keepOpen} busy={busy === "keep"} icon={BellOff}>
        {t("keepOpen")}
      </BannerButton>
      <BannerButton onClick={close} busy={busy === "close"} icon={Archive}>
        {t("close")}
      </BannerButton>
    </Banner>
  );
}
