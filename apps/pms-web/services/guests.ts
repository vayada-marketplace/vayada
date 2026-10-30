import { pmsOperationsClient, pmsOperationsRequestOptions } from "./api/pmsOperationsClient";
import { propertyEndpoint, resolveSelectedPmsPropertyId } from "./api/pmsPropertyClient";

/** VAY-2420: a guest record of the account, as search and the Guests list show it. */
export interface GuestSummary {
  guestProfileId: string;
  firstName: string;
  lastName: string;
  /** Null when hidden ("Hidden until you accept", or no guest contact access). */
  email: string | null;
  phone: string | null;
  /** Reservations at the properties this user may open. */
  reservations: number;
  /** The latest arrival, past or upcoming, of a booking that wasn't cancelled. */
  lastCheckIn: string | null;
}

export type GuestDocumentType = "passport" | "national_id" | "driving_licence" | "other";

export interface GuestFields {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  dateOfBirth: string | null;
  documentType: GuestDocumentType | null;
  documentNumber: string | null;
}

export interface GuestStay {
  bookingGuestId: string;
  guestBookingId: string;
  propertyId: string;
  propertyName: string;
  bookingReference: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: string[];
  status: string;
  channel: string;
  directSource: string | null;
  role: "booker" | "primary_guest" | "additional_guest";
  totalAmount: string;
  currency: string;
}

export interface GuestNote {
  noteId: string;
  body: string;
  propertyId: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface GuestProfile extends GuestSummary {
  fields: GuestFields;
  /** False without guest contact access: email, phone and ID details stay hidden. */
  canReadContact: boolean;
  /** Email and phone wait until a request is accepted ("Hidden until you accept"). */
  contactHidden: boolean;
  nextArrival: string | null;
  guestSince: string;
  /** Newest first, at the properties this user may open. */
  stays: GuestStay[];
  notes: GuestNote[];
}

const guestPath = async (suffix: string, action: string) =>
  propertyEndpoint(await resolveSelectedPmsPropertyId(action), suffix);

export const guestsService = {
  search: async (search: string, limit = 20) =>
    (
      await pmsOperationsClient.get<{ guests: GuestSummary[] }>(
        `${await guestPath("guests", "searching guests")}?${new URLSearchParams({
          ...(search.trim() ? { search: search.trim() } : {}),
          limit: String(limit),
        })}`,
        pmsOperationsRequestOptions,
      )
    ).guests,

  get: async (guestProfileId: string) =>
    pmsOperationsClient.get<GuestProfile>(
      await guestPath(`guests/${encodeURIComponent(guestProfileId)}`, "loading a guest"),
      pmsOperationsRequestOptions,
    ),

  /** Send only the fields staff changed; null clears one (names can't be cleared). */
  edit: async (guestProfileId: string, edit: Partial<GuestFields>) =>
    pmsOperationsClient.patch<GuestProfile>(
      await guestPath(`guests/${encodeURIComponent(guestProfileId)}`, "editing a guest"),
      edit,
      pmsOperationsRequestOptions,
    ),

  /** Moves the other guest's stays and notes into this one. */
  merge: async (guestProfileId: string, otherGuestProfileId: string) =>
    pmsOperationsClient.post<GuestProfile>(
      await guestPath(`guests/${encodeURIComponent(guestProfileId)}/merge`, "merging guests"),
      { guestProfileId: otherGuestProfileId },
      pmsOperationsRequestOptions,
    ),

  /** A staff-only note on the guest record, shown on every reservation of the guest. */
  addNote: async (guestProfileId: string, body: string) =>
    pmsOperationsClient.post<GuestNote>(
      await guestPath(`guests/${encodeURIComponent(guestProfileId)}/notes`, "adding a guest note"),
      { body },
      pmsOperationsRequestOptions,
    ),

  deleteNote: async (guestProfileId: string, noteId: string) =>
    pmsOperationsClient.delete<unknown>(
      await guestPath(
        `guests/${encodeURIComponent(guestProfileId)}/notes/${encodeURIComponent(noteId)}`,
        "deleting a guest note",
      ),
      pmsOperationsRequestOptions,
    ),

  /** Gives one stay its own new guest record. */
  separate: async (guestProfileId: string, bookingGuestId: string) =>
    pmsOperationsClient.post<{ guestProfileId: string }>(
      await guestPath(`guests/${encodeURIComponent(guestProfileId)}/separate`, "separating a stay"),
      { bookingGuestId },
      pmsOperationsRequestOptions,
    ),
};

/** VAY-2420: Settings › Guest data, one per account (the API's GuestDataSettings). */
export type GuestDataField =
  | "email"
  | "phone"
  | "nationality"
  | "dateOfBirth"
  | "documentType"
  | "documentNumber";
export type GuestFieldStatus = "off" | "optional" | "required";
export interface GuestDataSettings {
  /** First and last name are always required, so they aren't listed; email can't be off. */
  fields: Record<GuestDataField, GuestFieldStatus>;
  /** A new booking joins a guest with the same name and the same email or phone. */
  matching: { email: boolean; phone: boolean };
  /** Days after check-out until document type and number are removed; null keeps them. */
  identityRetentionDays: 7 | 30 | 90 | null;
}

export const guestDataSettingsService = {
  get: async () =>
    pmsOperationsClient.get<{ settings: GuestDataSettings; canManage: boolean }>(
      await guestPath("guest-data-settings", "loading guest data settings"),
      pmsOperationsRequestOptions,
    ),

  /** Only the owner may change them (D9). */
  save: async (settings: GuestDataSettings) =>
    pmsOperationsClient.put<{ settings: GuestDataSettings; canManage: boolean }>(
      await guestPath("guest-data-settings", "saving guest data settings"),
      settings,
      pmsOperationsRequestOptions,
    ),
};
