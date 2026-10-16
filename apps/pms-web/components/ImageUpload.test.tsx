import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import ImageUpload from "./ImageUpload";
import { ApiErrorResponse } from "@/services/api/client";
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

  it("uploads only the photos that fit to a saved room and counts the ones it got back", async () => {
    uploadImages.mockResolvedValue({ images: [{ url: "https://cdn.example/new.jpg" }], total: 1 });
    const { onChange, pick } = render({
      images: photos(7),
      mediaResource: pmsRoomMediaResource("p", "room-1"),
    });
    const picked = files(5);
    await pick(picked);

    expect(uploadImages).toHaveBeenCalledWith(picked.slice(0, 3), expect.anything());
    expect(onChange.mock.calls[0][0]).toHaveLength(8);
    expect(text()).toContain('images.skippedPhotos {\\"added\\":1,\\"picked\\":5,\\"max\\":10}');
  });

  it("refuses the whole pick when any picked file is not an image, wherever it is", async () => {
    const { onChange, pick } = render({ images: photos(8) });
    await pick([...files(3), new File(["x"], "notes.pdf", { type: "application/pdf" })]);
    expect(onChange).not.toHaveBeenCalled();
    expect(text()).toContain("rooms.form.onlyImageFiles");
    expect(text()).not.toContain("images.skippedPhotos");
  });

  it("explains that removed photos count until saved when the server refuses the upload", async () => {
    uploadImages.mockRejectedValue(
      new ApiErrorResponse(409, {
        code: "media_plan_limit_reached",
        message:
          "You've reached the 10-photo limit. Upgrade to the paid plan for up to 15 photos per room.",
      }),
    );
    const { onChange, pick } = render({
      images: photos(9),
      mediaResource: pmsRoomMediaResource("p", "room-1"),
    });
    await pick(files(1));
    expect(onChange).not.toHaveBeenCalled();
    expect(text()).toContain("images.saveRemovalsFirst");
    expect(text()).not.toMatch(
      /reached the 10-photo limit|images\.limitReached|images\.skippedPhotos/,
    );
  });

  it("keeps the over-the-limit message and the upgrade link for a downgraded room", () => {
    render({ images: photos(12) });
    expect(text()).toContain("images.overCommissionLimit");
    expect(text()).toContain("images.upgradeForMore");
    expect(view.root.findAllByProps({ type: "file" })).toHaveLength(0);
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
