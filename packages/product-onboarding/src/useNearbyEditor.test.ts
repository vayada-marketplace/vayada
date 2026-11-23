import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type {
  NearbyCurationState,
  PropertyProfileLocation,
  PropertyProfileResponse,
} from "@vayada/domain-hotels";
import type { NearbyApi } from "./nearbyApi";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";
import { useNearbyEditor } from "./useNearbyEditor";

it("saves the host's places and categories, never the stored Google choices (VAY-2326)", async () => {
  const profile = {
    propertyId: "test",
    profileRevision: 1,
    profile: { location: {} },
  } as PropertyProfileResponse;
  const curation = {
    profileRevision: 1,
    savedProfileRevision: 1,
    curationRevision: 1,
    choices: [
      {
        placeId: "kept",
        category: "food",
        hidden: true,
        favorite: false,
        added: false,
        note: null,
      },
    ],
    customPlaces: [],
    customCategories: [],
    categoryNames: {},
  } as unknown as NearbyCurationState;
  const api = {
    read: vi.fn().mockResolvedValue(curation),
    save: vi.fn().mockResolvedValue({ ...curation, curationRevision: 2 }),
  } as unknown as NearbyApi;
  const profileApi = {
    getPropertyProfile: vi.fn().mockResolvedValue(profile),
  } as unknown as SharedHotelSetupApi;
  let editor!: ReturnType<typeof useNearbyEditor>;
  function Probe() {
    editor = useNearbyEditor("test", api, profileApi);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    expect(editor.placesDirty).toBe(false);
    act(() => {
      editor.setDraft(
        (current) => current && { ...current, categoryNames: { food: "Street food" } },
      );
    });
    expect(editor.placesDirty).toBe(true);
    await act(() => editor.savePlaces());
    expect(api.save).toHaveBeenCalledWith("test", {
      schemaVersion: 1,
      expectedProfileRevision: 1,
      expectedCurationRevision: 1,
      customPlaces: [],
      customCategories: [],
      categoryNames: { food: "Street food" },
    });
    expect(editor.notice).toBe("nearbyPlaces.notice.placesSaved");
    expect(editor.saved).toMatchObject({ curationRevision: 2, choices: curation.choices });
  } finally {
    act(() => renderer.unmount());
  }
});

it("takes the server's word on saved places after a location save (VAY-2104)", async () => {
  const at = (profileRevision: number, savedProfileRevision: number) =>
    ({
      profileRevision,
      savedProfileRevision,
      curationRevision: 1,
      choices: [],
      customPlaces: [],
    }) as unknown as NearbyCurationState;
  const profile = (profileRevision: number) =>
    ({ propertyId: "test", profileRevision, profile: { location: {} } }) as PropertyProfileResponse;
  const api = {
    read: vi
      .fn()
      .mockResolvedValueOnce(at(1, 1))
      .mockResolvedValueOnce(at(2, 2))
      .mockResolvedValueOnce(at(3, 2)),
  } as unknown as NearbyApi;
  const profileApi = {
    getPropertyProfile: vi.fn().mockResolvedValue(profile(1)),
    updatePropertyProfile: vi
      .fn()
      .mockResolvedValueOnce(profile(2))
      .mockResolvedValueOnce(profile(3)),
  } as unknown as SharedHotelSetupApi;
  let editor!: ReturnType<typeof useNearbyEditor>;
  function Probe() {
    editor = useNearbyEditor("test", api, profileApi);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    // Same pin: the server still counts the places as confirmed.
    await act(() => editor.saveLocation());
    expect(editor.saved).toMatchObject({ profileRevision: 2, savedProfileRevision: 2 });
    expect(editor.draft).toMatchObject({ profileRevision: 2, savedProfileRevision: 2 });
    expect(editor.notice).toBe("nearbyPlaces.notice.locationSaved");
    // Moved pin: the places need a look before they show again.
    await act(() => editor.saveLocation());
    expect(editor.saved).toMatchObject({ profileRevision: 3, savedProfileRevision: 2 });
    expect(editor.notice).toBe("nearbyPlaces.notice.locationSavedReview");
  } finally {
    act(() => renderer.unmount());
  }
});

// VAY-2586: Booking Admin › Settings › Location, a live hotel's time zone or country change.
const LOCATION: PropertyProfileLocation = {
  streetAddress: "Galle Road 1",
  postalCode: "00300",
  city: "Colombo",
  countryCode: "LK",
  timezone: "Asia/Colombo",
  latitude: 6.9,
  longitude: 79.85,
  localityPublic: true,
  geoPublic: true,
  mapDisplayMode: "exact",
};
const refusal = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(String(data["detail"])), { status, data });
const NEEDS_CONFIRMATION = refusal(409, {
  code: "location_change_needs_confirmation",
  detail: "This changes your live hotel's time zone from Asia/Colombo to Europe/London.",
  changes: { timezone: { from: "Asia/Colombo", to: "Europe/London" } },
});
const CHANNEX_MISMATCH = refusal(409, {
  code: "channex_time_zone_mismatch",
  detail:
    "This hotel is connected to Channex, which uses the time zone Asia/Colombo. Your hotel's time zone must be the same. Keep Asia/Colombo, or change it in Channex first.",
  channexTimeZone: "Asia/Colombo",
});
const CHANNEX_UNAVAILABLE = refusal(503, {
  code: "channex_time_zone_unavailable",
  detail:
    "We couldn't check your channel manager's time zone, so nothing was saved. Try again in a minute.",
});

async function locationEditor(...answers: (Error | "saved")[]) {
  const profile = (profileRevision: number, location = LOCATION) =>
    ({ propertyId: "test", profileRevision, profile: { location } }) as PropertyProfileResponse;
  const curation = {
    profileRevision: 1,
    savedProfileRevision: 1,
    curationRevision: 1,
    choices: [],
    customPlaces: [],
    customCategories: [],
    categoryNames: {},
  } as unknown as NearbyCurationState;
  const update = vi.fn();
  for (const answer of answers)
    if (answer === "saved")
      update.mockImplementationOnce(
        async (_id: string, request: { patch: { location: PropertyProfileLocation } }) =>
          profile(2, request.patch.location),
      );
    else update.mockRejectedValueOnce(answer);
  const api = {
    read: vi.fn().mockResolvedValue(curation),
  } as unknown as NearbyApi;
  const profileApi = {
    getPropertyProfile: vi.fn().mockResolvedValue(profile(1)),
    updatePropertyProfile: update,
  } as unknown as SharedHotelSetupApi;
  let editor!: ReturnType<typeof useNearbyEditor>;
  function Probe() {
    editor = useNearbyEditor("test", api, profileApi);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  return {
    get editor() {
      return editor;
    },
    update,
    unmount: () => act(() => renderer.unmount()),
  };
}

it("asks before a live hotel's time zone moves: Keep saves nothing, Change saves it confirmed (VAY-2586)", async () => {
  const shown = await locationEditor(NEEDS_CONFIRMATION, NEEDS_CONFIRMATION, "saved");
  try {
    act(() => shown.editor.setLocation({ ...LOCATION, timezone: "Europe/London" }));
    await act(() => shown.editor.saveLocation());
    expect(shown.update).toHaveBeenLastCalledWith("test", {
      expectedProfileRevision: 1,
      patch: { location: { ...LOCATION, timezone: "Europe/London" } },
    });
    // The question, not "Someone changed this property's settings".
    expect(shown.editor.locationChange).toEqual({
      timezone: { from: "Asia/Colombo", to: "Europe/London" },
    });
    expect(shown.editor.error).toBe("");
    expect(shown.editor.serverError).toBe("");
    expect(shown.editor.busy).toBe(false);

    // "Keep Asia/Colombo": nothing is saved, and the typed time zone stays to fix.
    act(() => shown.editor.keepLocation());
    expect(shown.editor.locationChange).toBeNull();
    expect(shown.update).toHaveBeenCalledTimes(1);
    expect(shown.editor.location?.timezone).toBe("Europe/London");
    expect(shown.editor.locationDirty).toBe(true);

    // Saving again asks again; "Change time zone" saves with the confirmation.
    await act(() => shown.editor.saveLocation());
    expect(shown.editor.locationChange).not.toBeNull();
    await act(() => shown.editor.saveLocation(true));
    expect(shown.update).toHaveBeenLastCalledWith("test", {
      expectedProfileRevision: 1,
      patch: { location: { ...LOCATION, timezone: "Europe/London" } },
      confirmLocationChange: true,
    });
    expect(shown.editor.locationChange).toBeNull();
    expect(shown.editor.locationDirty).toBe(false);
    expect(shown.editor.profile?.profile.location.timezone).toBe("Europe/London");
    expect(shown.editor.notice).toBe("nearbyPlaces.notice.locationSaved");
  } finally {
    shown.unmount();
  }
});

it("shows the server's own words when Channex refuses or can't be checked (VAY-2586)", async () => {
  const shown = await locationEditor(CHANNEX_MISMATCH, CHANNEX_UNAVAILABLE, "saved");
  try {
    act(() => shown.editor.setLocation({ ...LOCATION, timezone: "Asia/Kolkata" }));
    await act(() => shown.editor.saveLocation());
    expect(shown.editor.serverError).toBe(CHANNEX_MISMATCH.message);
    expect(shown.editor.error).toBe("");
    expect(shown.editor.locationChange).toBeNull();
    // A 503, not the generic save error.
    await act(() => shown.editor.saveLocation());
    expect(shown.editor.serverError).toBe(CHANNEX_UNAVAILABLE.message);
    expect(shown.editor.error).toBe("");
    // The edits stay; the next save clears the message.
    expect(shown.editor.location?.timezone).toBe("Asia/Kolkata");
    await act(() => shown.editor.saveLocation());
    expect(shown.editor.serverError).toBe("");
    expect(shown.editor.notice).toBe("nearbyPlaces.notice.locationSaved");
  } finally {
    shown.unmount();
  }
});

it("a confirmed change that Channex refuses closes the question and says why (VAY-2586)", async () => {
  const shown = await locationEditor(NEEDS_CONFIRMATION, CHANNEX_MISMATCH);
  try {
    act(() => shown.editor.setLocation({ ...LOCATION, timezone: "Europe/London" }));
    await act(() => shown.editor.saveLocation());
    await act(() => shown.editor.saveLocation(true));
    expect(shown.editor.locationChange).toBeNull();
    expect(shown.editor.serverError).toBe(CHANNEX_MISMATCH.message);
  } finally {
    shown.unmount();
  }
});

it("a street-only change, or a hotel guests can't book yet, saves as before (VAY-2586)", async () => {
  const shown = await locationEditor(
    "saved",
    "saved",
    refusal(409, { code: "profile_revision_conflict", detail: "The property profile changed." }),
  );
  try {
    act(() => shown.editor.setLocation({ ...LOCATION, streetAddress: "Galle Road 2" }));
    await act(() => shown.editor.saveLocation());
    // No confirmation is sent unasked.
    expect(shown.update).toHaveBeenLastCalledWith("test", {
      expectedProfileRevision: 1,
      patch: { location: { ...LOCATION, streetAddress: "Galle Road 2" } },
    });
    expect(shown.editor.notice).toBe("nearbyPlaces.notice.locationSaved");
    expect(shown.editor.locationChange).toBeNull();
    // A hotel guests can't book yet: the server saves a new time zone at once, and nothing asks.
    act(() => shown.editor.setLocation({ ...LOCATION, timezone: "Europe/London" }));
    await act(() => shown.editor.saveLocation());
    expect(shown.update).toHaveBeenLastCalledWith("test", {
      expectedProfileRevision: 2,
      patch: { location: { ...LOCATION, timezone: "Europe/London" } },
    });
    expect(shown.editor.locationChange).toBeNull();
    expect(shown.editor.profile?.profile.location.timezone).toBe("Europe/London");
    // Someone else's save still says so.
    act(() => shown.editor.setLocation({ ...LOCATION, streetAddress: "Galle Road 3" }));
    await act(() => shown.editor.saveLocation());
    expect(shown.editor.error).toBe("nearbyPlaces.error.conflict");
    expect(shown.editor.serverError).toBe("");
  } finally {
    shown.unmount();
  }
});
