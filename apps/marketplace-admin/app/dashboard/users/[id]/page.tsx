'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui'
import { Modal } from '@/components/ui/Modal'
import { UserIcon, ArrowLeftIcon, TrashIcon, PencilIcon, XMarkIcon, PhotoIcon, PlusIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline'
import { usersService, uploadService } from '@/services/api'
import { Input } from '@/components/ui'
import { Textarea } from '@/components/ui/Textarea'
import { ApiErrorResponse } from '@/services/api/client'
import type { UserDetailResponse, CreatorProfileDetail, HotelProfileDetail, PlatformResponse, ListingResponse, CollaborationOffering, CreatorRequirements } from '@/lib/types'

const PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'Facebook'] as const
const AGE_GROUPS = ['18-24', '25-34', '35-44', '45-54', '55+'] as const
const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Argentina', 'Australia', 'Austria',
  'Bangladesh', 'Belgium', 'Brazil', 'Bulgaria', 'Canada', 'Chile', 'China',
  'Colombia', 'Croatia', 'Czech Republic', 'Denmark', 'Egypt', 'Finland',
  'France', 'Germany', 'Greece', 'Hungary', 'India', 'Indonesia', 'Iran',
  'Ireland', 'Israel', 'Italy', 'Japan', 'Kenya', 'Malaysia', 'Mexico',
  'Morocco', 'Netherlands', 'New Zealand', 'Nigeria', 'Norway', 'Pakistan',
  'Philippines', 'Poland', 'Portugal', 'Romania', 'Russia', 'Saudi Arabia',
  'Singapore', 'South Africa', 'South Korea', 'Spain', 'Sweden', 'Switzerland',
  'Thailand', 'Turkey', 'Ukraine', 'United Arab Emirates', 'United Kingdom',
  'United States', 'Vietnam'
].sort()

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
  
  // Edit mode state
  const [isEditing, setIsEditing] = useState(false)
  const [editFormData, setEditFormData] = useState({
    name: '',
    email: '',
    location: '',
    shortDescription: '',
    portfolioLink: '',
    phone: '',
    status: 'pending' as 'pending' | 'verified' | 'rejected' | 'suspended',
    emailVerified: false,
  })
  const [editPlatforms, setEditPlatforms] = useState<any[]>([])
  const [profilePictureFile, setProfilePictureFile] = useState<File | null>(null)
  const [profilePicturePreview, setProfilePicturePreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveSuccess, setSaveSuccess] = useState('')
  
  // Platform editing state for optional fields
  const [platformCountrySearch, setPlatformCountrySearch] = useState<{ [platformIndex: number]: string }>({})
  const [platformCountryDropdownOpen, setPlatformCountryDropdownOpen] = useState<{ [platformIndex: number]: boolean }>({})
  const platformCountryDropdownRefs = useRef<{ [platformIndex: number]: HTMLDivElement | null }>({})

  useEffect(() => {
    loadUserDetail()
  }, [userId])

  // Initialize edit form when entering edit mode
  useEffect(() => {
    if (isEditing && userDetail) {
      // Initialize account fields (for all user types)
      const baseFormData = {
        name: userDetail.name || '',
        email: userDetail.email || '',
        status: userDetail.status || 'pending',
        emailVerified: userDetail.emailVerified || false,
        location: '',
        shortDescription: '',
        portfolioLink: '',
        phone: '',
      }

      // Initialize profile fields (only for creators)
      if (userDetail.type === 'creator' && userDetail.profile) {
        const profile = userDetail.profile as CreatorProfileDetail
        setEditFormData({
          ...baseFormData,
          location: profile.location || '',
          shortDescription: profile.shortDescription || '',
          portfolioLink: profile.portfolioLink || '',
          phone: profile.phone || '',
        })
        setEditPlatforms(profile.platforms ? profile.platforms.map((p: PlatformResponse) => ({
          id: p.id,
          name: p.name,
          handle: p.handle,
          followers: p.followers.toString(),
          engagementRate: p.engagementRate.toString(),
          topCountries: (p.topCountries || []).map((tc: { country: string; percentage: number }) => ({
            country: tc.country,
            percentage: tc.percentage ? tc.percentage.toString() : '',
          })),
          topAgeGroups: (p.topAgeGroups || []).map((ag: { ageRange: string; percentage?: number | null }) => ({
            ageRange: ag.ageRange,
          })),
          genderSplit: p.genderSplit ? {
            male: p.genderSplit.male ? p.genderSplit.male.toString() : '',
            female: p.genderSplit.female ? p.genderSplit.female.toString() : '',
          } : { male: '', female: '' },
          showAdvanced: false,
        })) : [])
        setProfilePicturePreview(profile.profilePicture || null)
      } else {
        // For non-creators, just set the base form data
        setEditFormData(baseFormData)
        setEditPlatforms([])
        setProfilePicturePreview(null)
      }
    }
  }, [isEditing, userDetail])

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

  const handleDeleteUser = async () => {
    if (!userDetail) return

    try {
      setDeleting(true)
      setDeleteError('')

      await usersService.deleteUser(userDetail.id)

      // Redirect to dashboard after successful deletion
      router.push('/dashboard')
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        if (err.status === 400) {
          setDeleteError('Cannot delete your own account.')
        } else if (err.status === 404) {
          setDeleteError('User not found.')
        } else if (err.status === 403) {
          setDeleteError('Access denied. Admin privileges required.')
        } else {
          setDeleteError(err.data.detail as string || 'Failed to delete user.')
        }
      } else {
        setDeleteError('Failed to delete user. Please try again.')
      }
    } finally {
      setDeleting(false)
    }
  }

  const handleEditFormChange = (field: string, value: string) => {
    setEditFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleProfilePictureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setSaveError('Please select an image file')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setSaveError('Image size must be less than 5MB')
      return
    }

    setSaveError('')
    setProfilePictureFile(file)

    const reader = new FileReader()
    reader.onloadend = () => {
      setProfilePicturePreview(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  const handleRemoveProfilePicture = () => {
    setProfilePictureFile(null)
    setProfilePicturePreview(null)
  }

  const handleSaveEdit = async () => {
    if (!userDetail) return

    try {
      setSaving(true)
      setSaveError('')
      setSaveSuccess('')

      // Update account fields (status, emailVerified, email, name) for all user types
      const accountUpdateData: any = {}
      if (editFormData.status !== userDetail.status) {
        accountUpdateData.status = editFormData.status
      }
      if (editFormData.emailVerified !== userDetail.emailVerified) {
        accountUpdateData.emailVerified = editFormData.emailVerified
      }
      if (editFormData.email !== userDetail.email) {
        accountUpdateData.email = editFormData.email
      }
      if (editFormData.name !== userDetail.name) {
        accountUpdateData.name = editFormData.name
      }

      // Update account fields if there are changes
      if (Object.keys(accountUpdateData).length > 0) {
        await usersService.updateUser(userDetail.id, accountUpdateData)
      }

      // Update creator profile fields (only for creators)
      if (userDetail.type === 'creator' && userDetail.profile) {
        const profileUpdateData: any = {}

        if (editFormData.location !== (userDetail.profile as CreatorProfileDetail)?.location) {
          profileUpdateData.location = editFormData.location || null
        }
        if (editFormData.shortDescription !== (userDetail.profile as CreatorProfileDetail)?.shortDescription) {
          profileUpdateData.shortDescription = editFormData.shortDescription || null
        }
        if (editFormData.portfolioLink !== (userDetail.profile as CreatorProfileDetail)?.portfolioLink) {
          profileUpdateData.portfolioLink = editFormData.portfolioLink || null
        }
        if (editFormData.phone !== (userDetail.profile as CreatorProfileDetail)?.phone) {
          profileUpdateData.phone = editFormData.phone || null
        }

        // Handle profile picture upload if changed
        if (profilePictureFile) {
          const uploadResponse = await uploadService.uploadCreatorProfileImage(
            profilePictureFile,
            userDetail.id
          )
          profileUpdateData.profilePicture = uploadResponse.url
        }

        // Handle platforms - always include when in edit mode (even if empty array to allow clearing all)
        // Filter out invalid platforms and map to API format
        profileUpdateData.platforms = editPlatforms
          .filter(p => p.handle && p.followers && p.engagementRate)
          .map(p => {
              const platformData: any = {
                name: p.name,
                handle: p.handle,
                followers: parseInt(p.followers) || 0,
                engagementRate: parseFloat(p.engagementRate) || 0,
              }

              if (p.topCountries && p.topCountries.length > 0) {
                const validCountries = p.topCountries.filter((tc: { country: string; percentage: string }) => tc.country && (tc.percentage || tc.percentage === '0'))
                if (validCountries.length > 0) {
                  platformData.topCountries = validCountries.map((tc: { country: string; percentage: string }) => ({
                    country: tc.country,
                    percentage: parseFloat(tc.percentage) || 0,
                  }))
                }
              }

              if (p.topAgeGroups && p.topAgeGroups.length > 0) {
                const validAgeGroups = p.topAgeGroups.filter((ag: { ageRange: string }) => ag.ageRange)
                if (validAgeGroups.length > 0) {
                  platformData.topAgeGroups = validAgeGroups.map((ag: { ageRange: string }) => ({
                    ageRange: ag.ageRange,
                  }))
                }
              }

              if (p.genderSplit && (p.genderSplit.male || p.genderSplit.female)) {
                platformData.genderSplit = {
                  male: p.genderSplit.male ? parseFloat(p.genderSplit.male) : 0,
                  female: p.genderSplit.female ? parseFloat(p.genderSplit.female) : 0,
                }
              }

              return platformData
            })

        await usersService.updateCreatorProfile(userDetail.id, profileUpdateData)
      }

      // Reload user details
      await loadUserDetail()
      
      // Exit edit mode
      setIsEditing(false)
      setProfilePictureFile(null)
      setProfilePicturePreview(null)
      
      setSaveSuccess('Profile updated successfully!')
      setTimeout(() => setSaveSuccess(''), 5000)
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        if (err.status === 400) {
          setSaveError(err.data.detail as string || 'Validation error')
        } else if (err.status === 404) {
          setSaveError('User or profile not found')
        } else if (err.status === 403) {
          setSaveError('Access denied. Admin privileges required.')
        } else {
          setSaveError(err.data.detail as string || 'Failed to update profile')
        }
      } else {
        setSaveError('Failed to update profile. Please try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setProfilePictureFile(null)
    setProfilePicturePreview(null)
    setSaveError('')
    setSaveSuccess('')
  }

  const handleAddPlatform = () => {
    setEditPlatforms(prev => [...prev, {
      name: 'Instagram',
      handle: '',
      followers: '',
      engagementRate: '',
      topCountries: [],
      topAgeGroups: [],
      genderSplit: { male: '', female: '' },
      showAdvanced: false,
    }])
  }

  const handleRemovePlatform = (index: number) => {
    setEditPlatforms(prev => prev.filter((_, i) => i !== index))
  }

  const handlePlatformChange = (index: number, field: string, value: any) => {
    setEditPlatforms(prev => prev.map((p, i) => 
      i === index ? { ...p, [field]: value } : p
    ))
  }

  const handlePlatformCountrySearchChange = (platformIndex: number, value: string) => {
    setPlatformCountrySearch(prev => ({ ...prev, [platformIndex]: value }))
    setPlatformCountryDropdownOpen(prev => ({ ...prev, [platformIndex]: true }))
  }

  const handleSelectPlatformCountry = (platformIndex: number, country: string) => {
    const platform = editPlatforms[platformIndex]
    if (!platform) return

    if (platform.topCountries.length >= 3) return
    if (platform.topCountries.some((tc: { country: string; percentage: string }) => tc.country === country)) return

    setEditPlatforms(prev => prev.map((p, i) => 
      i === platformIndex 
        ? { 
            ...p, 
            topCountries: [...p.topCountries, { country, percentage: '' }] 
          }
        : p
    ))
    
    setPlatformCountrySearch(prev => ({ ...prev, [platformIndex]: '' }))
    setPlatformCountryDropdownOpen(prev => ({ ...prev, [platformIndex]: false }))
  }

  const handleRemovePlatformCountry = (platformIndex: number, country: string) => {
    setEditPlatforms(prev => prev.map((p, i) => 
      i === platformIndex 
        ? { 
            ...p, 
            topCountries: p.topCountries.filter((tc: { country: string; percentage: string }) => tc.country !== country) 
          }
        : p
    ))
  }

  const handleTopCountryPercentageChange = (platformIndex: number, country: string, percentage: string) => {
    setEditPlatforms(prev => prev.map((p, i) => 
      i === platformIndex 
        ? { 
            ...p, 
            topCountries: p.topCountries.map((tc: { country: string; percentage: string }) => 
              tc.country === country ? { ...tc, percentage } : tc
            )
          }
        : p
    ))
  }

  const handleTogglePlatformAgeGroup = (platformIndex: number, ageRange: string) => {
    setEditPlatforms(prev => prev.map((p, i) => {
      if (i !== platformIndex) return p
      
      const existingIndex = p.topAgeGroups.findIndex(ag => ag.ageRange === ageRange)
      
      if (existingIndex >= 0) {
        return {
          ...p,
          topAgeGroups: p.topAgeGroups.filter((_, ai) => ai !== existingIndex)
        }
      } else {
        if (p.topAgeGroups.length < 3) {
          return {
            ...p,
            topAgeGroups: [...p.topAgeGroups, { ageRange }]
          }
        }
        return p
      }
    }))
  }

  const handleGenderSplitChange = (platformIndex: number, field: 'male' | 'female', value: string) => {
    setEditPlatforms(prev => prev.map((p, i) => 
      i === platformIndex 
        ? { 
            ...p, 
            genderSplit: { ...p.genderSplit, [field]: value } 
          }
        : p
    ))
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      Object.keys(platformCountryDropdownRefs.current).forEach((key) => {
        const ref = platformCountryDropdownRefs.current[parseInt(key)]
        if (ref && !ref.contains(event.target as Node)) {
          setPlatformCountryDropdownOpen(prev => ({ ...prev, [parseInt(key)]: false }))
        }
      })
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

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
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditing(!isEditing)}
                  className={isEditing ? 'bg-gray-100' : ''}
                >
                  {isEditing ? (
                    <>
                      <XMarkIcon className="w-4 h-4 mr-2" />
                      Cancel Edit
                    </>
                  ) : (
                    <>
                      <PencilIcon className="w-4 h-4 mr-2" />
                      Edit
                    </>
                  )}
                </Button>
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
                      {isEditing ? (
                        <Input
                          type="email"
                          value={editFormData.email}
                          onChange={(e) => setEditFormData(prev => ({ ...prev, email: e.target.value }))}
                          placeholder="user@example.com"
                          className="mt-1"
                        />
                      ) : (
                        <p className="mt-1 text-sm text-gray-900">{userDetail.email}</p>
                      )}
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
                      {isEditing ? (
                        <select
                          value={editFormData.status}
                          onChange={(e) => setEditFormData(prev => ({ ...prev, status: e.target.value as any }))}
                          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
                        >
                          <option value="pending">Pending</option>
                          <option value="verified">Verified</option>
                          <option value="rejected">Rejected</option>
                          <option value="suspended">Suspended</option>
                        </select>
                      ) : (
                        <p className="mt-1">
                          <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(userDetail.status)}`}>
                            {userDetail.status}
                          </span>
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Email Verified</label>
                      {isEditing ? (
                        <div className="mt-1 flex items-center">
                          <input
                            type="checkbox"
                            checked={editFormData.emailVerified}
                            onChange={(e) => setEditFormData(prev => ({ ...prev, emailVerified: e.target.checked }))}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <label className="ml-2 block text-sm text-gray-700">
                            {editFormData.emailVerified ? 'Verified' : 'Not Verified'}
                          </label>
                        </div>
                      ) : (
                        <p className="mt-1 text-sm text-gray-900">
                          {userDetail.emailVerified ? (
                            <span className="text-green-600 font-medium">Yes</span>
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </p>
                      )}
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
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900">Creator Business Information</h3>
                        <p className="text-sm text-gray-600 mt-1">Creator-specific profile and business details</p>
                      </div>
                    </div>

                    {(saveError || saveSuccess) && (
                      <div className={`mb-4 p-3 rounded-lg ${saveError ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'}`}>
                        <p className={`text-sm ${saveError ? 'text-red-800' : 'text-green-800'}`}>
                          {saveError || saveSuccess}
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {isEditing ? (
                        <>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Name</label>
                            <Input
                              value={editFormData.name}
                              onChange={(e) => handleEditFormChange('name', e.target.value)}
                              placeholder="Creator name"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Location</label>
                            <Input
                              value={editFormData.location}
                              onChange={(e) => handleEditFormChange('location', e.target.value)}
                              placeholder="Location"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Phone</label>
                            <Input
                              value={editFormData.phone}
                              onChange={(e) => handleEditFormChange('phone', e.target.value)}
                              placeholder="Phone number"
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-gray-700 mb-2">Short Description</label>
                            <Textarea
                              value={editFormData.shortDescription}
                              onChange={(e) => handleEditFormChange('shortDescription', e.target.value)}
                              rows={3}
                              placeholder="Short description"
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-gray-700 mb-2">Portfolio Link</label>
                            <Input
                              type="url"
                              value={editFormData.portfolioLink}
                              onChange={(e) => handleEditFormChange('portfolioLink', e.target.value)}
                              placeholder="https://portfolio.com"
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-gray-700 mb-2">Profile Picture</label>
                            <div className="flex items-start gap-4">
                              {(profilePicturePreview || (profile as CreatorProfileDetail).profilePicture) && (
                                <div className="flex-shrink-0">
                                  <img 
                                    src={profilePicturePreview || (profile as CreatorProfileDetail).profilePicture!} 
                                    alt="Profile" 
                                    className="h-32 w-32 rounded-lg object-cover border border-gray-300"
                                  />
                                  {profilePictureFile && (
                                    <button
                                      type="button"
                                      onClick={handleRemoveProfilePicture}
                                      className="mt-2 text-sm text-red-600 hover:text-red-800"
                                    >
                                      Remove new image
                                    </button>
                                  )}
                                </div>
                              )}
                              <div className="flex-1">
                                <label
                                  htmlFor="profile-picture-upload"
                                  className="flex flex-col items-center justify-center w-full h-32 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100 transition-colors"
                                >
                                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                    <PhotoIcon className="w-8 h-8 mb-2 text-gray-400" />
                                    <p className="mb-2 text-sm text-gray-500">
                                      <span className="font-semibold">Click to upload</span> or drag and drop
                                    </p>
                                    <p className="text-xs text-gray-500">PNG, JPG, GIF up to 5MB</p>
                                  </div>
                                  <input
                                    id="profile-picture-upload"
                                    type="file"
                                    className="hidden"
                                    accept="image/*"
                                    onChange={handleProfilePictureChange}
                                  />
                                </label>
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
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
                        </>
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
                {isEditing ? (
                  <>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-semibold text-gray-900">Social Media Platforms</h3>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleAddPlatform}
                      >
                        <PlusIcon className="w-4 h-4 mr-1" />
                        Add Platform
                      </Button>
                    </div>
                    
                    {editPlatforms.length === 0 ? (
                      <p className="text-sm text-gray-500">No platforms added. Click "Add Platform" to add one.</p>
                    ) : (
                      <div className="space-y-4">
                        {editPlatforms.map((platform, index) => (
                          <div key={index} className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex items-center justify-between mb-4">
                              <h4 className="font-medium text-gray-900">Platform {index + 1}</h4>
                              <button
                                type="button"
                                onClick={() => handleRemovePlatform(index)}
                                className="text-red-600 hover:text-red-800"
                              >
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Platform</label>
                                <select
                                  value={platform.name}
                                  onChange={(e) => handlePlatformChange(index, 'name', e.target.value)}
                                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
                                >
                                  {PLATFORMS.map(p => (
                                    <option key={p} value={p}>{p}</option>
                                  ))}
                                </select>
                              </div>
                              <Input
                                label="Handle"
                                value={platform.handle}
                                onChange={(e) => handlePlatformChange(index, 'handle', e.target.value)}
                                placeholder="@username"
                                required
                              />
                              <Input
                                label="Followers"
                                type="number"
                                value={platform.followers}
                                onChange={(e) => handlePlatformChange(index, 'followers', e.target.value)}
                                placeholder="100000"
                                required
                              />
                              <Input
                                label="Engagement Rate (%)"
                                type="number"
                                step="0.1"
                                value={platform.engagementRate}
                                onChange={(e) => handlePlatformChange(index, 'engagementRate', e.target.value)}
                                placeholder="4.5"
                                required
                              />
                            </div>

                            {/* Advanced Options Toggle */}
                            <div className="mt-4 pt-4 border-t">
                              <button
                                type="button"
                                onClick={() => handlePlatformChange(index, 'showAdvanced', !platform.showAdvanced)}
                                className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
                              >
                                {platform.showAdvanced ? (
                                  <>
                                    <ChevronUpIcon className="w-4 h-4" />
                                    Hide Advanced Options
                                  </>
                                ) : (
                                  <>
                                    <ChevronDownIcon className="w-4 h-4" />
                                    Show Advanced Options
                                  </>
                                )}
                              </button>
                            </div>

                            {/* Advanced Options */}
                            {platform.showAdvanced && (
                              <div className="mt-4 space-y-6 pt-4 border-t">
                                {/* Top Countries */}
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-2">Top Countries</label>
                                  <p className="text-sm text-gray-500 mb-3">Select up to 3 countries with their audience percentage</p>
                                  
                                  {/* Country Search Input */}
                                  <div 
                                    ref={(el) => { platformCountryDropdownRefs.current[index] = el }}
                                    className="relative mb-4"
                                  >
                                    <input
                                      type="text"
                                      value={platformCountrySearch[index] || ''}
                                      onChange={(e) => handlePlatformCountrySearchChange(index, e.target.value)}
                                      onFocus={() => setPlatformCountryDropdownOpen(prev => ({ ...prev, [index]: true }))}
                                      placeholder="Search countries..."
                                      disabled={platform.topCountries.length >= 3}
                                      className="w-full px-4 py-3 border border-gray-300 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 placeholder-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
                                    />
                                    
                                    {/* Dropdown with filtered countries */}
                                    {platformCountryDropdownOpen[index] && (platformCountrySearch[index] || '').length > 0 && (
                                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                                        {COUNTRIES
                                          .filter(country => 
                                            country.toLowerCase().includes((platformCountrySearch[index] || '').toLowerCase()) &&
                                            !platform.topCountries.some((tc: { country: string; percentage: string }) => tc.country === country)
                                          )
                                          .slice(0, 10)
                                          .map((country) => (
                                            <button
                                              key={country}
                                              type="button"
                                              onClick={() => handleSelectPlatformCountry(index, country)}
                                              className="w-full px-4 py-2 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none text-gray-900"
                                            >
                                              {country}
                                            </button>
                                          ))}
                                        {COUNTRIES.filter(country => 
                                          country.toLowerCase().includes((platformCountrySearch[index] || '').toLowerCase()) &&
                                          !platform.topCountries.some((tc: { country: string; percentage: string }) => tc.country === country)
                                        ).length === 0 && (
                                          <div className="px-4 py-2 text-sm text-gray-500">No countries found</div>
                                        )}
                                      </div>
                                    )}
                                  </div>

                                  {/* Selected Countries */}
                                  {platform.topCountries.length > 0 && (
                                    <div className="space-y-3">
                                      {platform.topCountries.map((countryData) => (
                                        <div key={countryData.country} className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                                          <div className="flex items-center justify-between">
                                            <div className="flex-1">
                                              <div className="font-medium text-gray-900 mb-2">{countryData.country}</div>
                                              <div className="flex items-center gap-2">
                                                <label className="text-sm text-gray-600">Audience percentage</label>
                                                <div className="flex items-center gap-1">
                                                  <input
                                                    type="number"
                                                    step="0.1"
                                                    value={countryData.percentage}
                                                    onChange={(e) => handleTopCountryPercentageChange(index, countryData.country, e.target.value)}
                                                    placeholder="0"
                                                    className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                                                  />
                                                  <span className="text-sm text-gray-600">%</span>
                                                </div>
                                              </div>
                                            </div>
                                            <button
                                              type="button"
                                              onClick={() => handleRemovePlatformCountry(index, countryData.country)}
                                              className="ml-4 text-gray-400 hover:text-red-600 transition-colors"
                                            >
                                              <XMarkIcon className="w-5 h-5" />
                                            </button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>

                                {/* Top Age Groups */}
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-2">Age Groups</label>
                                  <p className="text-sm text-gray-500 mb-3">Select up to 3 age groups</p>
                                  
                                  {/* Age Group Selection Buttons */}
                                  <div className="flex flex-wrap gap-2 mb-4">
                                    {AGE_GROUPS.map((ageRange) => {
                                      const isSelected = platform.topAgeGroups.some((ag: { ageRange: string }) => ag.ageRange === ageRange)
                                      const isDisabled = !isSelected && platform.topAgeGroups.length >= 3
                                      
                                      return (
                                        <button
                                          key={ageRange}
                                          type="button"
                                          onClick={() => handleTogglePlatformAgeGroup(index, ageRange)}
                                          disabled={isDisabled}
                                          className={`
                                            px-4 py-2 rounded-full text-sm font-medium transition-colors
                                            ${isSelected 
                                              ? 'bg-blue-100 text-blue-700 border-2 border-blue-300' 
                                              : 'bg-white text-gray-700 border-2 border-gray-300 hover:border-gray-400'
                                            }
                                            ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                                          `}
                                        >
                                          {ageRange}
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>

                                {/* Gender Split */}
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-3">Gender Split (%)</label>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <Input
                                      label="Male"
                                      type="number"
                                      step="0.1"
                                      value={platform.genderSplit.male}
                                      onChange={(e) => handleGenderSplitChange(index, 'male', e.target.value)}
                                      placeholder="55.0"
                                    />
                                    <Input
                                      label="Female"
                                      type="number"
                                      step="0.1"
                                      value={platform.genderSplit.female}
                                      onChange={(e) => handleGenderSplitChange(index, 'female', e.target.value)}
                                      placeholder="40.0"
                                    />
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
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
                  </>
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

          {/* Edit Mode Save/Cancel Buttons - Fixed at bottom */}
          {isEditing && isCreator && (
            <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={handleCancelEdit}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveEdit}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          )}
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
