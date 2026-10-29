/** The guest form's fields by where they are saved: the booking's guest list, or the staff-only
 * registration (VAY-2373 D1). */
const CONTACT_FIELDS = ["firstName", "lastName", "email", "phone", "nationality"] as const;
const REGISTRATION_FIELDS = [
  "assignmentId",
  "dateOfBirth",
  "documentType",
  "documentNumber",
  "gender",
  "staffNotes",
] as const;

export type GuestContactField = (typeof CONTACT_FIELDS)[number];
type GuestValues = Record<GuestContactField | (typeof REGISTRATION_FIELDS)[number], string | null>;

/** What changed since the last save, so an autosave sends only that (VAY-2418): the contact fields
 * for the guest list, and whether the registration needs saving. Edits to blanks don't count. */
export function guestChanges(
  saved: GuestValues,
  current: GuestValues,
): { contact: GuestContactField[]; registration: boolean } {
  const same = (field: keyof GuestValues) =>
    (saved[field] ?? "").trim() === (current[field] ?? "").trim();
  return {
    contact: CONTACT_FIELDS.filter((field) => !same(field)),
    registration: REGISTRATION_FIELDS.some((field) => !same(field)),
  };
}
