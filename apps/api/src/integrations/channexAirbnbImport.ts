import { parsePreparedHotelImport, type PreparedHotelImport } from "@vayada/domain-hotels";

type Scope = { channelId: string; groupId: string; externalPropertyId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Internal only: caller must authorize the actor and resolve the scope server-side. */
export async function readChannexAirbnbImport(
  scope: Scope,
  options: { environment: "staging" | "production"; apiKey: string; fetcher?: typeof fetch },
): Promise<PreparedHotelImport> {
  if (
    [scope.channelId, scope.groupId, scope.externalPropertyId].some((id) => !uuid.test(id)) ||
    !options.apiKey
  )
    throw new Error("Invalid Airbnb import scope");
  const origin =
    options.environment === "staging"
      ? "https://staging.channex.io"
      : options.environment === "production"
        ? "https://app.channex.io"
        : null;
  if (!origin) throw new Error("Invalid Airbnb import environment");
  const fetcher = options.fetcher ?? fetch;
  async function get(path: string): Promise<unknown> {
    try {
      const response = await fetcher(`${origin}/api/v1${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "user-api-key": options.apiKey, Accept: "application/json" },
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 262_144) throw new Error();
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } catch {
      throw new Error("Airbnb listing source could not be read");
    }
  }
  const channel = object(object(await get(`/channels/${scope.channelId}`)).data);
  const attributes = object(channel.attributes);
  const group = object(object(object(channel.relationships).group).data);
  if (
    channel.id !== scope.channelId ||
    group.id !== scope.groupId ||
    typeof attributes.channel !== "string" ||
    attributes.channel.toLowerCase() !== "airbnb" ||
    !Array.isArray(attributes.properties) ||
    attributes.properties.length !== 1 ||
    attributes.properties[0] !== scope.externalPropertyId
  )
    throw new Error("Airbnb channel does not match the import scope");
  const payload = await get(`/channels/${scope.channelId}/action/listings`);
  return normalizeChannexAirbnbListings(payload);
}

export function normalizeChannexAirbnbListings(value: unknown): PreparedHotelImport {
  const values = object(object(object(value).data).listing_id_dictionary).values;
  if (!Array.isArray(values) || values.length > 50) throw new Error("Invalid Airbnb listings");
  const rooms = values.map((value) => {
    const listing = object(value);
    if (typeof listing.id !== "string" || !/^[A-Za-z0-9_-]{1,46}$/.test(listing.id))
      throw new Error("Invalid Airbnb listing identity");
    const counts = listing.occupancies;
    const capacity =
      Array.isArray(counts) &&
      counts.length > 0 &&
      counts.length <= 100 &&
      new Set(counts).size === counts.length &&
      counts.every((count) => Number.isInteger(count) && count >= 1 && count <= counts.length)
        ? counts.length
        : null;
    return {
      id: `abb_${listing.id}`,
      name: listing.title,
      description: "",
      maxGuests: capacity,
      maxAdults: null,
      maxChildren: null,
      bedType: "",
      bedQuantity: null,
      bathroomType: "",
      sizeSquareMetres: null,
    };
  });
  const result = parsePreparedHotelImport({
    contractVersion: "prepared-hotel-import.v1",
    property: {},
    rooms,
  });
  if (!result) throw new Error("Invalid Airbnb listings");
  return result;
}
