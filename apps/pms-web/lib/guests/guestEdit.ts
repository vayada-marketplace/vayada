import { birthDateText, parseBirthDate } from "@/lib/checkin/birthDate";
import type { GuestDocumentType, GuestFields } from "@/services/guests";

/** The guest profile's edit form: every field as typed (date of birth as "DD / MM / YYYY"). */
export type GuestForm = Record<keyof GuestFields, string>;

export function guestForm(fields: GuestFields): GuestForm {
  return {
    firstName: fields.firstName,
    lastName: fields.lastName,
    email: fields.email ?? "",
    phone: fields.phone ?? "",
    countryCode: fields.countryCode ?? "",
    dateOfBirth: fields.dateOfBirth ? birthDateText(fields.dateOfBirth) : "",
    documentType: fields.documentType ?? "",
    documentNumber: fields.documentNumber ?? "",
  };
}

/**
 * What staff changed (VAY-2420): only those fields go to the guest record, so a field nobody touched
 * never overwrites a newer value. An emptied optional field is sent as null (cleared); a date of
 * birth that isn't a real date makes the whole edit invalid.
 */
export function guestFormChanges(
  shown: GuestForm,
  form: GuestForm,
  today: string,
): Partial<GuestFields> | "invalid_birth_date" {
  const changes: Partial<GuestFields> = {};
  for (const key of Object.keys(form) as (keyof GuestFields)[]) {
    const value = form[key].trim();
    if (value === shown[key].trim()) continue;
    if (key === "firstName" || key === "lastName") changes[key] = value;
    else if (key === "dateOfBirth") {
      const iso = parseBirthDate(value, today);
      if (iso === null) return "invalid_birth_date";
      changes.dateOfBirth = iso || null;
    } else if (key === "documentType")
      changes.documentType = (value || null) as GuestDocumentType | null;
    else changes[key] = value || null;
  }
  return changes;
}
