import type { QueryResultRow } from "pg";

import {
  ensureCanonicalPropertySlug,
  PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE,
} from "./publicBookabilityPublication.js";

type ProjectionClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

/**
 * Refreshes the canonical public property profile read model after a hotel-side write (profile,
 * logo, media, booking settings): reserves the canonical slug when the property has none yet,
 * then re-projects `hotel_catalog.property_public_profile_read_model`.
 *
 * Until VAY-2270 this ran inside the Marketplace offer projection; the offer part is gone.
 */
export async function projectPropertyPublicProfile(
  client: ProjectionClient,
  input: { propertyId: string },
): Promise<void> {
  if (!(await ensureCanonicalPropertySlug(client as never, input.propertyId))) return;
  await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [input.propertyId]);
}
