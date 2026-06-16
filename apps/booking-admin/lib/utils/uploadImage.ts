import {
  getAuthBearerToken,
  getAuthKitAccessToken,
  getScopedBookingHotelIds,
} from "@/services/auth/sessionStore";

const PLATFORM_MEDIA_API_BASE_URL =
  process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL ||
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  "https://api.localhost";
const LEGACY_IMAGE_UPLOAD_API_BASE_URL =
  process.env.NEXT_PUBLIC_MARKETPLACE_API_URL ||
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  "https://api.vayada.com";

type BookingMediaPurpose = "property.hero_image" | "property.gallery_image";

type UploadTarget = {
  uploadTargetId: string;
  clientFileId: string;
  method: "PUT";
  uploadUrl: string;
  headers: Record<string, string>;
};

type UploadSessionResponse = {
  uploadSession: { sessionId: string };
  uploadTargets: UploadTarget[];
};

type FinalizeResponse = {
  mediaObjects: Array<{
    storageKey: string;
    variants: Array<{ publicCdnUrl: string | null; storageKey: string }>;
  }>;
};

type LegacyImageUploadResponse = {
  url?: string;
  thumbnail_url?: string | null;
  key?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
  format?: string;
};

type LegacyMultipleImageUploadResponse = {
  images?: LegacyImageUploadResponse[];
  total?: number;
};

export async function uploadImages(
  files: File | File[],
  purpose: BookingMediaPurpose = "property.gallery_image",
): Promise<string[]> {
  const fileList = Array.isArray(files) ? files : [files];
  if (fileList.length === 0) return [];

  if (shouldUseLegacyMarketplaceImageUpload()) {
    return uploadLegacyMarketplaceImages(fileList, purpose);
  }

  const token = getAuthKitAccessToken() ?? getAuthBearerToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const bookingHotelId = getBookingHotelUploadResourceId();

  const create = await fetch(`${PLATFORM_MEDIA_API_BASE_URL}/api/media/upload-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      purpose,
      visibility: "public",
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: bookingHotelId,
      },
      files: fileList.map((file, index) => ({
        clientFileId: `file_${index + 1}`,
        filename: file.name || `booking-image-${index + 1}.jpg`,
        contentType: file.type || "image/jpeg",
        sizeBytes: file.size,
      })),
    }),
  });

  if (!create.ok) throw new Error(await readMediaError(create, "Upload session failed"));
  const createBody = (await create.json()) as UploadSessionResponse;

  await Promise.all(
    createBody.uploadTargets.map(async (target, index) => {
      const file = fileList[index];
      if (!file || isDeterministicLocalUploadTarget(target.uploadUrl)) return;

      const upload = await fetch(target.uploadUrl, {
        method: target.method,
        headers: target.headers,
        body: file,
      });

      if (!upload.ok) throw new Error("Upload failed");
    }),
  );

  const finalized = await fetch(
    `${PLATFORM_MEDIA_API_BASE_URL}/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        files: createBody.uploadTargets.map((target, index) => {
          const file = fileList[index]!;
          return {
            uploadTargetId: target.uploadTargetId,
            contentType: file.type || "image/jpeg",
            sizeBytes: file.size,
          };
        }),
      }),
    },
  );

  if (!finalized.ok) throw new Error(await readMediaError(finalized, "Upload finalize failed"));
  const finalizedBody = (await finalized.json()) as FinalizeResponse;
  return finalizedBody.mediaObjects.map(
    (mediaObject) =>
      mediaObject.variants.find((variant) => variant.publicCdnUrl)?.publicCdnUrl ??
      mediaObject.storageKey,
  );
}

export async function uploadSingleImage(
  file: File,
  purpose: BookingMediaPurpose = "property.gallery_image",
): Promise<string> {
  const urls = await uploadImages(file, purpose);
  if (!urls[0]) throw new Error("No image URL returned");
  return urls[0];
}

function isDeterministicLocalUploadTarget(uploadUrl: string): boolean {
  return uploadUrl.startsWith("https://uploads.vayada.localhost/");
}

async function uploadLegacyMarketplaceImages(
  fileList: File[],
  purpose: BookingMediaPurpose,
): Promise<string[]> {
  const token = getAuthBearerToken() ?? getAuthKitAccessToken();
  if (!token) throw new Error("Not authenticated");

  if (purpose === "property.hero_image" && fileList.length === 1) {
    const formData = new FormData();
    formData.append("file", fileList[0]!);
    const legacyBaseUrl = stripTrailingSlash(LEGACY_IMAGE_UPLOAD_API_BASE_URL);
    const response = await fetch(`${legacyBaseUrl}/upload/image/hotel-profile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!response.ok) throw new Error(await readMediaError(response, "Upload failed"));
    const body = (await response.json()) as LegacyImageUploadResponse;
    return [getLegacyImageUrl(body)];
  }

  const formData = new FormData();
  fileList.forEach((file) => formData.append("files", file));
  const legacyBaseUrl = stripTrailingSlash(LEGACY_IMAGE_UPLOAD_API_BASE_URL);
  const response = await fetch(`${legacyBaseUrl}/upload/images/listing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!response.ok) throw new Error(await readMediaError(response, "Upload failed"));
  const body = (await response.json()) as LegacyMultipleImageUploadResponse;
  if (!Array.isArray(body.images)) throw new Error("Upload failed: no image URLs returned");
  return body.images.map((image) => getLegacyImageUrl(image));
}

function shouldUseLegacyMarketplaceImageUpload(): boolean {
  return stripTrailingSlash(PLATFORM_MEDIA_API_BASE_URL) === "https://api.vayada.com";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getLegacyImageUrl(image: LegacyImageUploadResponse): string {
  if (typeof image.url === "string" && image.url.trim()) return image.url;
  throw new Error("Upload failed: no image URL returned");
}

function getBookingHotelUploadResourceId(): string {
  if (typeof window !== "undefined") {
    const selectedHotelId = localStorage.getItem("selectedHotelId");
    if (selectedHotelId) return selectedHotelId;
  }

  const scopedHotelId = getScopedBookingHotelIds()[0];
  if (scopedHotelId) return scopedHotelId;

  return "booking_hotel_current";
}

async function readMediaError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown; code?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    if (typeof body.code === "string") return body.code;
  } catch {
    /* ignore */
  }
  return fallback;
}
