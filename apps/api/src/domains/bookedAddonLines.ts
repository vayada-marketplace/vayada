/** VAY-2408: a booking's add-on lines as the PMS reads them (one per night or day, VAY-2391), as a JSON array, in
 * checkout's order (the catalogue's, by id; one booking writes its lines at once). A per-guest extra counts its
 * guests, as checkout showed it. `booking` is the outer query's alias for the guest_bookings row. The booking lookup
 * and the booking emails read them (VAY-2428). */
export function bookedAddonLinesSql(booking: string): string {
  return `(SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'addonId', item.addon_key,
              'name', item.addon_name,
              'quantity', CASE
                WHEN jsonb_typeof(active_selection.addon_snapshot->'selection'->'people') = 'array'
                  AND jsonb_array_length(active_selection.addon_snapshot->'selection'->'people') > 0
                  THEN jsonb_array_length(active_selection.addon_snapshot->'selection'->'people')
                ELSE item.quantity END,
              'serviceDates', item.service_dates
            ) ORDER BY item.created_at, active_selection.addon_definition_id, item.selection_id,
              item.item_ordinality), '[]'::jsonb)
     FROM booking.booking_addon_selection_items item
     JOIN booking.active_booking_addon_selections active_selection
       ON active_selection.id = item.selection_id
      AND active_selection.property_id = item.property_id
      AND active_selection.guest_booking_id = item.guest_booking_id
     WHERE item.guest_booking_id = ${booking}.id
       AND item.property_id = ${booking}.property_id)`;
}

export type BookedAddonGroup = { addonId: string; name: string; quantity: number; dates: string[] };

/** The lines grouped per extra, as checkout lists them and the PMS shows them (VAY-2391): a per-night extra is one
 * line per night, listed once with its days. Its nights carry the same quantity; lines that differ (older bookings)
 * add up. Lines without an id, a name or a whole quantity are left out. */
export function groupBookedAddonLines(lines: unknown): BookedAddonGroup[] {
  const groups = new Map<string, { name: string; quantities: number[]; dates: Set<string> }>();
  for (const value of Array.isArray(lines) ? lines : []) {
    const line = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const addonId = text(line["addonId"]);
    const name = text(line["name"]);
    const quantity = Number(line["quantity"]);
    if (!addonId || !name || !Number.isInteger(quantity) || quantity < 1) continue;
    const dates = Array.isArray(line["serviceDates"])
      ? line["serviceDates"].filter((date): date is string => !!text(date))
      : [];
    const group = groups.get(addonId);
    if (group) {
      group.quantities.push(quantity);
      dates.forEach((date) => group.dates.add(date));
    } else groups.set(addonId, { name, quantities: [quantity], dates: new Set(dates) });
  }
  return Array.from(groups, ([addonId, { name, quantities, dates }]) => ({
    addonId,
    name,
    quantity: quantities.every((quantity) => quantity === quantities[0])
      ? quantities[0]!
      : quantities.reduce((sum, quantity) => sum + quantity, 0),
    dates: Array.from(dates).sort(),
  }));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
