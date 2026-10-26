/** A hotel account's contract with vayada (VAY-2246): the hotel terms (vayada.com/terms) and their annex,
 * the data processing agreement (vayada.com/terms/dpa, GDPR Art. 28). The account accepts both together,
 * at sign-up or later through its account admin; each acceptance records these versions, so a text change
 * needs a new version date here and on the page. */

export type HotelAccountAgreementVersions = {
  /** The hotel terms' Effective Date. */
  termsVersion: string;
  /** The data processing agreement's Version. */
  dpaVersion: string;
};

export const CURRENT_HOTEL_ACCOUNT_AGREEMENTS: Readonly<HotelAccountAgreementVersions> =
  Object.freeze({ termsVersion: "2026-10-24", dpaVersion: "2026-10-24" });

/** Where an acceptance came from: the sign-up tickbox, or the account admin's banner or settings card. */
export type HotelAccountAgreementSource = "signup" | "account_admin";

export type HotelAccountAgreementAcceptance = HotelAccountAgreementVersions & {
  acceptedAt: string;
  acceptedBy: { name: string | null; email: string };
  source: HotelAccountAgreementSource;
};

/** GET /api/hotel-account/agreements for the selected hotel account. */
export type HotelAccountAgreementsStatus = {
  current: HotelAccountAgreementVersions;
  /** The acceptance of the current versions, or null while they still need accepting. */
  accepted: HotelAccountAgreementAcceptance | null;
  /** The signed-in person is the account admin, who accepts for the account. */
  canAccept: boolean;
  /** The hotel account's name, for "you accept it for …"; null when the session doesn't carry it. */
  accountName: string | null;
};

/** True for exactly the current versions: an acceptance never records a version the person wasn't shown. */
export function isCurrentHotelAccountAgreements(
  value: unknown,
): value is HotelAccountAgreementVersions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const { termsVersion, dpaVersion } = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    termsVersion === CURRENT_HOTEL_ACCOUNT_AGREEMENTS.termsVersion &&
    dpaVersion === CURRENT_HOTEL_ACCOUNT_AGREEMENTS.dpaVersion
  );
}
