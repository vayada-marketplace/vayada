import {
  linkBookingGuestNow,
  type GuestProfileQueryable,
} from "../jobs/bookingGuestProfileLinks.js";

/** VAY-2420: what a guest profile holds (migration 0527). */
export type GuestProfileFields = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  dateOfBirth: string | null;
  documentType: "passport" | "national_id" | "driving_licence" | "other" | null;
  documentNumber: string | null;
};

export type GuestProfileFieldName = keyof GuestProfileFields;

const PROFILE_COLUMNS: Record<GuestProfileFieldName, string> = {
  firstName: "first_name",
  lastName: "last_name",
  email: "email",
  phone: "phone",
  countryCode: "country_code",
  dateOfBirth: "date_of_birth",
  documentType: "document_type",
  documentNumber: "document_number",
};
// The fields each booking also keeps a copy of (booking.booking_guests).
const COPIED_FIELDS = ["firstName", "lastName", "email", "phone", "countryCode"] as const;

export const GUEST_PROFILE_SELECT = `profile.first_name AS "firstName",
  profile.last_name AS "lastName", profile.email, profile.phone,
  profile.country_code AS "countryCode",
  to_char(profile.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth",
  profile.document_type AS "documentType", profile.document_number AS "documentNumber"`;

/**
 * A staff edit of a guest profile: the fields given are set, and null clears one (unlike the copies
 * from bookings, which never clear). Names and contact also go to the booking copies of the guest's
 * current and upcoming stays at `propertyIds`, and of the stay it was edited from, so that stay's
 * emails use them; past stays keep what was booked. Returns the fields that changed, or null when
 * the profile doesn't exist. Runs in the caller's transaction.
 */
export async function editGuestProfile(
  client: GuestProfileQueryable,
  input: {
    guestProfileId: string;
    edit: Partial<GuestProfileFields>;
    propertyIds: readonly string[];
    bookingGuestId?: string;
  },
): Promise<GuestProfileFieldName[] | null> {
  const current = (
    await client.query<GuestProfileFields>(
      `SELECT ${GUEST_PROFILE_SELECT} FROM booking.guest_profiles profile
       WHERE profile.id = $1::uuid FOR UPDATE`,
      [input.guestProfileId],
    )
  ).rows[0];
  if (!current) return null;
  const changed = (Object.keys(PROFILE_COLUMNS) as GuestProfileFieldName[]).filter(
    (field) => input.edit[field] !== undefined && input.edit[field] !== current[field],
  );
  if (changed.length) {
    await client.query(
      `UPDATE booking.guest_profiles
       SET ${changed.map((field, index) => `${PROFILE_COLUMNS[field]} = $${index + 2}`).join(", ")},
           updated_at = now()
       WHERE id = $1::uuid`,
      [input.guestProfileId, ...changed.map((field) => input.edit[field])],
    );
  }
  const copy = async (fields: readonly GuestProfileFieldName[], stays: string) => {
    if (!fields.length) return;
    // A staff-chosen nationality settles any imported value that needed review.
    const review =
      fields.includes("countryCode") && input.edit.countryCode
        ? ", country_code_raw = NULL, country_code_review_required = FALSE"
        : "";
    await client.query(
      `UPDATE booking.booking_guests guest
       SET ${fields.map((field, index) => `${PROFILE_COLUMNS[field]} = $${index + 4}`).join(", ")}${review},
           updated_at = now(), guest_profile_synced_at = now()
       FROM booking.guest_bookings booking
       WHERE booking.id = guest.guest_booking_id
         AND guest.guest_profile_id = $1::uuid
         AND booking.property_id = ANY($2::uuid[])
         AND (${stays})`,
      [
        input.guestProfileId,
        input.propertyIds,
        input.bookingGuestId ?? null,
        ...fields.map((field) => input.edit[field]),
      ],
    );
  };
  await copy(
    COPIED_FIELDS.filter((field) => changed.includes(field)),
    `guest.id = $3::uuid OR (booking.check_out >= CURRENT_DATE
       AND booking.lifecycle_status IN ('pending_payment', 'confirmed'))`,
  );
  // The stay it was edited from also takes a value the profile already had: it can still show an
  // older one (a channel's relay address) that staff just replaced.
  if (input.bookingGuestId)
    await copy(
      COPIED_FIELDS.filter((field) => input.edit[field] !== undefined && !changed.includes(field)),
      "guest.id = $3::uuid",
    );
  return changed;
}

/**
 * A staff edit made on one booking guest (reservation page, check-in): links it to its profile now
 * and applies the edit there. Send only the fields staff changed, compared with what the form showed:
 * forms send every field, and an unchanged empty one must not clear the guest's details. False when
 * the guest has no profile (a draft booking). Runs in the caller's transaction, after
 * lockGuestProfiles.
 */
export async function editBookingGuestProfile(
  client: GuestProfileQueryable,
  input: { bookingGuestId: string; propertyId: string; edit: Partial<GuestProfileFields> },
): Promise<boolean> {
  const guestProfileId = await linkBookingGuestNow(client, input.bookingGuestId);
  if (!guestProfileId) return false;
  await editGuestProfile(client, {
    guestProfileId,
    edit: input.edit,
    propertyIds: [input.propertyId],
    bookingGuestId: input.bookingGuestId,
  });
  // The edited copy is now on the profile, so the linker doesn't apply it again.
  await client.query(
    "UPDATE booking.booking_guests SET guest_profile_synced_at = updated_at WHERE id = $1::uuid",
    [input.bookingGuestId],
  );
  return true;
}
