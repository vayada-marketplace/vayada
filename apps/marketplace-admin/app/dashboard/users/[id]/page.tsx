'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui'
import { Modal } from '@/components/ui/Modal'
import { UserIcon, ArrowLeftIcon, TrashIcon } from '@heroicons/react/24/outline'
import { usersService } from '@/services/api'
import { ApiErrorResponse } from '@/services/api/client'
import type { UserDetailResponse, CreatorProfileDetail, HotelProfileDetail, PlatformResponse, ListingResponse, CollaborationOffering, CreatorRequirements } from '@/lib/types'

export default function UserDetailPage() {
  const router = useRouter()
  const params = useParams()
  const userId = params.id as string
  
  // Active tab state
  const [activeTab, setActiveTab] = useState<'profile' | 'social' | 'listings'>('profile')
  const [userDetail, setUserDetail] = useState<UserDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedListing, setSelectedListing] = useState<ListingResponse | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  useEffect(() => {
    loadUserDetail()
  }, [userId])

  const loadUserDetail = async () => {
    try {
      setLoading(true)
      setError('')
      const data = await usersService.getUserById(userId)
      setUserDetail(data)
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        if (err.status === 404) {
          setError('User not found')
        } else if (err.status === 403) {
          setError('Access denied. Admin privileges required.')
        } else {
          setError(err.data.detail as string || 'Failed to load user details')
        }
      } else {
        setError('Failed to load user details')
      }
    } finally {
      setLoading(false)
    }
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'verified':
        return 'bg-green-100 text-green-800'
      case 'pending':
        return 'bg-yellow-100 text-yellow-800'
      case 'rejected':
        return 'bg-red-100 text-red-800'
      case 'suspended':
        return 'bg-gray-100 text-gray-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const getTypeBadgeColor = (type: string) => {
    switch (type) {
      case 'admin':
        return 'bg-purple-100 text-purple-800'
      case 'hotel':
        return 'bg-blue-100 text-blue-800'
      case 'creator':
        return 'bg-indigo-100 text-indigo-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600">Loading user details...</p>
        </div>
      </div>
    )
  }

  if (error || !userDetail) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error || 'User not found'}</p>
          <Button variant="outline" onClick={() => router.push('/dashboard')}>
            Back to Users
          </Button>
        </div>
      </div>
    )
  }

  const profile = userDetail.profile as CreatorProfileDetail | HotelProfileDetail | null
  const isCreator = userDetail.type === 'creator'
  const isHotel = userDetail.type === 'hotel'

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center space-x-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push('/dashboard')}
                >
                  <ArrowLeftIcon className="w-4 h-4 mr-2" />
                  Back to Users
                </Button>
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">User Details</h1>
                  <p className="text-sm text-gray-600">View and manage user information</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                className="text-red-600 border-red-300 hover:bg-red-50"
              >
                <TrashIcon className="w-4 h-4 mr-2" />
                Delete User
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-white shadow rounded-lg overflow-hidden">
          {/* User Header Section */}
          <div className="px-6 py-6 border-b border-gray-200">
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0">
                {(() => {
                  // For creators, prefer profile.profilePicture, otherwise use avatar
                  const imageUrl = userDetail.type === 'creator' && userDetail.profile 
                    ? (userDetail.profile as CreatorProfileDetail).profilePicture 
                    : userDetail.avatar
                  
                  return imageUrl ? (
                    <img 
                      className="h-20 w-20 rounded-full object-cover" 
                      src={imageUrl} 
                      alt={userDetail.name} 
                    />
                  ) : (
                    <div className="h-20 w-20 rounded-full bg-gray-200 flex items-center justify-center">
                      <UserIcon className="h-10 w-10 text-gray-400" />
                    </div>
                  )
                })()}
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-gray-900">{userDetail.name}</h2>
                <p className="text-sm text-gray-600 mt-1">{userDetail.email}</p>
                <div className="mt-3 flex gap-2">
                  <span className={`px-3 py-1 text-sm font-semibold rounded-full ${getTypeBadgeColor(userDetail.type)}`}>
                    {userDetail.type}
                  </span>
                  <span className={`px-3 py-1 text-sm font-semibold rounded-full ${getStatusBadgeColor(userDetail.status)}`}>
                    {userDetail.status}
                  </span>
                  {userDetail.emailVerified && (
                    <span className="px-3 py-1 text-sm font-semibold rounded-full bg-green-100 text-green-800">
                      Email Verified
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-200">
            <nav className="flex -mb-px px-6" aria-label="Tabs">
              <button
                onClick={() => setActiveTab('profile')}
                className={`
                  py-4 px-6 border-b-2 font-medium text-sm
                  ${activeTab === 'profile'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }
                `}
              >
                Profile
              </button>
              {isCreator && (
                <button
                  onClick={() => setActiveTab('social')}
                  className={`
                    py-4 px-6 border-b-2 font-medium text-sm
                    ${activeTab === 'social'
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }
                  `}
                >
                  Social Media {profile && (profile as CreatorProfileDetail).platforms ? `(${(profile as CreatorProfileDetail).platforms.length})` : ''}
                </button>
              )}
              {isHotel && (
                <button
                  onClick={() => setActiveTab('listings')}
                  className={`
                    py-4 px-6 border-b-2 font-medium text-sm
                    ${activeTab === 'listings'
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }
                  `}
                >
                  Listings {profile && (profile as HotelProfileDetail).listings ? `(${(profile as HotelProfileDetail).listings.length})` : ''}
                </button>
              )}
            </nav>
          </div>

          {/* Tab Content */}
          <div className="px-6 py-6">
            {/* Profile Tab */}
            {activeTab === 'profile' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Account Information</h3>
                  <p className="text-sm text-gray-600 mb-4">User account and authentication details</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Account Email</label>
                      <p className="mt-1 text-sm text-gray-900">{userDetail.email}</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">User Type</label>
                      <p className="mt-1">
                        <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getTypeBadgeColor(userDetail.type)}`}>
                          {userDetail.type}
                        </span>
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Account Status</label>
                      <p className="mt-1">
                        <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(userDetail.status)}`}>
                          {userDetail.status}
                        </span>
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Email Verified</label>
                      <p className="mt-1 text-sm text-gray-900">
                        {userDetail.emailVerified ? (
                          <span className="text-green-600 font-medium">Yes</span>
                        ) : (
                          <span className="text-gray-400">No</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Account Created</label>
                      <p className="mt-1 text-sm text-gray-900">
                        {userDetail.createdAt ? new Date(userDetail.createdAt).toLocaleString() : '-'}
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Last Updated</label>
                      <p className="mt-1 text-sm text-gray-900">
                        {userDetail.updatedAt ? new Date(userDetail.updatedAt).toLocaleString() : '-'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Creator Profile Section */}
                {isCreator && profile && (
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Creator Business Information</h3>
                    <p className="text-sm text-gray-600 mb-4">Creator-specific profile and business details</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Location</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as CreatorProfileDetail).location || '-'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Phone</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as CreatorProfileDetail).phone || '-'}
                        </p>
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700">Short Description</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as CreatorProfileDetail).shortDescription || '-'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Portfolio Link</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as CreatorProfileDetail).portfolioLink ? (
                            <a 
                              href={(profile as CreatorProfileDetail).portfolioLink!} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              {(profile as CreatorProfileDetail).portfolioLink}
                            </a>
                          ) : (
                            '-'
                          )}
                        </p>
                      </div>
                      {(profile as CreatorProfileDetail).profilePicture && (
                        <div className="md:col-span-2">
                          <label className="block text-sm font-medium text-gray-700 mb-2">Profile Picture</label>
                          <img 
                            src={(profile as CreatorProfileDetail).profilePicture!} 
                            alt="Profile" 
                            className="h-32 w-32 rounded-lg object-cover border border-gray-300"
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Profile Complete</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as CreatorProfileDetail).profileComplete ? (
                            <span className="text-green-600 font-medium">Yes</span>
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Hotel Profile Section */}
                {isHotel && profile && (
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Hotel Business Information</h3>
                    <p className="text-sm text-gray-600 mb-4">Hotel-specific business details and contact information</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Hotel Name</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as HotelProfileDetail).name || '-'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Category</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as HotelProfileDetail).category || '-'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Location</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as HotelProfileDetail).location || '-'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Business Email</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as HotelProfileDetail).email || '-'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Phone</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as HotelProfileDetail).phone || '-'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Website</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as HotelProfileDetail).website ? (
                            <a 
                              href={(profile as HotelProfileDetail).website!} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              {(profile as HotelProfileDetail).website}
                            </a>
                          ) : (
                            '-'
                          )}
                        </p>
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700">About</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {(profile as HotelProfileDetail).about || '-'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Profile Status</label>
                        <p className="mt-1">
                          <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor((profile as HotelProfileDetail).status)}`}>
                            {(profile as HotelProfileDetail).status}
                          </span>
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {!profile && (
                  <div className="border-t pt-6">
                    <p className="text-sm text-gray-500">No profile information available</p>
                  </div>
                )}
              </div>
            )}

            {/* Social Media Tab */}
            {activeTab === 'social' && isCreator && profile && (
              <div className="space-y-4">
                {(profile as CreatorProfileDetail).platforms && (profile as CreatorProfileDetail).platforms.length > 0 ? (
                  <div className="space-y-4">
                    {(profile as CreatorProfileDetail).platforms.map((platform: PlatformResponse) => (
                      <div key={platform.id} className="border rounded-lg p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <h4 className="text-lg font-semibold text-gray-900">{platform.name}</h4>
                              <span className="px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                                @{platform.handle}
                              </span>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                              <div>
                                <p className="text-xs text-gray-500">Followers</p>
                                <p className="text-sm font-medium text-gray-900">
                                  {platform.followers.toLocaleString()}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-500">Engagement Rate</p>
                                <p className="text-sm font-medium text-gray-900">
                                  {platform.engagementRate.toFixed(2)}%
                                </p>
                              </div>
                              {platform.genderSplit && (
                                <>
                                  <div>
                                    <p className="text-xs text-gray-500">Male</p>
                                    <p className="text-sm font-medium text-gray-900">
                                      {platform.genderSplit.male.toFixed(1)}%
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-500">Female</p>
                                    <p className="text-sm font-medium text-gray-900">
                                      {platform.genderSplit.female.toFixed(1)}%
                                    </p>
                                  </div>
                                </>
                              )}
                            </div>
                            {platform.topCountries && platform.topCountries.length > 0 && (
                              <div className="mt-4">
                                <p className="text-xs text-gray-500 mb-2">Top Countries</p>
                                <div className="flex flex-wrap gap-2">
                                  {platform.topCountries.slice(0, 5).map((country, idx) => (
                                    <span key={idx} className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded">
                                      {country.country} ({country.percentage.toFixed(1)}%)
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {platform.topAgeGroups && platform.topAgeGroups.length > 0 && (
                              <div className="mt-4">
                                <p className="text-xs text-gray-500 mb-2">Top Age Groups</p>
                                <div className="flex flex-wrap gap-2">
                                  {platform.topAgeGroups.slice(0, 5).map((age, idx) => (
                                    <span key={idx} className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded">
                                      {age.ageRange}
                                      {age.percentage != null && typeof age.percentage === 'number' && ` (${age.percentage.toFixed(1)}%)`}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <p className="text-gray-500">No social media platforms found</p>
                  </div>
                )}
              </div>
            )}

            {/* Listings Tab */}
            {activeTab === 'listings' && isHotel && profile && (
              <div className="space-y-4">
                {(profile as HotelProfileDetail).listings && (profile as HotelProfileDetail).listings.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {(profile as HotelProfileDetail).listings.map((listing: ListingResponse) => (
                      <div 
                        key={listing.id} 
                        className="border rounded-lg overflow-hidden hover:shadow-lg transition-shadow cursor-pointer"
                        onClick={() => setSelectedListing(listing)}
                      >
                        {listing.images && listing.images.length > 0 && (
                          <div className="aspect-video bg-gray-200 relative">
                            <img 
                              src={listing.images[0]} 
                              alt={listing.name}
                              className="w-full h-full object-cover"
                            />
                            {listing.images.length > 1 && (
                              <div className="absolute top-2 right-2 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded">
                                +{listing.images.length - 1} more
                              </div>
                            )}
                          </div>
                        )}
                        <div className="p-4">
                          <h4 className="font-semibold text-gray-900 mb-1">{listing.name}</h4>
                          <p className="text-sm text-gray-600 mb-2">{listing.location}</p>
                          {listing.description && (
                            <p className="text-sm text-gray-500 mb-2 line-clamp-2">{listing.description}</p>
                          )}
                          <div className="flex items-center justify-between mt-3">
                            <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(listing.status)}`}>
                              {listing.status}
                            </span>
                            {listing.accommodationType && (
                              <span className="text-xs text-gray-500">{listing.accommodationType}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <p className="text-gray-500">No listings found</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Listing Detail Modal */}
        {selectedListing && (
          <Modal
            isOpen={!!selectedListing}
            onClose={() => setSelectedListing(null)}
            title="Listing Details"
            size="xl"
          >
            <div className="space-y-6">
              {/* Listing Images */}
              {selectedListing.images && selectedListing.images.length > 0 && (
                <div>
                  <div className="grid grid-cols-2 gap-2">
                    {selectedListing.images.slice(0, 4).map((image, idx) => (
                      <div key={idx} className="aspect-video bg-gray-200 rounded-lg overflow-hidden">
                        <img 
                          src={image} 
                          alt={`${selectedListing.name} ${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                  {selectedListing.images.length > 4 && (
                    <p className="text-xs text-gray-500 mt-2">
                      +{selectedListing.images.length - 4} more images
                    </p>
                  )}
                </div>
              )}

              {/* Basic Information */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Listing Name</label>
                    <p className="mt-1 text-sm text-gray-900">{selectedListing.name}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Location</label>
                    <p className="mt-1 text-sm text-gray-900">{selectedListing.location}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Accommodation Type</label>
                    <p className="mt-1 text-sm text-gray-900">
                      {selectedListing.accommodationType || '-'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Status</label>
                    <p className="mt-1">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(selectedListing.status)}`}>
                        {selectedListing.status}
                      </span>
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Created At</label>
                    <p className="mt-1 text-sm text-gray-900">
                      {selectedListing.createdAt ? new Date(selectedListing.createdAt).toLocaleString() : '-'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Updated At</label>
                    <p className="mt-1 text-sm text-gray-900">
                      {selectedListing.updatedAt ? new Date(selectedListing.updatedAt).toLocaleString() : '-'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Description */}
              {selectedListing.description && (
                <div className="border-t pt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
                  <p className="text-sm text-gray-900 whitespace-pre-wrap">{selectedListing.description}</p>
                </div>
              )}

              {/* Collaboration Offerings */}
              <div className="border-t pt-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Collaboration Offerings</h3>
                {selectedListing.collaborationOfferings && selectedListing.collaborationOfferings.length > 0 ? (
                  <div className="space-y-4">
                    {selectedListing.collaborationOfferings.map((offering) => (
                      <div key={offering.id} className="border rounded-lg p-4 bg-gray-50">
                        <div className="flex items-center gap-2 mb-4">
                          <span className={`px-3 py-1 text-sm font-semibold rounded-full ${
                            offering.collaborationType === 'Free Stay' ? 'bg-green-100 text-green-800' :
                            offering.collaborationType === 'Paid' ? 'bg-blue-100 text-blue-800' :
                            'bg-yellow-100 text-yellow-800'
                          }`}>
                            {offering.collaborationType}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Platforms */}
                          {offering.platforms && offering.platforms.length > 0 && (
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-gray-700 mb-2">Platforms</label>
                              <div className="flex flex-wrap gap-2">
                                {offering.platforms.map((platform, idx) => (
                                  <span key={idx} className="px-3 py-1 text-sm bg-blue-100 text-blue-800 rounded-full">
                                    {platform}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          
                          {/* Availability Months */}
                          {offering.availabilityMonths && offering.availabilityMonths.length > 0 && (
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-gray-700 mb-2">Availability Months</label>
                              <div className="flex flex-wrap gap-2">
                                {offering.availabilityMonths.map((month, idx) => (
                                  <span key={idx} className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded-full">
                                    {month}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Type-specific fields */}
                          {offering.collaborationType === 'Free Stay' && (
                            <>
                              {offering.freeStayMinNights !== null && (
                                <div>
                                  <label className="block text-sm font-medium text-gray-700">Minimum Nights</label>
                                  <p className="mt-1 text-sm text-gray-900">{offering.freeStayMinNights} nights</p>
                                </div>
                              )}
                              {offering.freeStayMaxNights !== null && (
                                <div>
                                  <label className="block text-sm font-medium text-gray-700">Maximum Nights</label>
                                  <p className="mt-1 text-sm text-gray-900">{offering.freeStayMaxNights} nights</p>
                                </div>
                              )}
                            </>
                          )}

                          {offering.collaborationType === 'Paid' && offering.paidMaxAmount !== null && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700">Maximum Amount</label>
                              <p className="mt-1 text-sm text-gray-900">${offering.paidMaxAmount.toLocaleString()}</p>
                            </div>
                          )}

                          {offering.collaborationType === 'Discount' && offering.discountPercentage !== null && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700">Discount Percentage</label>
                              <p className="mt-1 text-sm text-gray-900">{offering.discountPercentage}%</p>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No collaboration offerings available</p>
                )}
              </div>

              {/* Creator Requirements */}
              <div className="border-t pt-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Creator Requirements</h3>
                {selectedListing.creatorRequirements ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Platforms */}
                    {selectedListing.creatorRequirements.platforms && selectedListing.creatorRequirements.platforms.length > 0 && (
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-2">Required Platforms</label>
                        <div className="flex flex-wrap gap-2">
                          {selectedListing.creatorRequirements.platforms.map((platform, idx) => (
                            <span key={idx} className="px-3 py-1 text-sm bg-blue-100 text-blue-800 rounded-full">
                              {platform}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Minimum Followers */}
                    {selectedListing.creatorRequirements.minFollowers !== null && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Minimum Followers</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {selectedListing.creatorRequirements.minFollowers.toLocaleString()}
                        </p>
                      </div>
                    )}
                    
                    {/* Age Range */}
                    {selectedListing.creatorRequirements.targetAgeMin !== null && selectedListing.creatorRequirements.targetAgeMax !== null ? (
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Target Age Range</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {selectedListing.creatorRequirements.targetAgeMin} - {selectedListing.creatorRequirements.targetAgeMax} years
                        </p>
                      </div>
                    ) : selectedListing.creatorRequirements.targetAgeMin !== null ? (
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Minimum Age</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {selectedListing.creatorRequirements.targetAgeMin} years
                        </p>
                      </div>
                    ) : selectedListing.creatorRequirements.targetAgeMax !== null ? (
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Maximum Age</label>
                        <p className="mt-1 text-sm text-gray-900">
                          {selectedListing.creatorRequirements.targetAgeMax} years
                        </p>
                      </div>
                    ) : null}
                    
                    {/* Target Countries */}
                    {selectedListing.creatorRequirements.targetCountries && selectedListing.creatorRequirements.targetCountries.length > 0 && (
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-2">Target Countries</label>
                        <div className="flex flex-wrap gap-2">
                          {selectedListing.creatorRequirements.targetCountries.map((country, idx) => (
                            <span key={idx} className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded-full">
                              {country}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Show message if no requirements are set */}
                    {(!selectedListing.creatorRequirements.platforms || selectedListing.creatorRequirements.platforms.length === 0) && 
                     selectedListing.creatorRequirements.minFollowers === null && 
                     selectedListing.creatorRequirements.targetAgeMin === null && 
                     selectedListing.creatorRequirements.targetAgeMax === null &&
                     (!selectedListing.creatorRequirements.targetCountries || selectedListing.creatorRequirements.targetCountries.length === 0) && (
                      <div className="md:col-span-2">
                        <p className="text-sm text-gray-500">No specific requirements set</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No creator requirements specified</p>
                )}
              </div>

              {/* All Images */}
              {selectedListing.images && selectedListing.images.length > 0 && (
                <div className="border-t pt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-4">All Images ({selectedListing.images.length})</label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {selectedListing.images.map((image, idx) => (
                      <div key={idx} className="aspect-square bg-gray-200 rounded-lg overflow-hidden">
                        <img 
                          src={image} 
                          alt={`${selectedListing.name} image ${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => setSelectedListing(null)}
                >
                  Close
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && userDetail && (
          <Modal
            isOpen={showDeleteConfirm}
            onClose={() => {
              setShowDeleteConfirm(false)
              setDeleteError('')
            }}
            title="Delete User"
            size="md"
          >
            <div className="space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-sm font-medium text-red-800">
                  ⚠️ Warning: This action cannot be undone!
                </p>
              </div>

              <div>
                <p className="text-sm text-gray-700 mb-2">
                  Are you sure you want to delete this user? This will permanently delete:
                </p>
                <ul className="list-disc list-inside text-sm text-gray-600 space-y-1 ml-4">
                  <li>User account: <strong>{userDetail.name}</strong> ({userDetail.email})</li>
                  {userDetail.type === 'creator' && (
                    <li>Creator profile and all social media platforms</li>
                  )}
                  {userDetail.type === 'hotel' && (
                    <li>Hotel profile and all listings with their offerings and requirements</li>
                  )}
                  <li>All associated S3 images (profile pictures, listing images, thumbnails)</li>
                  <li>All related records</li>
                </ul>
              </div>

              {deleteError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-800">{deleteError}</p>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowDeleteConfirm(false)
                    setDeleteError('')
                  }}
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleDeleteUser}
                  disabled={deleting}
                  className="bg-red-600 hover:bg-red-700"
                >
                  {deleting ? 'Deleting...' : 'Delete User'}
                </Button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </div>
  )
}
