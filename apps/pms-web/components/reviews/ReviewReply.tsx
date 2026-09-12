"use client";

import { useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import {
  checkReviewReply,
  submitReviewReply,
  type ReviewReplyStatus,
} from "@/services/api/pmsReviewsClient";

export function ReviewReply({
  propertyId,
  reviewId,
  initialStatus,
}: {
  propertyId: string;
  reviewId: string;
  initialStatus?: ReviewReplyStatus | null;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReviewReplyStatus | null>(initialStatus ?? null);
  const [text, setText] = useState(initialStatus?.draft ?? "");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function run(submit: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = submit
        ? await submitReviewReply(propertyId, reviewId, text)
        : await checkReviewReply(propertyId, reviewId);
      setStatus(result);
      setChecked(true);
      if (!submit && result.draft) setText((current) => current || result.draft!);
    } catch (error) {
      const denied = error instanceof ApiErrorResponse && [401, 403].includes(error.status);
      const invalid = error instanceof ApiErrorResponse && error.status === 400;
      setStatus({
        state: denied ? "unavailable" : invalid ? "failed" : submit ? "uncertain" : "unavailable",
        reason: denied ? "permission_required" : invalid ? "invalid_reply" : "provider_unreachable",
      });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const reasonKey = `reviews.reply.reason.${status?.reason}`;
  const reason = t(reasonKey);
  const editable = checked && (status?.state === "ready" || status?.state === "failed");
  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      {!status ? (
        <button
          disabled={busy}
          onClick={() => void run(false)}
          className="text-sm font-medium text-teal-700 disabled:opacity-50"
        >
          {t(busy ? "reviews.reply.checking" : "reviews.reply.open")}
        </button>
      ) : (
        <>
          <p role="status" className="text-sm text-gray-700">
            {t(`reviews.reply.${busy ? "submitting" : status.state}`)}
          </p>
          {status.reason && (
            <p className="mt-1 text-sm text-gray-500">
              {reason === reasonKey ? t("reviews.reply.reason.provider_unreachable") : reason}
            </p>
          )}
          {status.state === "accepted" && !status.replyBody && status.draft && (
            <p className="mt-2 text-xs text-gray-500">{t("reviews.reply.submittedText")}</p>
          )}
          {(status.replyBody || (status.state === "accepted" && status.draft)) && (
            <p className="mt-2 whitespace-pre-wrap text-sm">{status.replyBody || status.draft}</p>
          )}
          {editable && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(true);
              }}
              className="mt-3 space-y-2"
            >
              <label className="block text-sm font-medium">
                {t("reviews.reply.label")}
                <textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  required
                  maxLength={10000}
                  disabled={busy}
                  className="mt-1 block w-full rounded-lg border border-gray-300 p-3"
                  rows={4}
                />
              </label>
              <p className="text-xs text-gray-500">{t("reviews.reply.notice")}</p>
              <button
                disabled={busy || !text.trim()}
                type="submit"
                className="rounded-lg bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {t("reviews.reply.submit")}
              </button>
            </form>
          )}
          {["uncertain", "unavailable"].includes(status.state) && text && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-gray-500">{text}</p>
          )}
          {(["uncertain", "unavailable"].includes(status.state) ||
            (status.state === "failed" && !checked)) && (
            <button
              disabled={busy}
              onClick={() => void run(false)}
              className="mt-2 text-sm font-medium text-teal-700 disabled:opacity-50"
            >
              {t("reviews.reply.check")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
