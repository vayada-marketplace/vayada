import { apiClient } from "./client";

/** The hotel's bank account vayada Payment pays it out to (VAY-2442). Anyone with finance access
 * sees it masked; only the owner can add, replace or remove it. The route exists only while
 * vayada Payment is switched on. */
export type SavedPayoutDestination = {
  id: string;
  revision: number;
  version: number;
  enabled: boolean;
  deleted: boolean;
  countryCode: string;
  maskedAccount: string | null;
};

export type PayoutDestinationDetails = {
  accountHolder: string;
  accountNumber: string;
  bankName: string;
  bankCode: string;
  branchCode: string;
  bicSwift: string;
  holderAddress: string;
};

/** Countries vayada Payment pays out in (hotels Stripe Connect can't serve). */
export const PAYOUT_COUNTRIES = ["ID", "LK"] as const;

const path = (propertyId: string) =>
  `/api/finance/properties/${encodeURIComponent(propertyId.trim())}/payout-destination`;

/** The latest revision, removed ones included: its version is what the next change expects. */
export async function readPayoutDestination(propertyId: string) {
  const { destination } = await apiClient.get<{ destination: SavedPayoutDestination | null }>(
    path(propertyId),
  );
  return destination;
}

/** A saved account payouts go to (not removed). */
export const activePayoutDestination = (destination: SavedPayoutDestination | null) =>
  destination && destination.enabled && !destination.deleted ? destination : null;

/** What the server accepts (financePayoutDestinationCodec), plus the code a transfer there needs:
 * a bank code for Indonesian banks, a branch code for Sri Lankan ones. */
export function payoutDetailsValid(
  countryCode: string,
  details: PayoutDestinationDetails,
): boolean {
  const number = details.accountNumber.trim();
  const code = (countryCode === "LK" ? details.branchCode : details.bankCode).trim();
  return (
    details.accountHolder.trim().length > 0 &&
    details.accountHolder.trim().length <= 200 &&
    /^[A-Za-z0-9 -]+$/.test(number) &&
    number.length <= 64 &&
    number.replace(/[ -]/g, "").length >= 6 &&
    details.bankName.trim().length > 0 &&
    details.bankName.trim().length <= 200 &&
    code.length > 0 &&
    code.length <= 32 &&
    details.bicSwift.trim().length <= 32 &&
    details.holderAddress.trim().length <= 500
  );
}

/** Saves the account. `commandId` stays the same when the same save is retried (a lost response
 * then replays instead of conflicting). Only the code the country uses is sent. */
export async function savePayoutDestination(input: {
  propertyId: string;
  commandId: string;
  countryCode: string;
  details: PayoutDestinationDetails;
  saved: SavedPayoutDestination | null;
}) {
  const trimmed = Object.fromEntries(
    Object.entries(input.details).map(([key, value]) => [key, value.trim()]),
  ) as PayoutDestinationDetails;
  if (input.countryCode === "LK") trimmed.bankCode = "";
  else trimmed.branchCode = "";
  const { destination } = await apiClient.put<{ destination: SavedPayoutDestination }>(
    path(input.propertyId),
    {
      action: "replace",
      commandId: input.commandId,
      expectedVersion: input.saved?.version ?? 0,
      countryCode: input.countryCode,
      details: trimmed,
    },
  );
  return destination;
}

/** Removes the account; the answer is the removed revision, whose version the next save expects. */
export async function removePayoutDestination(input: {
  propertyId: string;
  commandId: string;
  saved: SavedPayoutDestination;
}) {
  const { destination } = await apiClient.put<{ destination: SavedPayoutDestination }>(
    path(input.propertyId),
    { action: "delete", commandId: input.commandId, expectedVersion: input.saved.version },
  );
  return destination;
}
