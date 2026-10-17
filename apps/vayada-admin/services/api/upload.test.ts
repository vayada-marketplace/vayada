import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadPlatformMedia = vi.hoisted(() => vi.fn());

vi.mock("./platformMedia", () => ({ uploadPlatformMedia }));

import { uploadService } from "./upload";

const file = { name: "photo.jpg", size: 123, type: "image/jpeg" } as File;
const result = (mediaId: string, url: string) => ({
  mediaId,
  url,
  storageKey: `private/media/${mediaId}`,
  contentType: "image/jpeg",
  sizeBytes: 123,
  widthPx: 1200,
  heightPx: 800,
  originalFilename: "photo.jpg",
});

describe("uploadService", () => {
  beforeEach(() => uploadPlatformMedia.mockReset());

  it("uploads a private hero for the exact property and returns only its media ID", async () => {
    uploadPlatformMedia.mockResolvedValue([result("media-hero", "private/media/hero")]);

    await expect(uploadService.uploadHotelProfileImage(file, "property-984")).resolves.toEqual({
      mediaObjectId: "media-hero",
    });
    expect(uploadPlatformMedia).toHaveBeenCalledWith({
      purpose: "property.hero_image",
      visibility: "private",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: "property-984",
      },
      files: [file],
      idempotencyKey: "admin:property-hero:property-984",
    });
  });
});
