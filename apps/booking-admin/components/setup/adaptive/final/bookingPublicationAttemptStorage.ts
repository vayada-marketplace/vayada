import type { PublicationAttempt } from "@/services/api/bookingPublicationReviewClient";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function key(org: string, property: string) {
  return `vayada:booking-publication:${org}:${property}`;
}
export function readBookingPublicationAttempt(
  store: Store,
  organizationId: string,
  propertyId: string,
): PublicationAttempt | null {
  const raw = store.getItem(key(organizationId, propertyId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as PublicationAttempt;
    if (
      value.propertyId !== propertyId ||
      typeof value.idempotencyKey !== "string" ||
      !value.idempotencyKey.trim() ||
      value.idempotencyKey.length > 200 ||
      !value.body ||
      !(
        value.body.expectedActiveContentRevisionId === null ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value.body.expectedActiveContentRevisionId,
        )
      ) ||
      !/^sha256:[0-9a-f]{64}$/.test(value.body.expectedReadinessHash) ||
      !/^sha256:[0-9a-f]{64}$/.test(value.body.expectedSourceManifestHash)
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(
      "The saved publication request could not be restored. Contact support before starting another request.",
    );
  }
}
export async function saveBookingPublicationAttempt(
  store: Store,
  organizationId: string,
  attempt: PublicationAttempt,
  expectedKey: string | null,
) {
  return withAttemptLock(organizationId, attempt.propertyId, () => {
    if (
      (readBookingPublicationAttempt(store, organizationId, attempt.propertyId)?.idempotencyKey ??
        null) !== expectedKey
    )
      throw new Error(
        "The saved publication request changed in another tab. Refresh its status before continuing.",
      );
    try {
      store.setItem(key(organizationId, attempt.propertyId), JSON.stringify(attempt));
      if (
        JSON.stringify(readBookingPublicationAttempt(store, organizationId, attempt.propertyId)) !==
        JSON.stringify(attempt)
      )
        throw new Error();
    } catch {
      throw new Error(
        "Your browser could not save this publication request for recovery. Check browser storage and try again.",
      );
    }
  });
}

export async function clearRejectedBookingPublicationAttempt(
  store: Store,
  organizationId: string,
  attempt: PublicationAttempt,
) {
  return withAttemptLock(organizationId, attempt.propertyId, () => {
    const current = readBookingPublicationAttempt(store, organizationId, attempt.propertyId);
    if (current?.idempotencyKey !== attempt.idempotencyKey)
      throw new Error(
        "The saved request changed in another tab. Refresh its status before continuing.",
      );
    store.removeItem(key(organizationId, attempt.propertyId));
    if (readBookingPublicationAttempt(store, organizationId, attempt.propertyId) !== null)
      throw new Error(
        "Your browser could not clear the rejected request. Refresh before continuing.",
      );
  });
}
async function withAttemptLock<T>(
  organizationId: string,
  propertyId: string,
  action: () => T,
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks)
    throw new Error(
      "This browser cannot safely coordinate publication requests. Use a browser with Web Locks support.",
    );
  return navigator.locks.request(key(organizationId, propertyId), action);
}
