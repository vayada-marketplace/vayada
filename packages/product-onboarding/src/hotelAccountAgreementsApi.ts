import type {
  HotelAccountAgreementAcceptance,
  HotelAccountAgreementsStatus,
  HotelAccountAgreementVersions,
} from "@vayada/domain-hotels";

type Http = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, value?: unknown, options?: RequestInit): Promise<T>;
};

const PATH = "/api/hotel-account/agreements";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function versions(value: unknown): HotelAccountAgreementVersions | null {
  if (!isRecord(value)) return null;
  const { termsVersion, dpaVersion } = value;
  return typeof termsVersion === "string" && typeof dpaVersion === "string"
    ? { termsVersion, dpaVersion }
    : null;
}

function acceptance(value: unknown): HotelAccountAgreementAcceptance | null {
  const accepted = versions(value);
  if (!accepted || !isRecord(value) || !isRecord(value.acceptedBy)) return null;
  const { acceptedAt, source, acceptedBy } = value;
  if (typeof acceptedAt !== "string" || (source !== "signup" && source !== "account_admin"))
    return null;
  if (typeof acceptedBy.email !== "string") return null;
  return {
    ...accepted,
    acceptedAt,
    source,
    acceptedBy: {
      name: typeof acceptedBy.name === "string" ? acceptedBy.name : null,
      email: acceptedBy.email,
    },
  };
}

/** The API's answer (apps/api routes/hotelAccountAgreements.ts), or null when it isn't one. */
export function parseHotelAccountAgreementsStatus(
  value: unknown,
): HotelAccountAgreementsStatus | null {
  if (!isRecord(value) || typeof value.canAccept !== "boolean") return null;
  const current = versions(value.current);
  const accepted = value.accepted === null ? null : acceptance(value.accepted);
  if (!current || (value.accepted !== null && !accepted)) return null;
  return {
    current,
    accepted,
    canAccept: value.canAccept,
    accountName: typeof value.accountName === "string" ? value.accountName : null,
  };
}

function status(value: unknown): HotelAccountAgreementsStatus {
  const parsed = parseHotelAccountAgreementsStatus(value);
  if (!parsed) throw new Error("The agreements answer is invalid. Refresh and try again.");
  return parsed;
}

/** VAY-2246: the hotel account's terms and data processing agreement, for Booking Admin and the PMS. */
export function createHotelAccountAgreementsClient(http: Http) {
  return {
    async load(options?: RequestInit): Promise<HotelAccountAgreementsStatus> {
      return status(await http.get<unknown>(PATH, { ...options, cache: "no-store" }));
    },
    /** The account admin accepts exactly the versions the page showed. */
    async accept(accepted: HotelAccountAgreementVersions): Promise<HotelAccountAgreementsStatus> {
      return status(await http.post<unknown>(`${PATH}/accept`, accepted));
    },
  };
}

export type HotelAccountAgreementsClient = ReturnType<typeof createHotelAccountAgreementsClient>;
