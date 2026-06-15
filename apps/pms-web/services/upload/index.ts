import { ApiErrorResponse } from "../api/client";
import { getAuthBearerToken } from "../auth/sessionStore";
import { shouldUseLegacyMarketplaceImageUpload, uploadPlatformMedia } from "../platform-media";
import type { PlatformMediaResourceScope } from "../platform-media";

const LEGACY_IMAGE_UPLOAD_API_BASE_URL =
  process.env.NEXT_PUBLIC_MARKETPLACE_API_URL || "https://api.vayada.com";

export type UploadedImage = {
  url: string;
  platformMediaObjectId?: string;
  storageKey: string;
  width: number;
  height: number;
  size_bytes: number;
  format: string;
};

export type RoomImageReference =
  | string
  | {
      url?: string | null;
      platformMediaObjectId?: string;
      mediaId?: string;
      storageKey?: string;
      altText?: string | null;
    };

export interface MultipleUploadResponse {
  images: UploadedImage[];
  total: number;
}

type LegacyUploadedImage = {
  url: string;
  key: string;
  width: number;
  height: number;
  size_bytes: number;
  format: string;
};

type LegacyMultipleUploadResponse = {
  images: LegacyUploadedImage[];
  total: number;
};

export const uploadService = {
  async uploadImages(
    files: File[],
    resource: PlatformMediaResourceScope,
  ): Promise<MultipleUploadResponse> {
    if (shouldUseLegacyMarketplaceImageUpload()) {
      return uploadLegacyMarketplaceImages(files);
    }

    const uploaded = await uploadPlatformMedia({
      purpose: "pms.room_type.media",
      resource,
      files,
      visibility: "public",
    });

    const images = uploaded.flatMap((image) =>
      image?.url
        ? [
            {
              url: image.url,
              platformMediaObjectId: image.mediaId,
              storageKey: image.storageKey,
              width: image.widthPx ?? 0,
              height: image.heightPx ?? 0,
              size_bytes: image.sizeBytes,
              format: image.contentType,
            },
          ]
        : [],
    );

    return {
      images,
      total: images.length,
    };
  },
};

async function uploadLegacyMarketplaceImages(files: File[]): Promise<MultipleUploadResponse> {
  if (files.length === 0) return { images: [], total: 0 };

  const token = getAuthBearerToken();
  if (!token) {
    throw new ApiErrorResponse(401, { detail: "Not authenticated" });
  }

  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const hotelId = typeof window !== "undefined" ? localStorage.getItem("selectedHotelId") : null;
  if (hotelId) {
    headers["X-Hotel-Id"] = hotelId;
  }

  const response = await fetch(`${LEGACY_IMAGE_UPLOAD_API_BASE_URL}/upload/images/listing`, {
    method: "POST",
    headers,
    body: formData,
  });

  const body = await parseUploadResponseBody(response);
  if (!response.ok) {
    throw new ApiErrorResponse(response.status, {
      detail: legacyUploadErrorDetail(body) ?? "Image upload failed",
    });
  }

  const data = body as LegacyMultipleUploadResponse;
  const images = (data.images ?? []).flatMap((image) =>
    image?.url
      ? [
          {
            url: image.url,
            storageKey: image.key,
            width: image.width ?? 0,
            height: image.height ?? 0,
            size_bytes: image.size_bytes ?? 0,
            format: image.format ?? "image",
          },
        ]
      : [],
  );

  return {
    images,
    total: images.length,
  };
}

async function parseUploadResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function legacyUploadErrorDetail(body: unknown): string | undefined {
  if (typeof body === "string") return body || undefined;
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail?: unknown }).detail;
    return typeof detail === "string" ? detail : undefined;
  }
  return undefined;
}

export function imageReferenceUrl(image: RoomImageReference | null | undefined): string {
  if (!image) return "";
  if (typeof image === "string") return image;
  return image.url ?? "";
}

export function isRoomImageReference(
  image: RoomImageReference | null | undefined,
): image is RoomImageReference {
  return imageReferenceUrl(image).trim().length > 0;
}
