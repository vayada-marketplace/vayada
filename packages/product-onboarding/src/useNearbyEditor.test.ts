import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { NearbyCurationState, PropertyProfileResponse } from "@vayada/domain-hotels";
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
