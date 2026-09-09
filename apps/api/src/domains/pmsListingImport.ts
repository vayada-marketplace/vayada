import { z } from "zod";

export type ListingSource = {
  provider: "airbnb" | "booking";
  url: string;
  stay?: { checkIn: string; checkOut: string };
};
export type ImportedRoom = { name: string; description?: string; maxGuests?: number };
export type ListingImportResult =
  | { ok: true; source: ListingSource; rooms: ImportedRoom[]; warnings: string[] }
  | {
      ok: false;
      code:
        | "unsupported_url"
        | "stay_dates_required"
        | "not_configured"
        | "provider_failed"
        | "timeout"
        | "no_room_details";
      message: string;
    };

const actors = {
  airbnb: "tri_angle~airbnb-rooms-urls-scraper",
  booking: "voyager~booking-scraper",
};
const fail = (
  code: Extract<ListingImportResult, { ok: false }>["code"],
  message: string,
): ListingImportResult => ({ ok: false, code, message });

export function parseListingSource(input: unknown): ListingSource | null {
  if (typeof input !== "string" || input.length > 2048 || /[\\\s]/.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.replace(/^www\./, "");
  if (host === "airbnb.com" && /^\/rooms\/[1-9][0-9]{0,24}\/?$/.test(url.pathname)) {
    return { provider: "airbnb", url: `https://www.airbnb.com${url.pathname.replace(/\/$/, "")}` };
  }
  if (
    host === "booking.com" &&
    /^\/hotel\/[a-z]{2}\/[a-z0-9][a-z0-9._-]*\.html$/.test(url.pathname)
  ) {
    const checkIn = url.searchParams.get("checkin");
    const checkOut = url.searchParams.get("checkout");
    if (checkIn !== null || checkOut !== null) {
      if (
        !validDate(checkIn) ||
        !validDate(checkOut) ||
        checkOut <= checkIn ||
        url.searchParams.getAll("checkin").length !== 1 ||
        url.searchParams.getAll("checkout").length !== 1
      )
        return null;
      return {
        provider: "booking",
        url: `https://www.booking.com${url.pathname}`,
        stay: { checkIn, checkOut },
      };
    }
    return { provider: "booking", url: `https://www.booking.com${url.pathname}` };
  }
  return null;
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const nameSchema = z.string().trim().min(1).max(200);
const textSchema = z.string().trim().min(1).max(5000);
const capacitySchema = z.number().int().min(1).max(100);
const rowSchema = z.object({ url: z.string() }).passthrough();

export function normalizeListingOutput(
  source: ListingSource,
  payload: unknown,
): ListingImportResult {
  const dataset = z.array(rowSchema).max(1).safeParse(payload);
  const row = dataset.success ? dataset.data[0] : undefined;
  if (!row || parseListingSource(row.url)?.url !== source.url) {
    return fail(
      "no_room_details",
      "The listing could not be read or returned unrelated data. Try manual entry.",
    );
  }
  const rooms: ImportedRoom[] = [];
  if (source.provider === "airbnb") {
    const name = nameSchema.safeParse(row["title"]);
    if (name.success) {
      const description = textSchema.safeParse(row["description"]);
      const guests = capacitySchema.safeParse(row["personCapacity"]);
      rooms.push({
        name: name.data,
        ...(description.success ? { description: description.data } : {}),
        ...(guests.success ? { maxGuests: guests.data } : {}),
      });
    }
  } else {
    const offers = z
      .array(z.object({ roomType: z.unknown() }))
      .max(1000)
      .safeParse(row["rooms"]);
    if (offers.success) {
      for (const offer of offers.data) {
        const name = nameSchema.safeParse(offer.roomType);
        if (name.success && !rooms.some((room) => room.name === name.data))
          rooms.push({ name: name.data });
      }
    }
  }
  return rooms.length
    ? {
        ok: true,
        source,
        rooms,
        warnings: ["Imported details may be incomplete. Review all room fields before saving."],
      }
    : fail(
        "no_room_details",
        "No usable room details were returned. The page may be blocked or require stay dates. Use manual entry.",
      );
}

/** Server-only adapter. Route composition must authorize the property before calling it. */
export function createApifyListingImporter(config: { token?: string; fetch?: typeof fetch }) {
  const fetcher = config.fetch ?? fetch;
  return async (input: unknown): Promise<ListingImportResult> => {
    const source = parseListingSource(input);
    if (!source)
      return fail(
        "unsupported_url",
        "Paste a direct Airbnb.com room or Booking.com hotel HTTPS link. Any stay dates must be valid and check-out must follow check-in.",
      );
    if (source.provider === "booking" && !source.stay)
      return fail(
        "stay_dates_required",
        "Choose check-in and check-out dates on Booking.com, then paste that hotel link. Dates are needed to read room offers; nothing will be booked.",
      );
    if (!config.token?.trim())
      return fail(
        "not_configured",
        "Listing import is not configured. You can enter the room manually.",
      );
    const signal = AbortSignal.timeout(65_000);
    try {
      const response = await fetcher(
        `https://api.apify.com/v2/actors/${actors[source.provider]}/run-sync-get-dataset-items?timeout=60&maxItems=1&maxTotalChargeUsd=0.05&restartOnError=false&format=json`,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            startUrls: [{ url: source.url }],
            ...(source.provider === "booking" ? { maxItems: 1, ...source.stay } : {}),
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return response.status === 408
          ? fail("timeout", "The listing took too long to load. Try manual entry.")
          : fail(
              "provider_failed",
              "The listing provider is unavailable. Try again later or enter the room manually.",
            );
      }
      const reader = response.body?.getReader();
      if (!reader) return fail("no_room_details", "No listing data was returned.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) {
            await reader.cancel();
            return fail("no_room_details", "The listing returned too much data. Use manual entry.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return normalizeListingOutput(source, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      return signal.aborted
        ? fail("timeout", "The listing took too long to load. Try manual entry.")
        : fail(
            "provider_failed",
            "The listing could not be read. Try again later or enter the room manually.",
          );
    }
  };
}
