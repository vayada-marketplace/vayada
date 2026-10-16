import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import ImageUpload, { fitPhotoPick } from "./ImageUpload";
import { pmsRoomMediaResource, type RoomImageReference } from "@/services/upload";

const uploadImages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));
vi.mock("@/services/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/upload")>()),
  uploadService: { uploadImages },
}));

const property = pmsRoomMediaResource("p");
const photos = (count: number): RoomImageReference[] =>
  Array.from({ length: count }, (_, i) => `https://cdn.example/room-${i}.jpg`);
const files = (count: number) =>
  Array.from({ length: count }, (_, i) => new File(["x"], `pick-${i}.jpg`, { type: "image/jpeg" }));

let view: ReactTestRenderer;
afterEach(() => {
  act(() => view?.unmount());
  uploadImages.mockReset();
});

function render(props: Partial<Parameters<typeof ImageUpload>[0]> = {}) {
  const onChange = vi.fn();
  const element = (overrides: Partial<Parameters<typeof ImageUpload>[0]> = {}) =>
    createElement(ImageUpload, {
      images: [],
      onChange,
      mediaResource: property,
      maxImages: 10,
      plan: "commission",
      ...props,
      ...overrides,
    });
  act(() => {
    view = create(element());
  });
  return {
    onChange,
    rerender: (overrides: Partial<Parameters<typeof ImageUpload>[0]>) =>
      act(() => view.update(element(overrides))),
    pick: (picked: File[]) =>
      act(async () => {
        await view.root
          .findByProps({ type: "file" })
          .props.onChange({ target: { files: picked, value: "picked" } });
      }),
  };
}
const text = () => JSON.stringify(view.toJSON());
const links = () => view.root.findAllByType("a").map((link) => link.props.href);

describe("fitPhotoPick", () => {
  it("keeps the first picks that fit the free slots and counts the rest", () => {
    expect(fitPhotoPick(["a", "b", "c"], 8, 10)).toEqual({ accepted: ["a", "b"], skipped: 1 });
    expect(fitPhotoPick(["a", "b"], 0, 10)).toEqual({ accepted: ["a", "b"], skipped: 0 });
    expect(fitPhotoPick(["a"], 11, 10)).toEqual({ accepted: [], skipped: 1 });
  });
});

describe("ImageUpload photo limit (VAY-2131)", () => {
  it.each([
    ["commission", 0, 10],
    ["commission", 9, 10],
    ["fixed", 8, 15],
  ] as const)("shows only the counter for a %s room at %i/%i", (plan, count, max) => {
    render({ plan, images: photos(count), maxImages: max });
    expect(text()).toContain(`images.photoCount {\\"current\\":${count},\\"max\\":${max}}`);
    expect(text()).not.toMatch(/images\.(limitReached|paidLimit|upgradeForMore|skippedPhotos)/);
    expect(links()).toEqual([]);
    expect(view.root.findAllByProps({ type: "file" })).toHaveLength(1);
  });

  it("adds the photos that fit, then says how many were skipped and offers the upgrade once full", async () => {
    const { onChange, pick, rerender } = render();
    const picked = files(12);
    await pick(picked);

    const added = onChange.mock.calls[0][0] as Array<{ pendingFile: File }>;
    expect(added.map((image) => image.pendingFile)).toEqual(picked.slice(0, 10));
    expect(text()).toContain('images.skippedPhotos {\\"added\\":10,\\"picked\\":12,\\"max\\":10}');
    expect(text()).not.toContain("text-red-600");

    rerender({ images: added });
    expect(text()).toContain('images.limitReached {\\"max\\":10}');
    expect(text()).toContain("images.upgradeForMore");
    expect(links()).toEqual(["https://admin.booking.vayada.com/settings?section=billing"]);
    expect(view.root.findAllByProps({ type: "file" })).toHaveLength(0);
  });

  it("uploads only the photos that fit to a saved room", async () => {
    uploadImages.mockResolvedValue({ images: [{ url: "https://cdn.example/new.jpg" }], total: 1 });
    const { onChange, pick } = render({
      images: photos(9),
      mediaResource: pmsRoomMediaResource("p", "room-1"),
    });
    const picked = files(3);
    await pick(picked);

    expect(uploadImages).toHaveBeenCalledWith(picked.slice(0, 1), expect.anything());
    expect(onChange.mock.calls[0][0]).toHaveLength(10);
    expect(text()).toContain('images.skippedPhotos {\\"added\\":1,\\"picked\\":3,\\"max\\":10}');
  });

  it("drops the skipped note once a photo is removed", async () => {
    const { onChange, pick, rerender } = render({ images: photos(9) });
    await pick(files(2));
    rerender({ images: onChange.mock.calls[0][0] });
    expect(text()).toContain("images.skippedPhotos");

    const remove = view.root.findAll(
      (node) =>
        node.type === "button" && String(node.props["aria-label"]).startsWith("images.removeImage"),
    );
    act(() => remove[0].props.onClick());
    rerender({ images: onChange.mock.calls[1][0] });
    expect(onChange.mock.calls[1][0]).toHaveLength(9);
    expect(text()).not.toContain("images.skippedPhotos");
    expect(links()).toEqual([]);
  });

  it("shows one message without an upgrade link for a full paid room", () => {
    render({ plan: "fixed", images: photos(15), maxImages: 15 });
    expect(text()).toContain("images.paidLimit");
    expect(text()).not.toContain("images.upgradeForMore");
    expect(links()).toEqual([]);
    expect(view.root.findAllByProps({ type: "file" })).toHaveLength(0);
  });
});
