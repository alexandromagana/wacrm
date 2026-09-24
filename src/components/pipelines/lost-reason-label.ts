"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { isKnownLostReason } from "@/lib/deals/lost-reasons";

/**
 * Label for a `deals.lost_reason`: known keys are translated, free text
 * (a manual "other" reason) is shown as typed.
 */
export function useLostReasonLabel() {
  const t = useTranslations("LostReasons");
  return useCallback(
    (reason: string | null | undefined) => {
      if (!reason) return t("none");
      return isKnownLostReason(reason) ? t(reason) : reason;
    },
    [t],
  );
}
