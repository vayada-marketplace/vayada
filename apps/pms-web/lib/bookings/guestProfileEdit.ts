import type { Booking, GuestProfileEdit } from "@/services/bookings";

type NameAndContact = { firstName: string; lastName: string; email: string; phone: string };
type Booker = Pick<Booking, "guestFirstName" | "guestLastName" | "guestEmail" | "guestPhone">;

/** What staff changed in a guest's name and contact, compared with what the form showed
 * (VAY-2420): only that goes to the guest record, so an untouched field never overwrites newer
 * details there. An emptied email or phone clears it; names can't be emptied. */
export function guestProfileEdit(shown: NameAndContact, current: NameAndContact): GuestProfileEdit {
  const edit: GuestProfileEdit = {};
  const changed = (field: keyof NameAndContact) => shown[field].trim() !== current[field].trim();
  for (const field of ["firstName", "lastName"] as const)
    if (changed(field)) edit[field] = current[field].trim();
  for (const field of ["email", "phone"] as const)
    if (changed(field)) edit[field] = current[field].trim() || null;
  return edit;
}

/** The booking after its booker was edited: the edit also went to this booking's copy. */
export function withBookerEdit<T extends Booker>(booking: T, edit: GuestProfileEdit): T {
  return {
    ...booking,
    guestFirstName: edit.firstName ?? booking.guestFirstName,
    guestLastName: edit.lastName ?? booking.guestLastName,
    guestEmail: edit.email === undefined ? booking.guestEmail : (edit.email ?? ""),
    guestPhone: edit.phone === undefined ? booking.guestPhone : (edit.phone ?? ""),
  };
}
