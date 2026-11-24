import {
  getStoredPmsPropertyId,
  listPmsProperties,
  storeSelectedPmsPropertyId,
} from "@/services/api/pmsPropertyClient";

/** VAY-2099: the query parameter that names the hotel a PMS link belongs to, as in the booking
 * request email's `/bookings/<id>?property=<property id>`. */
export const LINKED_PROPERTY_PARAM = "property";

// Only a base for parsing relative paths.
const PATH_BASE = "https://pms.vayada.local";

type LinkedPropertyDeps = {
  stored: () => string | null;
  list: () => Promise<{ id: string }[]>;
  store: (propertyId: string) => void;
};

const browserDeps: LinkedPropertyDeps = {
  stored: getStoredPmsPropertyId,
  list: listPmsProperties,
  store: storeSelectedPmsPropertyId,
};

/**
 * Chooses the hotel a link names, before anything reads the chosen hotel. Without it, a login with
 * several hotels opens the link under the hotel it chose last, where the booking isn't found, or on
 * the hotel picker when it hasn't chosen one. Only a hotel the login has is chosen; any other value
 * keeps the current choice.
 */
export async function chooseLinkedPmsProperty(
  path: string,
  deps: LinkedPropertyDeps = browserDeps,
): Promise<void> {
  const propertyId = linkedPmsPropertyId(path);
  if (!propertyId || deps.stored() === propertyId) return;
  try {
    const properties = await deps.list();
    if (properties.some((property) => property.id === propertyId)) deps.store(propertyId);
  } catch (error) {
    // The page still opens under the current hotel, as it did before links named one.
    console.warn("Could not open the hotel the link names:", error);
  }
}

export function linkedPmsPropertyId(path: string): string | null {
  try {
    return new URL(path, PATH_BASE).searchParams.get(LINKED_PROPERTY_PARAM)?.trim() || null;
  } catch {
    return null;
  }
}

/** The same path without the link's hotel, so a reload or Back after switching hotels doesn't
 * switch back. */
export function withoutLinkedPmsProperty(path: string): string {
  const url = new URL(path, PATH_BASE);
  url.searchParams.delete(LINKED_PROPERTY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
