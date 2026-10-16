import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type {
  NearbyCurationState,
  NearbyDiscoveryState,
  PropertyProfileResponse,
} from "@vayada/domain-hotels";
import type { NearbyApi } from "./nearbyApi";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";
import { useNearbyEditor } from "./useNearbyEditor";

it("releases refresh state on reload and ignores the superseded refresh", async () => {
  const profile = {
    propertyId: "test",
    profileRevision: 1,
    profile: { location: {} },
  } as PropertyProfileResponse;
  const curation = {
    profileRevision: 1,
    curationRevision: 1,
    choices: [],
    customPlaces: [],
  } as unknown as NearbyCurationState;
  const current = { status: "empty", profileRevision: 1 } as NearbyDiscoveryState;
  let finish!: (value: NearbyDiscoveryState) => void;
  const pending = new Promise<NearbyDiscoveryState>((resolve) => {
    finish = resolve;
  });
  const api = {
    read: vi.fn().mockResolvedValue(curation),
    refresh: vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockReturnValueOnce(pending)
      .mockResolvedValue(current),
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
    act(() => {
      void editor.refresh();
    });
    expect(editor.refreshing).toBe(true);
    await act(async () => {
      editor.reload();
    });
    expect(editor.refreshing).toBe(false);
    expect(editor.discovery).toBe(current);
    await act(async () => {
      finish({ ...current, status: "ready" });
    });
    expect(editor.refreshing).toBe(false);
    expect(editor.discovery).toBe(current);
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
    refresh: vi.fn().mockResolvedValue({ status: "empty", profileRevision: 1 }),
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
    expect(editor.notice).toBe("Location saved.");
    // Moved pin: the places need a look before they show again.
    await act(() => editor.saveLocation());
    expect(editor.saved).toMatchObject({ profileRevision: 3, savedProfileRevision: 2 });
    expect(editor.notice).toBe("Location saved. Review your saved places for this location.");
  } finally {
    act(() => renderer.unmount());
  }
});
