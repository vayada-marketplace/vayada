import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { AffiliateBookingDestinationEditor } from "./AffiliateBookingDestinationEditor";
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/services/api/targetClient", () => ({ targetApiClient: api }));
let renderer: ReactTestRenderer;
const configuration = {
  displayName: "Hotel bookings",
  bookingUrl: "https://booking.example.com/?hotel=42",
};
const saved = {
  destinations: [
    { destinationVersionId: "version-1", configuration, trackingStatus: "not_validated" },
  ],
};
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.resetAllMocks();
});
async function mount() {
  api.get.mockResolvedValue({ destinations: [] });
  await act(async () => {
    renderer = create(
      createElement(AffiliateBookingDestinationEditor, { propertyId: "hotel-1", key: "hotel-1" }),
    );
  });
}
const button = (label: string) =>
  renderer.root.findAllByType("button").find((b) => b.children.includes(label))!;
const enter = async (label: string, value: string) => {
  await act(async () =>
    renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
  );
};
it("starts empty and rejects malformed or unsafe URLs before POST", async () => {
  await mount();
  expect(button("Save booking page").props.disabled).toBe(true);
  await enter("Booking page name", configuration.displayName);
  for (const url of [
    "http://example.com",
    "https:///example.com",
    "https://u:p@example.com",
    "https://example.com/#fragment",
  ]) {
    await enter("Booking page URL", url);
    await act(async () => button("Save booking page").props.onClick());
    expect(api.post).not.toHaveBeenCalled();
  }
});
it("retries the normalized configuration with the same key and reloads unvalidated history", async () => {
  await mount();
  await enter("Booking page name", " Hotel bookings ");
  await enter("Booking page URL", configuration.bookingUrl);
  api.post.mockRejectedValueOnce(new Error("network")).mockImplementationOnce(async () => {
    api.get.mockResolvedValue(saved);
  });
  await act(async () => button("Save booking page").props.onClick());
  await act(async () => button("Save booking page").props.onClick());
  expect(api.post.mock.calls[0]).toEqual(api.post.mock.calls[1]);
  expect(api.post.mock.calls[0]).toEqual([
    "/api/marketplace/properties/hotel-1/affiliate-destinations",
    configuration,
    { headers: { "Idempotency-Key": expect.any(String) } },
  ]);
  expect(renderer.root.findAllByType("li")).toHaveLength(1);
  expect(renderer.root.findAllByType("a")).toHaveLength(0);
  expect(button("Save booking page").props.disabled).toBe(true);
});
it("clears successful input even when the history refresh fails", async () => {
  await mount();
  await enter("Booking page name", configuration.displayName);
  await enter("Booking page URL", configuration.bookingUrl);
  api.post.mockImplementation(async () => {
    api.get.mockRejectedValue(new Error("reload"));
  });
  await act(async () => button("Save booking page").props.onClick());
  expect(api.post).toHaveBeenCalledOnce();
  expect(button("Save booking page").props.disabled).toBe(true);
  expect(button("Reload booking pages").props.disabled).toBe(false);
  api.get.mockResolvedValue(saved);
  await act(async () => button("Reload booking pages").props.onClick());
  expect(renderer.root.findAllByType("li")).toHaveLength(1);
  expect(api.post).toHaveBeenCalledOnce();
});
it("ignores a previous property request after a keyed property switch", async () => {
  let finish!: (value: unknown) => void;
  api.get
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ destinations: [] });
  await act(async () => {
    renderer = create(
      createElement(AffiliateBookingDestinationEditor, { propertyId: "hotel-1", key: "hotel-1" }),
    );
  });
  await act(async () =>
    renderer.update(
      createElement(AffiliateBookingDestinationEditor, { propertyId: "hotel-2", key: "hotel-2" }),
    ),
  );
  await act(async () => finish(saved));
  expect(renderer.root.findAllByType("li")).toHaveLength(0);
  expect(api.get).toHaveBeenLastCalledWith(
    "/api/marketplace/properties/hotel-2/affiliate-destinations",
  );
});

it("shows server-reported missing checks without offering manual verification", async () => {
  await mount();
  api.get.mockResolvedValue({
    destinations: [
      {
        ...saved.destinations[0],
        trackingReadiness: {
          status: "pending",
          missing: ["referral_round_trip", "stay_completion"],
        },
      },
    ],
  });
  await act(async () => button("Reload booking pages").props.onClick());
  const view = JSON.stringify(renderer.toJSON());
  expect(view).toContain("Match the creator link");
  expect(view).toContain("guest completed the stay");
  expect(view).not.toContain("Receive booking confirmations");
  expect(renderer.root.findAllByType("input")).toHaveLength(2);
  expect(api.post).not.toHaveBeenCalled();
});
it("does not treat absent verification details as ready", async () => {
  await mount();
  api.get.mockResolvedValue(saved);
  await act(async () => button("Reload booking pages").props.onClick());
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "Tracking verification details are unavailable",
  );
  expect(JSON.stringify(renderer.toJSON())).toContain("Tracking not validated");
});
