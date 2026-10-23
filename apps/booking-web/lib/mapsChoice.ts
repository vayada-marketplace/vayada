/** The guest's "Show map" (VAY-2216: Google loads only after the guest asks), remembered for this browser tab
 * only (VAY-2321 D2: sessionStorage, no cookie), so another map on the page or the next page loads at once. */
const KEY = "vayada.booking.showMap";

export function mapsChosen(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function chooseMaps(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // Private mode or storage blocked: the guest presses "Show map" again on the next map.
  }
}

/** The accommodations view the guest picked (VAY-2324), remembered for this browser tab only. */
export type AccommodationView = "list" | "split" | "map";
const VIEW_KEY = "vayada.booking.accommodationView";

export function chosenView(): AccommodationView | null {
  try {
    const view = sessionStorage.getItem(VIEW_KEY);
    return view === "list" || view === "split" || view === "map" ? view : null;
  } catch {
    return null;
  }
}

export function chooseView(view: AccommodationView): void {
  try {
    sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    // Storage blocked: the page opens on the default view next time.
  }
}
