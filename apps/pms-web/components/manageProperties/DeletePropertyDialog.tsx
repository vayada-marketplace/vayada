"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  HotelPropertyDeletionBlocker,
  HotelPropertyDeletionCheck,
} from "@vayada/domain-hotels";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import {
  deleteProperty,
  getPropertyDeletionCheck,
  propertyDeletionFailure,
} from "@/services/api/propertyDeletionClient";

type Translate = ReturnType<typeof useTranslation>["t"];

/** Same rule as the API: the exact name, ignoring only spaces at either end. */
export function deletionNameMatches(typed: string, displayName: string): boolean {
  const name = displayName.trim();
  return name.length > 0 && typed.trim() === name;
}

export function blockerText(t: Translate, blocker: HotelPropertyDeletionBlocker): string {
  const count = blocker.count;
  switch (blocker.code) {
    case "last_property":
      return t("manageProperties.blockerLastProperty");
    case "upcoming_bookings":
      return count === 1
        ? t("manageProperties.blockerUpcomingBookingsOne")
        : t("manageProperties.blockerUpcomingBookings", { count });
    case "connected_channels":
      return t("manageProperties.blockerConnectedChannels");
    case "unresolved_payments":
      return count === 1
        ? t("manageProperties.blockerOpenPaymentsOne")
        : t("manageProperties.blockerOpenPayments", { count });
    case "open_payouts":
      return count === 1
        ? t("manageProperties.blockerOpenPayoutsOne")
        : t("manageProperties.blockerOpenPayouts", { count });
    case "shared_property":
      return t("manageProperties.blockerSharedProperty");
  }
}

/**
 * VAY-2493: deleting a property takes two steps. Step 1 says what deleting does and lists what still
 * blocks it; step 2 asks for the exact property name. The API checks both again.
 */
export default function DeletePropertyDialog({
  property,
  onClose,
  onDeleted,
}: {
  property: { id: string; name: string };
  onClose: () => void;
  onDeleted: (check: HotelPropertyDeletionCheck) => void;
}) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<HotelPropertyDeletionCheck | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState<"review" | "confirm">("review");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per dialog: a retried click repeats the same delete instead of starting another.
  const idempotencyKey = useRef(newIdempotencyKey());

  const load = useCallback(async () => {
    setLoadFailed(false);
    setCheck(null);
    try {
      setCheck(await getPropertyDeletionCheck(property.id));
    } catch {
      setLoadFailed(true);
    }
  }, [property.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const name = check?.displayName ?? property.name;
  const close = () => {
    if (!busy) onClose();
  };

  async function confirm() {
    if (!check || busy || !deletionNameMatches(typed, check.displayName)) return;
    setBusy(true);
    setError("");
    try {
      await deleteProperty({
        propertyId: check.propertyId,
        expectedLifecycleRevision: check.lifecycleRevision,
        confirmationName: typed,
        idempotencyKey: idempotencyKey.current,
      });
      onDeleted(check);
    } catch (failure) {
      const outcome = propertyDeletionFailure(failure);
      setBusy(false);
      if (outcome.code === "blocked" || outcome.code === "changed") {
        // Back to step 1 with what blocks it now; a new delete needs a new key.
        idempotencyKey.current = newIdempotencyKey();
        setTyped("");
        setStep("review");
        if (outcome.check) setCheck(outcome.check);
        else void load();
        setError(outcome.code === "changed" ? t("manageProperties.changed") : "");
        return;
      }
      setError(
        outcome.code === "name_mismatch"
          ? t("manageProperties.nameMismatch")
          : outcome.code === "gone"
            ? t("manageProperties.gone")
            : outcome.code === "not_allowed"
              ? t("manageProperties.notAllowed")
              : t("manageProperties.failed"),
      );
    }
  }

  const footer =
    step === "review" ? (
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={close}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={!check?.canDelete}
          onClick={() => {
            setError("");
            setStep("confirm");
          }}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {t("manageProperties.deleteProperty")}
        </button>
      </div>
    ) : (
      <div className="flex justify-end gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={close}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={busy || !check || !deletionNameMatches(typed, check.displayName)}
          onClick={() => void confirm()}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? t("manageProperties.deleting") : t("manageProperties.confirmDeletion")}
        </button>
      </div>
    );

  return (
    <Modal
      onClose={close}
      ariaLabel={
        step === "review"
          ? t("manageProperties.reviewTitle", { name })
          : t("manageProperties.confirmTitle")
      }
      footer={footer}
    >
      {step === "review" ? (
        <>
          <h2 className="text-lg font-semibold text-gray-900">
            {t("manageProperties.reviewTitle", { name })}
          </h2>
          <p className="mt-2 text-sm text-gray-600">{t("manageProperties.reviewBody", { name })}</p>
          {error && (
            <p role="alert" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {error}
            </p>
          )}
          {!check && !loadFailed && (
            <p role="status" className="mt-4 text-sm text-gray-500">
              {t("manageProperties.checking")}
            </p>
          )}
          {loadFailed && (
            <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              <p>{t("manageProperties.checkFailed")}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 font-medium underline"
              >
                {t("common.retry")}
              </button>
            </div>
          )}
          {check && check.blockers.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="flex items-center gap-2 font-medium">
                <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t("manageProperties.blockedIntro")}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-6">
                {check.blockers.map((blocker) => (
                  <li key={blocker.code}>{blockerText(t, blocker)}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold text-gray-900">
            {t("manageProperties.confirmTitle")}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {t("manageProperties.confirmBody")}{" "}
            <span className="font-semibold text-gray-900">{name}</span>
          </p>
          <label className="mt-4 block text-sm font-medium text-gray-900">
            {t("manageProperties.nameLabel")}
            <input
              type="text"
              value={typed}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void confirm();
              }}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
          </label>
          {error && (
            <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `property-delete-${crypto.randomUUID()}`
    : `property-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
