/**
 * Listings API service for admin
 */

import { apiClient } from './client'
import type { Listing, CreateListingRequest, UpdateListingRequest } from '@/lib/types'

export interface ListingsListResponse {
  listings: Listing[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export const listingsService = {
  /**
   * Get all listings for a user
   */
  getUserListings: async (
    userId: string,
    params?: {
      status?: Listing['status']
      category?: string
      page?: number
      page_size?: number
    }
  ): Promise<ListingsListResponse> => {
    const queryParams = new URLSearchParams()
    
    if (params?.status) queryParams.append('status', params.status)
    if (params?.category) queryParams.append('category', params.category)
    if (params?.page) queryParams.append('page', params.page.toString())
    if (params?.page_size) queryParams.append('page_size', params.page_size.toString())
    
    const queryString = queryParams.toString()
    const endpoint = `/admin/users/${userId}/listings${queryString ? `?${queryString}` : ''}`
    
    return apiClient.get<ListingsListResponse>(endpoint)
  },

  /**
   * Get a specific listing
   */
  getListingById: async (userId: string, listingId: string): Promise<Listing> => {
    return apiClient.get<Listing>(`/admin/users/${userId}/listings/${listingId}`)
  },

  /**
   * Create a new listing for a user
   */
  createListing: async (userId: string, data: CreateListingRequest): Promise<Listing> => {
    return apiClient.post<Listing>(`/admin/users/${userId}/listings`, data)
  },

  /**
   * Update a listing
   */
  updateListing: async (
    userId: string,
    listingId: string,
    data: UpdateListingRequest
  ): Promise<Listing> => {
    return apiClient.put<Listing>(`/admin/users/${userId}/listings/${listingId}`, data)
  },

  /**
   * Delete a listing
   */
  deleteListing: async (userId: string, listingId: string): Promise<void> => {
    return apiClient.delete<void>(`/admin/users/${userId}/listings/${listingId}`)
  },
}

