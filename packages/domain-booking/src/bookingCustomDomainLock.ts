/**
 * Advisory lock shared by every writer of a property's public booking hosts: the API's
 * custom-domain routes and the catalog migration. The namespace is historical (the retired
 * affiliate destination writes used the same lock); it stays so lock behaviour does not change.
 */
export const BOOKING_CUSTOM_DOMAIN_LOCK_NAMESPACE = "booking-affiliate-destination-safety" as const;

export const bookingCustomDomainLockKey = (propertyId: string): string =>
  `${BOOKING_CUSTOM_DOMAIN_LOCK_NAMESPACE}:${propertyId.toLowerCase()}`;
