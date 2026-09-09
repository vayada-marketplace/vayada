import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PreparedHotelImportPanel,
  type PreparedImportClient,
  type PreparedImportResponse,
} from "./PreparedHotelImportPanel";
const response = (name = "Hotel A"): PreparedImportResponse => ({
  import: {
    sourceId: "invite",
    propertyId: null,
    results: {},
    data: {
      contractVersion: "prepared-hotel-import.v1",
      property: { displayName: "Prepared", city: "Berlin" },
      rooms: [],
    },
  },
  profile: {
    profileRevision: 1,
    propertyId: "a",
    profile: {
      displayName: name,
      propertyType: "hotel",
      location: { city: "Current" },
      contacts: [],
    },
  } as never,
  canImportProperty: true,
});
let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));
const button = (name: string) =>
  renderer.root.findAllByType("button").find((node) => node.children.join("") === name)!;
async function mount(client: PreparedImportClient, propertyId = "a") {
  await act(async () => {
    renderer = create(<PreparedHotelImportPanel client={client} propertyId={propertyId} />);
  });
}
describe("prepared import review", () => {
  it("writes only explicitly selected fields", async () => {
    const get = vi.fn().mockResolvedValue(response());
    const post = vi.fn().mockResolvedValue({ items: [] });
    await mount({ get, post });
    expect(post).not.toHaveBeenCalled();
    await act(async () => button("Review prepared hotel data").props.onClick());
    expect(button("Save selected items").props.disabled).toBe(true);
    await act(async () => renderer.root.findAllByProps({ type: "checkbox" })[0].props.onChange());
    await act(async () => button("Save selected items").props.onClick());
    expect(post.mock.calls[0][1].data.property).toEqual({ displayName: "Prepared" });
  });
  it("ignores delayed manual refresh after switching properties", async () => {
    let resolveOld!: (value: PreparedImportResponse) => void;
    const get = vi.fn().mockResolvedValue(response());
    const post = vi.fn();
    const client = { get, post };
    await mount(client);
    await act(async () => button("Review prepared hotel data").props.onClick());
    get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await act(async () => button("Refresh").props.onClick());
    get.mockResolvedValue(response("Hotel B"));
    await act(async () =>
      renderer.update(<PreparedHotelImportPanel client={client} propertyId="b" />),
    );
    await act(async () => resolveOld(response("Hotel A")));
    await act(async () => button("Review prepared hotel data").props.onClick());
    expect(renderer.root.findByType("strong").children).toEqual(["Hotel B"]);
  });
  it("does not expose imported fields again while unselected fields remain", async () => {
    const next = response();
    next.import!.results["property:displayName"] = {
      itemId: "property:displayName",
      status: "applied",
    };
    await mount({ get: vi.fn().mockResolvedValue(next), post: vi.fn() });
    await act(async () => button("Review prepared hotel data").props.onClick());
    expect(renderer.root.findAllByProps({ "aria-label": "Prepared Hotel name" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ "aria-label": "Prepared City" })).toHaveLength(1);
  });
});
