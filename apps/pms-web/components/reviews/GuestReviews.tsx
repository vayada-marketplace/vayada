"use client";
import { useRef, useState } from "react";
import { ApiErrorResponse } from "@/services/api/client";
import { useTranslation } from "@/lib/i18n";
import {
  checkGuestReview,
  listGuestReviews,
  submitGuestReview,
  type GuestReviewDraft,
  type GuestReviewOpportunity,
} from "@/services/api/pmsReviewsClient";
const empty: GuestReviewDraft = {
  respectHouseRules: 0,
  communication: 0,
  cleanliness: 0,
  publicReview: "",
  privateReview: "",
  recommended: false,
};
const ratings = ["respectHouseRules", "communication", "cleanliness"] as const;
export function GuestReviews({ propertyId }: { propertyId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<GuestReviewOpportunity[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const result = await listGuestReviews(propertyId, page + 1);
      setItems((current) =>
        Array.from(
          new Map(
            [...current, ...result.items, ...result.stored].map((item) => [item.reviewId, item]),
          ).values(),
        ),
      );
      setUnavailable(result.unavailable);
      setMore(result.more);
      if (!result.unavailable) setPage(page + 1);
    } catch {
      setUnavailable(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="font-semibold">{t("reviews.guest.title")}</h2>
      <p className="mt-1 text-sm text-gray-500">{t("reviews.guest.limitation")}</p>
      {unavailable && <p role="status">{t("reviews.guest.unavailable")}</p>}
      {!!page && !items.length && !unavailable && (
        <p className="mt-3 text-sm">{t("reviews.guest.empty")}</p>
      )}
      {items.map((item) => (
        <GuestReview key={item.reviewId} propertyId={propertyId} initial={item} />
      ))}
      {(!page || more || unavailable) && (
        <button
          disabled={busy}
          onClick={() => void load()}
          className="mt-3 text-sm font-medium text-teal-700 disabled:opacity-50"
        >
          {t(busy ? "reviews.loading" : "reviews.guest.load")}
        </button>
      )}
    </section>
  );
}
function GuestReview({
  propertyId,
  initial,
}: {
  propertyId: string;
  initial: GuestReviewOpportunity;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(initial);
  const [draft, setDraft] = useState<GuestReviewDraft>(initial.draft ?? empty);
  const [opened, setOpened] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function run(send: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = send
        ? await submitGuestReview(propertyId, status.reviewId, draft)
        : await checkGuestReview(propertyId, status.reviewId);
      setStatus(result);
      setOpened(true);
      setPreview(false);
    } catch (error) {
      const invalid = error instanceof ApiErrorResponse && error.status === 400;
      const denied = error instanceof ApiErrorResponse && [401, 403].includes(error.status);
      setPreview(false);
      setStatus((current) => ({
        ...current,
        state: invalid ? "failed" : denied ? "unavailable" : send ? "uncertain" : "unavailable",
        reason: invalid ? "invalid_input" : denied ? "permission_required" : "provider_unavailable",
      }));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const reasonKey = `reviews.guest.reason.${status.reason}`;
  const reason = t(reasonKey);
  const editable = opened && ["ready", "failed"].includes(status.state);
  const shown = status.state === "accepted" ? status.draft : draft;
  return (
    <article className="mt-4 border-t border-gray-100 pt-4">
      <h3 className="font-medium">
        {status.guestName || initial.guestName} ·{" "}
        {status.reservationCode || initial.reservationCode}
      </h3>
      <p role="status" className="mt-1 text-sm">
        {t(`reviews.guest.${busy ? "submitting" : status.state}`)}
      </p>
      {status.reason && (
        <p className="text-sm text-gray-500">
          {reason === reasonKey ? t("reviews.guest.reason.provider_unavailable") : reason}
        </p>
      )}
      {(editable || preview || (shown && status.state !== "ready")) && (
        <fieldset disabled={busy || !editable || preview} className="mt-3 space-y-3">
          {ratings.map((key) => (
            <label key={key} className="block text-sm">
              {t(`reviews.guest.${key}`)}
              <select
                aria-label={t(`reviews.guest.${key}`)}
                value={shown?.[key] ?? 0}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))
                }
                className="ml-3 rounded border p-2"
              >
                <option value={0}>—</option>
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value}/5
                  </option>
                ))}
              </select>
            </label>
          ))}
          {(["publicReview", "privateReview"] as const).map((key) => (
            <label key={key} className="block text-sm">
              {t(`reviews.guest.${key}`)}
              <textarea
                value={shown?.[key] ?? ""}
                maxLength={10000}
                rows={3}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [key]: event.target.value }))
                }
                className="mt-1 block w-full rounded-lg border p-3"
              />
            </label>
          ))}
          <label className="block text-sm">
            <input
              type="checkbox"
              checked={shown?.recommended ?? false}
              onChange={(event) =>
                setDraft((current) => ({ ...current, recommended: event.target.checked }))
              }
            />{" "}
            {t("reviews.guest.recommended")}
          </label>
        </fieldset>
      )}
      {editable && !preview && (
        <button
          disabled={busy || !draft.publicReview.trim() || ratings.some((key) => !draft[key])}
          onClick={() => setPreview(true)}
          className="mt-3 rounded bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {t("reviews.guest.preview")}
        </button>
      )}
      {preview && (
        <div className="mt-3 space-x-3">
          <p className="mb-3 text-sm">{t("reviews.guest.notice")}</p>
          <button disabled={busy} onClick={() => setPreview(false)}>
            {t("reviews.guest.edit")}
          </button>
          <button
            disabled={busy}
            onClick={() => void run(true)}
            className="rounded bg-teal-700 px-4 py-2 text-white"
          >
            {t("reviews.guest.submit")}
          </button>
        </div>
      )}
      {!preview && status.state !== "accepted" && !editable && (
        <button
          disabled={busy}
          onClick={() => void run(false)}
          className="mt-3 text-sm text-teal-700"
        >
          {t("reviews.guest.check")}
        </button>
      )}
    </article>
  );
}
