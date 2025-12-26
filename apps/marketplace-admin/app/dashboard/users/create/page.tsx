'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input } from '@/components/ui'
import { Textarea } from '@/components/ui/Textarea'
import { ArrowLeftIcon, PlusIcon, TrashIcon, PhotoIcon, ChevronDownIcon, ChevronUpIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { usersService, uploadService } from '@/services/api'
import { ApiErrorResponse } from '@/services/api/client'

const AGE_GROUPS = ['18-24', '25-34', '35-44', '45-54', '55+'] as const

// Common countries list
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

interface PlatformForm {
  name: 'Instagram' | 'TikTok' | 'YouTube' | 'Facebook'
  handle: string
  followers: string
  engagementRate: string
  // Optional fields
  topCountries: Array<{ country: string; percentage: string }>
  topAgeGroups: Array<{ ageRange: string }>
  genderSplit: { male: string; female: string }
  showAdvanced: boolean
}

export default function CreateUserPage() {
  const router = useRouter()
  const [userType, setUserType] = useState<'creator' | 'hotel'>('creator')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  
  // Basic user fields
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
    status: 'pending' as 'pending' | 'verified' | 'rejected' | 'suspended',
    emailVerified: false,
  })
  
  // Creator profile fields
  const [creatorProfile, setCreatorProfile] = useState({
    location: '',
    shortDescription: '',
    portfolioLink: '',
    phone: '',
    profilePicture: '',
  })
  
  // Profile picture upload state
  const [profilePictureFile, setProfilePictureFile] = useState<File | null>(null)
  const [profilePicturePreview, setProfilePicturePreview] = useState<string | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [uploadError, setUploadError] = useState('')
  
  // Platforms for creator
  const [platforms, setPlatforms] = useState<PlatformForm[]>([])
  const [countrySearch, setCountrySearch] = useState<{ [platformIndex: number]: string }>({})
  const [countryDropdownOpen, setCountryDropdownOpen] = useState<{ [platformIndex: number]: boolean }>({})
  const countryDropdownRefs = useRef<{ [platformIndex: number]: HTMLDivElement | null }>({})

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      Object.keys(countryDropdownRefs.current).forEach((key) => {
        const ref = countryDropdownRefs.current[parseInt(key)]
        if (ref && !ref.contains(event.target as Node)) {
          setCountryDropdownOpen(prev => ({ ...prev, [parseInt(key)]: false }))
        }
      })
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleBasicChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target
    if (type === 'checkbox') {
      setFormData(prev => ({ ...prev, [name]: (e.target as HTMLInputElement).checked }))
    } else {
      setFormData(prev => ({ ...prev, [name]: value }))
    }
  }

  const handleCreatorProfileChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target
    setCreatorProfile(prev => ({ ...prev, [name]: value }))
  }

  const handleAddPlatform = () => {
    setPlatforms(prev => [...prev, {
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
    setPlatforms(prev => prev.filter((_, i) => i !== index))
  }

  const handlePlatformChange = (index: number, field: keyof PlatformForm, value: string | boolean) => {
    setPlatforms(prev => prev.map((platform, i) => 
      i === index ? { ...platform, [field]: value } : platform
    ))
  }

  const handleGenderSplitChange = (index: number, field: 'male' | 'female', value: string) => {
    setPlatforms(prev => prev.map((platform, i) => 
      i === index ? { 
        ...platform, 
        genderSplit: { ...platform.genderSplit, [field]: value } 
      } : platform
    ))
  }

  const handleCountrySearchChange = (platformIndex: number, value: string) => {
    setCountrySearch(prev => ({ ...prev, [platformIndex]: value }))
    setCountryDropdownOpen(prev => ({ ...prev, [platformIndex]: true }))
  }

  const handleSelectCountry = (platformIndex: number, country: string) => {
    const platform = platforms[platformIndex]
    // Check if country is already selected or if we've reached the limit
    if (platform.topCountries.some(tc => tc.country === country) || platform.topCountries.length >= 3) {
      return
    }

    setPlatforms(prev => prev.map((platform, i) => 
      i === platformIndex 
        ? { ...platform, topCountries: [...platform.topCountries, { country, percentage: '' }] }
        : platform
    ))
    
    // Clear search and close dropdown
    setCountrySearch(prev => ({ ...prev, [platformIndex]: '' }))
    setCountryDropdownOpen(prev => ({ ...prev, [platformIndex]: false }))
  }

  const handleRemoveTopCountry = (platformIndex: number, country: string) => {
    setPlatforms(prev => prev.map((platform, i) => 
      i === platformIndex 
        ? { ...platform, topCountries: platform.topCountries.filter(tc => tc.country !== country) }
        : platform
    ))
  }

  const handleTopCountryPercentageChange = (platformIndex: number, country: string, percentage: string) => {
    setPlatforms(prev => prev.map((platform, i) => 
      i === platformIndex 
        ? { 
            ...platform, 
            topCountries: platform.topCountries.map(tc => 
              tc.country === country ? { ...tc, percentage } : tc
            )
          }
        : platform
    ))
  }

  const handleToggleAgeGroup = (platformIndex: number, ageRange: string) => {
    setPlatforms(prev => prev.map((platform, i) => {
      if (i !== platformIndex) return platform
      
      const existingIndex = platform.topAgeGroups.findIndex(ag => ag.ageRange === ageRange)
      
      if (existingIndex >= 0) {
        // Remove if already selected
        return {
          ...platform,
          topAgeGroups: platform.topAgeGroups.filter((_, ai) => ai !== existingIndex)
        }
      } else {
        // Add if not selected and less than 3
        if (platform.topAgeGroups.length < 3) {
          return {
            ...platform,
            topAgeGroups: [...platform.topAgeGroups, { ageRange }]
          }
        }
        return platform
      }
    }))
  }


  const handleProfilePictureChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setUploadError('Please select an image file')
      return
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('Image size must be less than 5MB')
      return
    }

    setUploadError('')
    setProfilePictureFile(file)

    // Create preview
    const reader = new FileReader()
    reader.onloadend = () => {
      setProfilePicturePreview(reader.result as string)
    }
    reader.readAsDataURL(file)

    // Upload image
    setUploadingImage(true)
    try {
      const imageUrl = await uploadService.uploadImage(file)
      setCreatorProfile(prev => ({ ...prev, profilePicture: imageUrl }))
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        setUploadError(err.data.detail as string || 'Failed to upload image')
      } else {
        setUploadError('Failed to upload image. Please try again.')
      }
      setProfilePictureFile(null)
      setProfilePicturePreview(null)
    } finally {
      setUploadingImage(false)
    }
  }

  const handleRemoveProfilePicture = () => {
    setProfilePictureFile(null)
    setProfilePicturePreview(null)
    setCreatorProfile(prev => ({ ...prev, profilePicture: '' }))
    setUploadError('')
  }

  const validateForm = (): boolean => {
    if (!formData.email || !formData.password || !formData.name) {
      setError('Email, password, and name are required')
      return false
    }
    
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters')
      return false
    }
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setError('Please enter a valid email address')
      return false
    }
    
    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    
    if (!validateForm()) {
      return
    }

    setLoading(true)

    try {
      const requestData: any = {
        email: formData.email,
        password: formData.password,
        name: formData.name,
        type: userType,
        status: formData.status,
        emailVerified: formData.emailVerified,
      }

      if (userType === 'creator') {
        requestData.creatorProfile = {
          ...(creatorProfile.location && { location: creatorProfile.location }),
          ...(creatorProfile.shortDescription && { shortDescription: creatorProfile.shortDescription }),
          ...(creatorProfile.portfolioLink && { portfolioLink: creatorProfile.portfolioLink }),
          ...(creatorProfile.phone && { phone: creatorProfile.phone }),
          ...(creatorProfile.profilePicture && { profilePicture: creatorProfile.profilePicture }),
        }

        // Add platforms if any
        if (platforms.length > 0) {
          requestData.creatorProfile.platforms = platforms
            .filter(p => p.handle && p.followers && p.engagementRate)
            .map(p => {
              const platformData: any = {
                name: p.name,
                handle: p.handle,
                followers: parseInt(p.followers) || 0,
                engagementRate: parseFloat(p.engagementRate) || 0,
              }

              // Add optional fields if provided
              if (p.topCountries && p.topCountries.length > 0) {
                const validCountries = p.topCountries.filter(tc => tc.country && tc.percentage)
                if (validCountries.length > 0) {
                  platformData.topCountries = validCountries.map(tc => ({
                    country: tc.country,
                    percentage: parseFloat(tc.percentage) || 0,
                  }))
                }
              }

              if (p.topAgeGroups && p.topAgeGroups.length > 0) {
                const validAgeGroups = p.topAgeGroups.filter(ag => ag.ageRange)
                if (validAgeGroups.length > 0) {
                  platformData.topAgeGroups = validAgeGroups.map(ag => ({
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
        }
      }

      const createdUser = await usersService.createUser(requestData)
      
      // Redirect to user detail page
      router.push(`/dashboard/users/${createdUser.id}`)
    } catch (err) {
      setLoading(false)
      if (err instanceof ApiErrorResponse) {
        if (err.status === 400) {
          const detail = err.data.detail
          if (Array.isArray(detail)) {
            const errorMessages = detail.map((d: any) => d.msg).join(', ')
            setError(errorMessages)
          } else {
            setError(detail as string || 'Validation error')
          }
        } else {
          setError(err.data.detail as string || 'Failed to create user')
        }
      } else {
        setError('Failed to create user. Please try again.')
      }
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center space-x-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/dashboard')}
            >
              <ArrowLeftIcon className="w-4 h-4 mr-2" />
              Back to Dashboard
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Create New User</h1>
              <p className="text-sm text-gray-600">Add a new creator or hotel to the system</p>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white shadow rounded-lg overflow-hidden">
            {/* User Type Selection */}
            <div className="px-6 py-4 border-b border-gray-200">
              <label className="block text-sm font-medium text-gray-700 mb-3">User Type</label>
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setUserType('creator')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    userType === 'creator'
                      ? 'bg-indigo-100 text-indigo-800 border-2 border-indigo-500'
                      : 'bg-gray-100 text-gray-700 border-2 border-transparent hover:bg-gray-200'
                  }`}
                >
                  Creator
                </button>
                <button
                  type="button"
                  onClick={() => setUserType('hotel')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    userType === 'hotel'
                      ? 'bg-blue-100 text-blue-800 border-2 border-blue-500'
                      : 'bg-gray-100 text-gray-700 border-2 border-transparent hover:bg-gray-200'
                  }`}
                >
                  Hotel
                </button>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="px-6 py-6 space-y-6">
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              )}

              {/* Basic Information */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Input
                    label="Name"
                    name="name"
                    value={formData.name}
                    onChange={handleBasicChange}
                    required
                    placeholder="John Doe"
                  />
                  <Input
                    label="Email"
                    name="email"
                    type="email"
                    value={formData.email}
                    onChange={handleBasicChange}
                    required
                    placeholder="user@example.com"
                  />
                  <Input
                    label="Password"
                    name="password"
                    type="password"
                    value={formData.password}
                    onChange={handleBasicChange}
                    required
                    placeholder="Minimum 8 characters"
                  />
                  <p className="mt-1 text-xs text-gray-500">Password must be at least 8 characters</p>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
                    <select
                      name="status"
                      value={formData.status}
                      onChange={handleBasicChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
                    >
                      <option value="pending">Pending</option>
                      <option value="verified">Verified</option>
                      <option value="rejected">Rejected</option>
                      <option value="suspended">Suspended</option>
                    </select>
                  </div>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="emailVerified"
                      name="emailVerified"
                      checked={formData.emailVerified}
                      onChange={handleBasicChange}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    />
                    <label htmlFor="emailVerified" className="ml-2 block text-sm text-gray-700">
                      Email Verified
                    </label>
                  </div>
                </div>
              </div>

              {/* Creator Profile Section */}
              {userType === 'creator' && (
                <>
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Creator Profile</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <Input
                        label="Location"
                        name="location"
                        value={creatorProfile.location}
                        onChange={handleCreatorProfileChange}
                        placeholder="New York, USA"
                      />
                      <Input
                        label="Phone"
                        name="phone"
                        type="tel"
                        value={creatorProfile.phone}
                        onChange={handleCreatorProfileChange}
                        placeholder="+1-555-1234"
                      />
                      <div className="md:col-span-2">
                        <Textarea
                          label="Short Description"
                          name="shortDescription"
                          value={creatorProfile.shortDescription}
                          onChange={handleCreatorProfileChange}
                          rows={3}
                          placeholder="Brief description about the creator"
                        />
                      </div>
                      <Input
                        label="Portfolio Link"
                        name="portfolioLink"
                        type="url"
                        value={creatorProfile.portfolioLink}
                        onChange={handleCreatorProfileChange}
                        placeholder="https://portfolio.com"
                      />
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Profile Picture (Optional)
                        </label>
                        {profilePicturePreview ? (
                          <div className="mt-2">
                            <div className="relative inline-block">
                              <img
                                src={profilePicturePreview}
                                alt="Profile preview"
                                className="h-32 w-32 object-cover rounded-lg border border-gray-300"
                              />
                              <button
                                type="button"
                                onClick={handleRemoveProfilePicture}
                                className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                              >
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </div>
                            {creatorProfile.profilePicture && (
                              <p className="mt-2 text-xs text-gray-500">
                                Image uploaded successfully
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="mt-2">
                            <label
                              htmlFor="profilePicture"
                              className="flex flex-col items-center justify-center w-full h-32 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100 transition-colors"
                            >
                              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                <PhotoIcon className="w-10 h-10 mb-2 text-gray-400" />
                                <p className="mb-2 text-sm text-gray-500">
                                  <span className="font-semibold">Click to upload</span> or drag and drop
                                </p>
                                <p className="text-xs text-gray-500">PNG, JPG, GIF up to 5MB</p>
                              </div>
                              <input
                                id="profilePicture"
                                type="file"
                                className="hidden"
                                accept="image/*"
                                onChange={handleProfilePictureChange}
                                disabled={uploadingImage}
                              />
                            </label>
                            {uploadingImage && (
                              <p className="mt-2 text-sm text-gray-600">Uploading image...</p>
                            )}
                            {uploadError && (
                              <p className="mt-2 text-sm text-red-600">{uploadError}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Social Media Platforms */}
                  <div className="border-t pt-6">
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
                    
                    {platforms.length === 0 ? (
                      <p className="text-sm text-gray-500">No platforms added. Click "Add Platform" to add one.</p>
                    ) : (
                      <div className="space-y-4">
                        {platforms.map((platform, index) => (
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
                                  <option value="Instagram">Instagram</option>
                                  <option value="TikTok">TikTok</option>
                                  <option value="YouTube">YouTube</option>
                                  <option value="Facebook">Facebook</option>
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
                                    ref={(el) => { countryDropdownRefs.current[index] = el }}
                                    className="relative mb-4"
                                  >
                                    <input
                                      type="text"
                                      value={countrySearch[index] || ''}
                                      onChange={(e) => handleCountrySearchChange(index, e.target.value)}
                                      onFocus={() => setCountryDropdownOpen(prev => ({ ...prev, [index]: true }))}
                                      placeholder="Search countries..."
                                      disabled={platform.topCountries.length >= 3}
                                      className="w-full px-4 py-3 border border-gray-300 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 placeholder-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
                                    />
                                    
                                    {/* Dropdown with filtered countries */}
                                    {countryDropdownOpen[index] && (countrySearch[index] || '').length > 0 && (
                                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                                        {COUNTRIES
                                          .filter(country => 
                                            country.toLowerCase().includes((countrySearch[index] || '').toLowerCase()) &&
                                            !platform.topCountries.some(tc => tc.country === country)
                                          )
                                          .slice(0, 10)
                                          .map((country) => (
                                            <button
                                              key={country}
                                              type="button"
                                              onClick={() => handleSelectCountry(index, country)}
                                              className="w-full px-4 py-2 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none text-gray-900"
                                            >
                                              {country}
                                            </button>
                                          ))}
                                        {COUNTRIES.filter(country => 
                                          country.toLowerCase().includes((countrySearch[index] || '').toLowerCase()) &&
                                          !platform.topCountries.some(tc => tc.country === country)
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
                                              onClick={() => handleRemoveTopCountry(index, countryData.country)}
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
                                  <p className="text-sm text-gray-500 mb-3">Select up to 3 age groups with their audience percentage</p>
                                  
                                  {/* Age Group Selection Buttons */}
                                  <div className="flex flex-wrap gap-2 mb-4">
                                    {AGE_GROUPS.map((ageRange) => {
                                      const isSelected = platform.topAgeGroups.some(ag => ag.ageRange === ageRange)
                                      const isDisabled = !isSelected && platform.topAgeGroups.length >= 3
                                      
                                      return (
                                        <button
                                          key={ageRange}
                                          type="button"
                                          onClick={() => handleToggleAgeGroup(index, ageRange)}
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

                                  {/* Selected Age Groups Display */}
                                  {platform.topAgeGroups.length > 0 && (
                                    <div className="mt-3">
                                      <p className="text-sm text-gray-600 mb-2">Selected age groups:</p>
                                      <div className="flex flex-wrap gap-2">
                                        {platform.topAgeGroups.map((ageGroup) => (
                                          <div
                                            key={ageGroup.ageRange}
                                            className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-100 text-blue-700 rounded-full text-sm font-medium"
                                          >
                                            <span>{ageGroup.ageRange}</span>
                                            <button
                                              type="button"
                                              onClick={() => handleToggleAgeGroup(index, ageGroup.ageRange)}
                                              className="text-blue-700 hover:text-red-600 transition-colors"
                                            >
                                              <XMarkIcon className="w-4 h-4" />
                                            </button>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
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
                  </div>
                </>
              )}

              {/* Submit Buttons */}
              <div className="flex justify-end gap-3 pt-6 border-t">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.push('/dashboard')}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={loading}
                >
                  {loading ? 'Creating...' : 'Create User'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}

