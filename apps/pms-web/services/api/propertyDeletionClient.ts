import type {
  HotelPropertyDeletionCheck,
  HotelPropertyDeletionResult,
} from "@vayada/domain-hotels";

import { ApiErrorResponse } from "./client";
import { sharedSetupClient } from "./sharedHotelSetupClient";

/** VAY-2493: Manage Properties. Only the account admin may call these; the API checks it too. */
export function getPropertyDeletionCheck(propertyId: string): Promise<HotelPropertyDeletionCheck> {
  return sharedSetupClient.get<HotelPropertyDeletionCheck>(
    `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/deletion-check`,
  );
}

export function deleteProperty(input: {
  propertyId: string;
  expectedLifecycleRevision: number;
  confirmationName: string;
  idempotencyKey: string;
}): Promise<HotelPropertyDeletionResult> {
  return sharedSetupClient.post<HotelPropertyDeletionResult>(
    `/api/hotel-setup/properties/${encodeURIComponent(input.propertyId)}/delete`,
    {
      expectedLifecycleRevision: input.expectedLifecycleRevision,
      confirmationName: input.confirmationName,
    },
    { headers: { "Idempotency-Key": input.idempotencyKey } },
  );
}

export type PropertyDeletionFailure =
  | { code: "blocked" | "changed"; check: HotelPropertyDeletionCheck | null }
  | { code: "name_mismatch" | "gone" | "not_allowed" | "failed"; check: null };

/** What a failed delete means for the dialog. */
export function propertyDeletionFailure(error: unknown): PropertyDeletionFailure {
  if (!(error instanceof ApiErrorResponse)) return { code: "failed", check: null };
  const data = error.data as { code?: string; check?: HotelPropertyDeletionCheck };
  switch (data.code) {
    case "deletion_blocked":
      return { code: "blocked", check: data.check ?? null };
    case "lifecycle_revision_conflict":
      return { code: "changed", check: data.check ?? null };
    case "confirmation_name_mismatch":
      return { code: "name_mismatch", check: null };
    case "property_already_deleted":
    case "property_not_found":
      return { code: "gone", check: null };
    case "account_admin_required":
      return { code: "not_allowed", check: null };
    default:
      return { code: "failed", check: null };
  }
}
