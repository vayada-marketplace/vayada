import { pmsClient } from '../api/pmsClient'

export interface ExtractedRoomType {
  name: string
  description: string
  shortDescription: string
  maxOccupancy: number
  size: number
  bedType: string
  baseRate: number
  currency: string
  amenities: string[]
  features: string[]
  sourceImageUrls: string[]
  cancellationPolicy: string
}

export interface ListingImportPreview {
  sourcePlatform: string
  sourceUrl: string
  roomTypes: ExtractedRoomType[]
  hotelName: string
  hotelDescription: string
}

export interface ListingImportConfirmRoomType extends ExtractedRoomType {
  totalRooms: number
}

export interface ListingImportResult {
  roomTypeIds: string[]
  imagesPending: boolean
  message: string
}

export const importService = {
  preview: (url: string) =>
    pmsClient.post<ListingImportPreview>('/admin/import/preview', { url }),

  confirm: (roomTypes: ListingImportConfirmRoomType[]) =>
    pmsClient.post<ListingImportResult>('/admin/import/confirm', { roomTypes }),

  importImages: (roomTypeId: string, sourceImageUrls: string[]) =>
    pmsClient.post('/admin/import/images', { roomTypeId, sourceImageUrls }),
}
