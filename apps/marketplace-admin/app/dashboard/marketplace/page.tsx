'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { marketplaceService, MarketplaceListing, MarketplaceCreator, CreatorPlatform } from '@/services/api/marketplace'
import { ApiErrorResponse } from '@/services/api/client'
import { Button } from '@/components/ui'
import { Modal } from '@/components/ui/Modal'
import {
  ArrowLeftIcon,
  BuildingOfficeIcon,
  UserGroupIcon,
  MapPinIcon,
  StarIcon,
  PhotoIcon,
  GlobeAltIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'

type Tab = 'listings' | 'creators'

export default function MarketplacePreviewPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>('listings')
  const [listings, setListings] = useState<MarketplaceListing[]>([])
  const [creators, setCreators] = useState<MarketplaceCreator[]>([])
  const [loadingListings, setLoadingListings] = useState(true)
  const [loadingCreators, setLoadingCreators] = useState(true)
  const [error, setError] = useState('')

  // Modal states
  const [selectedListing, setSelectedListing] = useState<MarketplaceListing | null>(null)
  const [selectedCreator, setSelectedCreator] = useState<MarketplaceCreator | null>(null)
  const [currentImageIndex, setCurrentImageIndex] = useState(0)

  useEffect(() => {
    if (!authService.isLoggedIn() || !authService.isAdmin()) {
      router.push('/login')
      return
    }

    loadData()
  }, [router])

  const loadData = async () => {
    await Promise.all([loadListings(), loadCreators()])
  }

  const loadListings = async () => {
    try {
      setLoadingListings(true)
      const data = await marketplaceService.getListings()
      setListings(data)
    } catch (err) {
      console.error('Error loading listings:', err)
      if (err instanceof ApiErrorResponse) {
        setError(err.message)
      }
    } finally {
      setLoadingListings(false)
    }
  }

  const loadCreators = async () => {
    try {
      setLoadingCreators(true)
      const data = await marketplaceService.getCreators()
      setCreators(data)
    } catch (err) {
      console.error('Error loading creators:', err)
      if (err instanceof ApiErrorResponse) {
        setError(err.message)
      }
    } finally {
      setLoadingCreators(false)
    }
  }

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
    return num.toString()
  }

  const getCollaborationTypeBadge = (type: string) => {
    switch (type) {
      case 'Free Stay':
        return 'bg-green-100 text-green-800'
      case 'Paid':
        return 'bg-blue-100 text-blue-800'
      case 'Discount':
        return 'bg-yellow-100 text-yellow-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const getPlatformColor = (name: string) => {
    switch (name) {
      case 'Instagram':
        return 'bg-pink-100 text-pink-800'
      case 'TikTok':
        return 'bg-gray-900 text-white'
      case 'YouTube':
        return 'bg-red-100 text-red-800'
      case 'Facebook':
        return 'bg-blue-100 text-blue-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const openListingModal = (listing: MarketplaceListing) => {
    setSelectedListing(listing)
    setCurrentImageIndex(0)
  }

  const openCreatorModal = (creator: MarketplaceCreator) => {
    setSelectedCreator(creator)
  }

  const nextImage = () => {
    if (selectedListing && selectedListing.images.length > 0) {
      setCurrentImageIndex((prev) => (prev + 1) % selectedListing.images.length)
    }
  }

  const prevImage = () => {
    if (selectedListing && selectedListing.images.length > 0) {
      setCurrentImageIndex((prev) => (prev - 1 + selectedListing.images.length) % selectedListing.images.length)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/dashboard')}
              >
                <ArrowLeftIcon className="w-4 h-4 mr-2" />
                Back
              </Button>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Marketplace Preview</h1>
                <p className="text-sm text-gray-600">View the public marketplace as users see it</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8">
        {/* Tabs */}
        <div className="mb-6 bg-white rounded-lg shadow p-1 inline-flex">
          <button
            onClick={() => setActiveTab('listings')}
            className={`px-6 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'listings'
                ? 'bg-primary-600 text-white'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            <BuildingOfficeIcon className="w-4 h-4 inline-block mr-2" />
            Listings ({listings.length})
          </button>
          <button
            onClick={() => setActiveTab('creators')}
            className={`px-6 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'creators'
                ? 'bg-primary-600 text-white'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            <UserGroupIcon className="w-4 h-4 inline-block mr-2" />
            Creators ({creators.length})
          </button>
        </div>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* Listings Tab */}
        {activeTab === 'listings' && (
          <>
            {loadingListings ? (
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <p className="text-gray-600">Loading listings...</p>
              </div>
            ) : listings.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <BuildingOfficeIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">No listings</h3>
                <p className="mt-1 text-sm text-gray-500">
                  No verified hotels with complete profiles have listings yet.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {listings.map((listing) => (
                  <div
                    key={listing.id}
                    className="bg-white rounded-lg shadow overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
                    onClick={() => openListingModal(listing)}
                  >
                    {/* Image */}
                    <div className="h-48 bg-gray-200 relative">
                      {listing.images && listing.images.length > 0 ? (
                        <img
                          src={listing.images[0]}
                          alt={listing.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <PhotoIcon className="w-16 h-16 text-gray-400" />
                        </div>
                      )}
                      {listing.images && listing.images.length > 1 && (
                        <span className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
                          +{listing.images.length - 1} photos
                        </span>
                      )}
                    </div>

                    {/* Content */}
                    <div className="p-4">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h3 className="font-semibold text-gray-900">{listing.name}</h3>
                          <p className="text-sm text-gray-500">{listing.hotel_name}</p>
                        </div>
                        {listing.accommodation_type && (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                            {listing.accommodation_type}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center text-sm text-gray-500 mb-3">
                        <MapPinIcon className="w-4 h-4 mr-1" />
                        {listing.location}
                      </div>

                      {listing.description && (
                        <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                          {listing.description}
                        </p>
                      )}

                      {/* Collaboration types */}
                      <div className="flex flex-wrap gap-1 mb-3">
                        {listing.collaboration_offerings.map((offering) => (
                          <span
                            key={offering.id}
                            className={`text-xs px-2 py-1 rounded-full ${getCollaborationTypeBadge(offering.collaboration_type)}`}
                          >
                            {offering.collaboration_type}
                          </span>
                        ))}
                      </div>

                      {/* Creator requirements */}
                      {listing.creator_requirements && (
                        <div className="text-xs text-gray-500 border-t pt-2">
                          {listing.creator_requirements.min_followers && (
                            <span className="mr-3">
                              Min {formatNumber(listing.creator_requirements.min_followers)} followers
                            </span>
                          )}
                          {listing.creator_requirements.platforms && listing.creator_requirements.platforms.length > 0 && (
                            <span>{listing.creator_requirements.platforms.join(', ')}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Creators Tab */}
        {activeTab === 'creators' && (
          <>
            {loadingCreators ? (
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <p className="text-gray-600">Loading creators...</p>
              </div>
            ) : creators.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">No creators</h3>
                <p className="mt-1 text-sm text-gray-500">
                  No verified creators with complete profiles yet.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {creators.map((creator) => (
                  <div
                    key={creator.id}
                    className="bg-white rounded-lg shadow overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
                    onClick={() => openCreatorModal(creator)}
                  >
                    {/* Header with avatar */}
                    <div className="p-4 flex items-center gap-4">
                      <div className="w-16 h-16 rounded-full bg-gray-200 overflow-hidden flex-shrink-0">
                        {creator.profile_picture ? (
                          <img
                            src={creator.profile_picture}
                            alt={creator.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <UserGroupIcon className="w-8 h-8 text-gray-400" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 truncate">{creator.name}</h3>
                        <div className="flex items-center text-sm text-gray-500">
                          <MapPinIcon className="w-4 h-4 mr-1 flex-shrink-0" />
                          <span className="truncate">{creator.location || 'No location'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="px-4 pb-4">
                      <div className="flex items-center gap-4 mb-3">
                        <div className="text-center">
                          <p className="text-lg font-semibold text-gray-900">
                            {formatNumber(creator.audience_size)}
                          </p>
                          <p className="text-xs text-gray-500">Audience</p>
                        </div>
                        {creator.total_reviews > 0 && (
                          <div className="text-center">
                            <p className="text-lg font-semibold text-gray-900 flex items-center justify-center">
                              <StarIcon className="w-4 h-4 text-yellow-400 mr-1" />
                              {creator.average_rating.toFixed(1)}
                            </p>
                            <p className="text-xs text-gray-500">{creator.total_reviews} reviews</p>
                          </div>
                        )}
                      </div>

                      {creator.short_description && (
                        <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                          {creator.short_description}
                        </p>
                      )}

                      {/* Platforms */}
                      <div className="flex flex-wrap gap-2">
                        {creator.platforms.map((platform) => (
                          <span
                            key={platform.id}
                            className={`text-xs px-2 py-1 rounded ${getPlatformColor(platform.name)}`}
                          >
                            {platform.name}: {formatNumber(platform.followers)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Listing Detail Modal */}
      {selectedListing && (
        <Modal
          isOpen={!!selectedListing}
          onClose={() => setSelectedListing(null)}
          title={selectedListing.name}
          size="xl"
        >
          <div className="space-y-6">
            {/* Image Gallery */}
            {selectedListing.images && selectedListing.images.length > 0 && (
              <div className="relative">
                <div className="aspect-video bg-gray-200 rounded-lg overflow-hidden">
                  <img
                    src={selectedListing.images[currentImageIndex]}
                    alt={`${selectedListing.name} - Image ${currentImageIndex + 1}`}
                    className="w-full h-full object-cover"
                  />
                </div>
                {selectedListing.images.length > 1 && (
                  <>
                    <button
                      onClick={prevImage}
                      className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/80 hover:bg-white rounded-full p-2 shadow"
                    >
                      <ChevronLeftIcon className="w-5 h-5" />
                    </button>
                    <button
                      onClick={nextImage}
                      className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/80 hover:bg-white rounded-full p-2 shadow"
                    >
                      <ChevronRightIcon className="w-5 h-5" />
                    </button>
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1 rounded-full">
                      {currentImageIndex + 1} / {selectedListing.images.length}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Hotel Info */}
            <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
              {selectedListing.hotel_picture && (
                <img
                  src={selectedListing.hotel_picture}
                  alt={selectedListing.hotel_name}
                  className="w-12 h-12 rounded-full object-cover"
                />
              )}
              <div>
                <p className="font-semibold text-gray-900">{selectedListing.hotel_name}</p>
                <div className="flex items-center text-sm text-gray-500">
                  <MapPinIcon className="w-4 h-4 mr-1" />
                  {selectedListing.location}
                </div>
              </div>
              {selectedListing.accommodation_type && (
                <span className="ml-auto text-sm bg-gray-200 text-gray-700 px-3 py-1 rounded-full">
                  {selectedListing.accommodation_type}
                </span>
              )}
            </div>

            {/* Description */}
            {selectedListing.description && (
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">Description</h4>
                <p className="text-gray-600">{selectedListing.description}</p>
              </div>
            )}

            {/* Collaboration Offerings */}
            <div>
              <h4 className="font-semibold text-gray-900 mb-3">Collaboration Offerings</h4>
              <div className="space-y-3">
                {selectedListing.collaboration_offerings.map((offering) => (
                  <div key={offering.id} className="p-4 border rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${getCollaborationTypeBadge(offering.collaboration_type)}`}>
                        {offering.collaboration_type}
                      </span>
                      <span className="text-sm text-gray-500">
                        {offering.platforms.join(', ')}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1">
                      {offering.collaboration_type === 'Free Stay' && (
                        <p>Stay duration: {offering.free_stay_min_nights} - {offering.free_stay_max_nights} nights</p>
                      )}
                      {offering.collaboration_type === 'Paid' && offering.paid_max_amount && (
                        <p>Budget: up to ${offering.paid_max_amount}</p>
                      )}
                      {offering.collaboration_type === 'Discount' && offering.discount_percentage && (
                        <p>Discount: {offering.discount_percentage}% off</p>
                      )}
                      {offering.availability_months && offering.availability_months.length > 0 && (
                        <p>Available: {offering.availability_months.join(', ')}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Creator Requirements */}
            {selectedListing.creator_requirements && (
              <div>
                <h4 className="font-semibold text-gray-900 mb-3">Creator Requirements</h4>
                <div className="p-4 border rounded-lg space-y-2">
                  {selectedListing.creator_requirements.platforms && selectedListing.creator_requirements.platforms.length > 0 && (
                    <p className="text-sm">
                      <span className="text-gray-500">Platforms:</span>{' '}
                      <span className="text-gray-900">{selectedListing.creator_requirements.platforms.join(', ')}</span>
                    </p>
                  )}
                  {selectedListing.creator_requirements.min_followers && (
                    <p className="text-sm">
                      <span className="text-gray-500">Min Followers:</span>{' '}
                      <span className="text-gray-900">{formatNumber(selectedListing.creator_requirements.min_followers)}</span>
                    </p>
                  )}
                  {selectedListing.creator_requirements.target_countries && selectedListing.creator_requirements.target_countries.length > 0 && (
                    <p className="text-sm">
                      <span className="text-gray-500">Target Countries:</span>{' '}
                      <span className="text-gray-900">{selectedListing.creator_requirements.target_countries.join(', ')}</span>
                    </p>
                  )}
                  {selectedListing.creator_requirements.target_age_groups && selectedListing.creator_requirements.target_age_groups.length > 0 && (
                    <p className="text-sm">
                      <span className="text-gray-500">Target Age Groups:</span>{' '}
                      <span className="text-gray-900">{selectedListing.creator_requirements.target_age_groups.join(', ')}</span>
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Creator Detail Modal */}
      {selectedCreator && (
        <Modal
          isOpen={!!selectedCreator}
          onClose={() => setSelectedCreator(null)}
          title={selectedCreator.name}
          size="xl"
        >
          <div className="space-y-6">
            {/* Profile Header */}
            <div className="flex items-center gap-6">
              <div className="w-24 h-24 rounded-full bg-gray-200 overflow-hidden flex-shrink-0">
                {selectedCreator.profile_picture ? (
                  <img
                    src={selectedCreator.profile_picture}
                    alt={selectedCreator.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <UserGroupIcon className="w-12 h-12 text-gray-400" />
                  </div>
                )}
              </div>
              <div className="flex-1">
                <h3 className="text-xl font-semibold text-gray-900">{selectedCreator.name}</h3>
                <div className="flex items-center text-gray-500 mb-2">
                  <MapPinIcon className="w-4 h-4 mr-1" />
                  {selectedCreator.location || 'No location'}
                </div>
                <div className="flex items-center gap-6">
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{formatNumber(selectedCreator.audience_size)}</p>
                    <p className="text-sm text-gray-500">Total Audience</p>
                  </div>
                  {selectedCreator.total_reviews > 0 && (
                    <div>
                      <p className="text-2xl font-bold text-gray-900 flex items-center">
                        <StarIcon className="w-5 h-5 text-yellow-400 mr-1" />
                        {selectedCreator.average_rating.toFixed(1)}
                      </p>
                      <p className="text-sm text-gray-500">{selectedCreator.total_reviews} reviews</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bio */}
            {selectedCreator.short_description && (
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">About</h4>
                <p className="text-gray-600">{selectedCreator.short_description}</p>
              </div>
            )}

            {/* Portfolio Link */}
            {selectedCreator.portfolio_link && (
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">Portfolio</h4>
                <a
                  href={selectedCreator.portfolio_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-primary-600 hover:text-primary-700"
                >
                  <GlobeAltIcon className="w-4 h-4 mr-2" />
                  {selectedCreator.portfolio_link}
                </a>
              </div>
            )}

            {/* Platforms */}
            <div>
              <h4 className="font-semibold text-gray-900 mb-3">Social Media Platforms</h4>
              <div className="space-y-4">
                {selectedCreator.platforms.map((platform) => (
                  <div key={platform.id} className="p-4 border rounded-lg">
                    <div className="flex items-center justify-between mb-3">
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${getPlatformColor(platform.name)}`}>
                        {platform.name}
                      </span>
                      <span className="text-sm text-gray-500">@{platform.handle}</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mb-3">
                      <div>
                        <p className="text-2xl font-bold text-gray-900">{formatNumber(platform.followers)}</p>
                        <p className="text-sm text-gray-500">Followers</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-gray-900">{platform.engagement_rate.toFixed(1)}%</p>
                        <p className="text-sm text-gray-500">Engagement Rate</p>
                      </div>
                    </div>

                    {/* Demographics */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3 border-t">
                      {/* Top Countries */}
                      {platform.top_countries && platform.top_countries.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-gray-500 uppercase mb-2">Top Countries</p>
                          <div className="space-y-1">
                            {platform.top_countries.slice(0, 3).map((country, idx) => (
                              <div key={idx} className="flex justify-between text-sm">
                                <span className="text-gray-700">{country.country}</span>
                                <span className="text-gray-500">{country.percentage}%</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Age Groups */}
                      {platform.top_age_groups && platform.top_age_groups.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-gray-500 uppercase mb-2">Age Groups</p>
                          <div className="space-y-1">
                            {platform.top_age_groups.slice(0, 3).map((group, idx) => (
                              <div key={idx} className="flex justify-between text-sm">
                                <span className="text-gray-700">{group.ageRange}</span>
                                <span className="text-gray-500">{group.percentage}%</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Gender Split */}
                      {platform.gender_split && (
                        <div>
                          <p className="text-xs font-medium text-gray-500 uppercase mb-2">Gender Split</p>
                          <div className="space-y-1">
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-700">Male</span>
                              <span className="text-gray-500">{platform.gender_split.male}%</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-700">Female</span>
                              <span className="text-gray-500">{platform.gender_split.female}%</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
