/**
 * VAY-2493: the account admin deletes one of the account's properties from the PMS (Manage Properties).
 * Deleting retires the property: it leaves the property switchers and its booking page goes offline, while
 * its bookings, payments and history stay. Vayada staff can bring it back. It never hard-deletes.
 */
export const HOTEL_PROPERTY_DELETION_CONTRACT_VERSION = "hotel-property-deletion.v1" as const;

export type HotelPropertyDeletionBlockerCode =
  /** The account would be left without a property. */
  | "last_property"
  /** Bookings that are paid or awaiting payment and whose stay has not ended. */
  | "upcoming_bookings"
  /** A connected channel manager (Booking.com, Airbnb, …). */
  | "connected_channels"
  /** Payments that are pending, need action, are authorized or disputed, and pending card refunds. */
  | "unresolved_payments"
  /** Payouts not finished yet, including vayada Payment money still owed to the property. */
  | "open_payouts"
  /** The property also belongs to another account: Vayada support deletes it. */
  | "shared_property";

export type HotelPropertyDeletionBlocker = {
  code: HotelPropertyDeletionBlockerCode;
  count: number;
};

export type HotelPropertyDeletionCheck = {
  contractVersion: typeof HOTEL_PROPERTY_DELETION_CONTRACT_VERSION;
  propertyId: string;
  displayName: string;
  /** Sent back with the delete, so a property that changed meanwhile is checked again. */
  lifecycleRevision: number;
  /** Properties of the account that are not deleted, this one included. */
  accountProperties: number;
  blockers: HotelPropertyDeletionBlocker[];
  canDelete: boolean;
};

export type HotelPropertyDeletionRequest = {
  expectedLifecycleRevision: number;
  /** The property name as the admin typed it in the second confirmation step. */
  confirmationName: string;
};

export type HotelPropertyDeletionResult = {
  contractVersion: typeof HOTEL_PROPERTY_DELETION_CONTRACT_VERSION;
  propertyId: string;
  deleted: true;
};

/** The typed name matches when it equals the property name, ignoring only spaces at either end. */
export function propertyDeletionNameMatches(typed: string, displayName: string): boolean {
  const name = displayName.trim();
  return name.length > 0 && typed.trim() === name;
}
