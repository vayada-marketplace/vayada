"use client";

import { useEffect, useRef, useState } from "react";
import { importGoogleMapsLibrary } from "./googleMaps";
import type { Translate } from "./nearbyPlacesMessages";

type GooglePlace = {
  location?: { lat: () => number; lng: () => number };
  fetchFields: (input: { fields: string[] }) => Promise<void>;
};
type GooglePlaceSelectEvent = Event & { placePrediction: { toPlace: () => GooglePlace } };
type GooglePlacesLibrary = {
  PlaceAutocompleteElement: new (options: {
    description: string;
    placeholder: string;
  }) => HTMLElement;
};

/** "Find the area" (VAY-2326): Google's search only moves the map. Google's names and pins never become the
 * host's place (our nearby contract and Google's terms); the host drops the pin and types the name. */
export default function NearbyAreaSearch({
  apiKey,
  t,
  onLocate,
}: {
  apiKey: string;
  t: Translate;
  onLocate: (position: { latitude: number; longitude: number }) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const onLocateRef = useRef(onLocate);
  useEffect(() => {
    onLocateRef.current = onLocate;
  });
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let search: HTMLElement | null = null;
    let latest = 0;
    const unavailable = () => {
      if (disposed) return;
      element.replaceChildren();
      setStatus("unavailable");
    };
    const select = async (event: Event) => {
      const selection = ++latest;
      try {
        const place = (event as GooglePlaceSelectEvent).placePrediction.toPlace();
        await place.fetchFields({ fields: ["location"] });
        if (!disposed && selection === latest && place.location)
          onLocateRef.current({
            latitude: place.location.lat(),
            longitude: place.location.lng(),
          });
      } catch {
        if (selection === latest) unavailable();
      }
    };
    void importGoogleMapsLibrary<GooglePlacesLibrary>(apiKey, "places")
      .then(({ PlaceAutocompleteElement }) => {
        if (disposed) return;
        search = new PlaceAutocompleteElement({
          description: t("nearbyPlaces.form.findArea"),
          placeholder: t("nearbyPlaces.form.findArea"),
        });
        search.className = "vayada-nearby-area-search";
        search.addEventListener("gmp-select", select);
        search.addEventListener("gmp-error", unavailable);
        element.replaceChildren(search);
        setStatus("ready");
      })
      .catch(unavailable);
    return () => {
      disposed = true;
      latest += 1;
      search?.removeEventListener("gmp-select", select);
      search?.removeEventListener("gmp-error", unavailable);
      element.replaceChildren();
    };
    // t is the page's translator; the search is made once per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  return (
    <div>
      <p className="mb-1.5 text-sm font-semibold text-gray-900">
        {t("nearbyPlaces.form.findArea")}
      </p>
      {status === "loading" && (
        <div className="h-11 animate-pulse rounded-lg border border-gray-200 bg-gray-50" />
      )}
      <div ref={container} className={status === "ready" ? undefined : "hidden"} />
      <p className="mt-1.5 text-xs text-gray-500">
        {status === "unavailable"
          ? t("nearbyPlaces.form.findAreaUnavailable")
          : t("nearbyPlaces.form.findAreaHint")}
      </p>
      <style>{`
        .vayada-nearby-area-search {
          display: block;
          width: 100%;
          box-sizing: border-box;
          color-scheme: light;
          border: 1px solid rgb(229 231 235);
          border-radius: 0.5rem;
          background: white;
          font: inherit;
        }
        .vayada-nearby-area-search::part(input) {
          width: 100%;
          box-sizing: border-box;
          min-height: 2.75rem;
          padding: 0.625rem 0.75rem;
          font-size: 0.875rem;
        }
        .vayada-nearby-area-search:focus-within {
          border-color: rgb(47 82 245);
          box-shadow: 0 0 0 2px rgb(223 229 255);
        }
      `}</style>
    </div>
  );
}
