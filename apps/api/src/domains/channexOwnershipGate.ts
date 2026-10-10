/**
 * VAY-2108: the per-hotel Channex ownership gate (engineering/channex-per-hotel-ownership.md).
 * The target owns a hotel's Channex property only through an active binding claim on the same
 * external id as its connected (or degraded) connection. Outside staging Channex it never owns
 * the staging and test identities that migration 0432 reserves.
 */
export const CHANNEX_RESERVED_TEST_IDS: readonly string[] = Object.freeze([
  "17621565-40b5-4ebc-8727-3a301ac947a2",
  "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
  "65f6b2fc-c783-4963-9d6b-a85f82319769",
  "8f4c1e47-3de1-4150-8bde-ad031a013842",
]);

/** Property or Channex ids the runtime must not treat as owned; fail closed unless staging. */
export function channexExcludedIds(apiBaseUrl: string | undefined): readonly string[] {
  return apiBaseUrl === "https://staging.channex.io" ? [] : CHANNEX_RESERVED_TEST_IDS;
}
