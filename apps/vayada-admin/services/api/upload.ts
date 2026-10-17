/**
 * Upload API service
 */

import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";

export interface UploadMediaObjectResponse {
  mediaObjectId: string;
}

export const uploadService = {
  /**
   * Upload an image file for hotel profile
   * @param file - The image file to upload
   * @param propertyId - The exact property that owns the hero image
   * @returns The canonical media object ID
   */
  uploadHotelProfileImage: async (
    file: File,
    propertyId: string,
  ): Promise<UploadMediaObjectResponse> => {
    const [uploaded] = await uploadPlatformMedia({
      purpose: "property.hero_image",
      visibility: "private",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
      },
      files: [file],
      idempotencyKey: `admin:property-hero:${propertyId}`,
    });
    if (!uploaded) throw new Error("The property hero image did not finish uploading.");
    return { mediaObjectId: uploaded.mediaId };
  },
};
