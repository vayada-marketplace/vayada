import { uploadPlatformMedia } from "../platform-media";
import type { PlatformMediaResourceScope } from "../platform-media";

export type UploadedImage = {
  url: string;
  platformMediaObjectId: string;
  storageKey: string;
  width: number;
  height: number;
  size_bytes: number;
  format: string;
};

export type RoomImageReference =
  | string
  | {
      url: string;
      platformMediaObjectId?: string;
      mediaId?: string;
      storageKey?: string;
      altText?: string | null;
    };

export interface MultipleUploadResponse {
  images: UploadedImage[];
  total: number;
}

export const uploadService = {
  async uploadImages(
    files: File[],
    resource: PlatformMediaResourceScope,
  ): Promise<MultipleUploadResponse> {
    const uploaded = await uploadPlatformMedia({
      purpose: "pms.room_type.media",
      resource,
      files,
      visibility: "public",
    });

    return {
      images: uploaded.map((image) => ({
        url: image.url,
        platformMediaObjectId: image.mediaId,
        storageKey: image.storageKey,
        width: image.widthPx ?? 0,
        height: image.heightPx ?? 0,
        size_bytes: image.sizeBytes,
        format: image.contentType,
      })),
      total: uploaded.length,
    };
  },
};

export function imageReferenceUrl(image: RoomImageReference): string {
  return typeof image === "string" ? image : image.url;
}
