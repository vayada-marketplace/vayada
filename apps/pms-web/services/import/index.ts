import { pmsClient } from "../api/pmsClient";
import {
  createPlatformMediaImport,
  shouldUseLegacyMarketplaceImageUpload,
} from "../platform-media";

export interface ExtractedRoomType {
  name: string;
  description: string;
  shortDescription: string;
  maxOccupancy: number;
  size: number;
  bedType: string;
  baseRate: number;
  currency: string;
  amenities: string[];
  features: string[];
  sourceImageUrls: string[];
  cancellationPolicy: string;
}

export interface ListingImportPreview {
  sourcePlatform: string;
  sourceUrl: string;
  roomTypes: ExtractedRoomType[];
  hotelName: string;
  hotelDescription: string;
}

export interface ListingImportConfirmRoomType extends ExtractedRoomType {
  totalRooms: number;
}

export interface ListingImportResult {
  roomTypeIds: string[];
  imagesPending: boolean;
  message: string;
}

export interface ListingImportImagesResult {
  message: string;
  importJobId?: string;
  jobKey?: string;
}

export const importService = {
  preview: (url: string) => pmsClient.post<ListingImportPreview>("/admin/import/preview", { url }),

  confirm: (roomTypes: ListingImportConfirmRoomType[]) =>
    pmsClient.post<ListingImportResult>("/admin/import/confirm", { roomTypes }),

  importImages: async (
    roomTypeId: string,
    sourceImageUrls: string[],
  ): Promise<ListingImportImagesResult> => {
    if (sourceImageUrls.length === 0) return { message: "No images to import" };

    if (shouldUseLegacyMarketplaceImageUpload()) {
      return { message: "Image import is not available on the legacy media backend" };
    }

    const resourceId =
      typeof window !== "undefined"
        ? localStorage.getItem("selectedHotelId") || "pms_hotel_current"
        : "pms_hotel_current";
    const importJob = await createPlatformMediaImport({
      resource: {
        product: "pms",
        resourceType: "pms_hotel",
        resourceId,
        targetResourceId: roomTypeId,
      },
      sourceImageUrls,
      idempotencyKey: `media.import:pms:${roomTypeId}:listing-import:v1`,
    });

    return {
      message: `Queued ${importJob.sourceImageCount} image import${importJob.sourceImageCount === 1 ? "" : "s"}`,
      importJobId: importJob.importJobId,
      jobKey: importJob.jobKey,
    };
  },
};
