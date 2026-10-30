import type { QueryResultRow } from "pg";

/**
 * VAY-2420: Settings › Guest data, one per account (migration 0528). Which guest fields are collected
 * (off, optional, required), which details join a new booking to an existing guest profile, and how
 * long ID documents are kept after check-out.
 *
 * Stored as one JSON object per account; a key it doesn't hold, or holds in an old shape, falls back
 * to the default, so a new setting needs no migration. The defaults are what check-in asked for
 * before these settings existed, so nothing changes until an owner changes something.
 */

export const GUEST_DATA_FIELDS = [
  "email",
  "phone",
  "nationality",
  "dateOfBirth",
  "documentType",
  "documentNumber",
] as const;
export type GuestDataField = (typeof GUEST_DATA_FIELDS)[number];
export type GuestFieldStatus = "off" | "optional" | "required";
export const GUEST_IDENTITY_RETENTION_DAYS = [7, 30, 90] as const;

export type GuestDataSettings = {
  /** First and last name are always required, so they aren't listed. */
  fields: Record<GuestDataField, GuestFieldStatus>;
  /** A new booking joins a profile with the same name and one of these (D2: never without the name). */
  matching: { email: boolean; phone: boolean };
  /** Days after check-out until document type and number are removed; null keeps them. */
  identityRetentionDays: (typeof GUEST_IDENTITY_RETENTION_DAYS)[number] | null;
};

export const DEFAULT_GUEST_DATA_SETTINGS: GuestDataSettings = {
  fields: {
    email: "optional",
    phone: "optional",
    nationality: "required",
    dateOfBirth: "required",
    documentType: "required",
    documentNumber: "required",
  },
  matching: { email: true, phone: true },
  identityRetentionDays: null,
};

const STATUSES: readonly GuestFieldStatus[] = ["off", "optional", "required"];

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validStatus = (field: GuestDataField, value: unknown): value is GuestFieldStatus =>
  STATUSES.includes(value as GuestFieldStatus) && !(field === "email" && value === "off");

const validRetention = (value: unknown): value is GuestDataSettings["identityRetentionDays"] =>
  value === null || GUEST_IDENTITY_RETENTION_DAYS.includes(value as 7);

/** The stored object over the defaults; anything not valid keeps its default. */
export function guestDataSettingsFrom(stored: unknown): GuestDataSettings {
  const raw = isRecord(stored) ? stored : {};
  const fields = isRecord(raw.fields) ? raw.fields : {};
  const matching = isRecord(raw.matching) ? raw.matching : {};
  const defaults = DEFAULT_GUEST_DATA_SETTINGS;
  return {
    fields: Object.fromEntries(
      GUEST_DATA_FIELDS.map((field) => [
        field,
        validStatus(field, fields[field]) ? fields[field] : defaults.fields[field],
      ]),
    ) as GuestDataSettings["fields"],
    matching: {
      email: typeof matching.email === "boolean" ? matching.email : defaults.matching.email,
      phone: typeof matching.phone === "boolean" ? matching.phone : defaults.matching.phone,
    },
    identityRetentionDays: validRetention(raw.identityRetentionDays)
      ? raw.identityRetentionDays
      : defaults.identityRetentionDays,
  };
}

/**
 * A whole settings object from the settings page, or why it can't be saved. Keys this version
 * doesn't know are ignored, so a newer page keeps working while the API is rolled out.
 */
export function parseGuestDataSettings(raw: unknown): GuestDataSettings | string {
  if (!isRecord(raw) || !("identityRetentionDays" in raw))
    return "Send fields, matching and identityRetentionDays.";
  const { fields, matching } = raw;
  if (!isRecord(fields) || GUEST_DATA_FIELDS.some((field) => !validStatus(field, fields[field])))
    return "fields must give each guest field off, optional or required; email can't be off.";
  if (
    !isRecord(matching) ||
    typeof matching.email !== "boolean" ||
    typeof matching.phone !== "boolean"
  )
    return "matching must give email and phone as true or false.";
  if (!validRetention(raw.identityRetentionDays))
    return "identityRetentionDays must be 7, 30, 90 or null.";
  return guestDataSettingsFrom(raw);
}

export async function readGuestDataSettings(
  client: Queryable,
  accountId: string,
): Promise<GuestDataSettings> {
  const row = (
    await client.query<{ settings: unknown }>(
      "SELECT settings FROM booking.guest_data_settings WHERE account_id = $1::uuid",
      [accountId],
    )
  ).rows[0];
  return guestDataSettingsFrom(row?.settings);
}
