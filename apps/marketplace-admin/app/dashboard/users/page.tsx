'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { authService } from '@/services/auth'
import { usersService, socialMediaService, listingsService } from '@/services/api'
import { ApiErrorResponse } from '@/services/api/client'
import { Button, Input } from '@/components/ui'
import type { User, SocialMediaPlatform, Listing, CreatorProfile, HotelProfile } from '@/lib/types'
import {
  MagnifyingGlassIcon,
  PencilIcon,
  CheckCircleIcon,
  XCircleIcon,
  UserIcon,
  EyeIcon,
  XMarkIcon,
  PlusIcon,
  TrashIcon,
  LinkIcon,
} from '@heroicons/react/24/outline'

export default function UsersPage() {
  const router = useRouter()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'hotel' | 'creator' | 'admin'>('all')
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'verified' | 'rejected' | 'suspended'>('all')
  
  // Pagination
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  
  // Modals
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [viewingUser, setViewingUser] = useState<User | null>(null)
  const [editingStatus, setEditingStatus] = useState<{ user: User; newStatus: User['status'] } | null>(null)
  const [editForm, setEditForm] = useState({ name: '', email: '', status: '' as User['status'] })
  const [statusChangeReason, setStatusChangeReason] = useState('')
  const [creatingUser, setCreatingUser] = useState(false)
  const [deletingUser, setDeletingUser] = useState<User | null>(null)
  const [createForm, setCreateForm] = useState({
    name: '',
    email: '',
    password: '',
    type: 'creator' as User['type'],
    status: 'pending' as User['status'],
  })
  
  // Social Media & Listings
  const [userPlatforms, setUserPlatforms] = useState<SocialMediaPlatform[]>([])
  const [userListings, setUserListings] = useState<Listing[]>([])
  const [loadingPlatforms, setLoadingPlatforms] = useState(false)
  const [loadingListings, setLoadingListings] = useState(false)
  const [activeTab, setActiveTab] = useState<'profile' | 'social' | 'listings'>('profile')
  
  // Edit forms
  const [editingPlatform, setEditingPlatform] = useState<SocialMediaPlatform | null>(null)
  const [editingListing, setEditingListing] = useState<Listing | null>(null)
  const [addingPlatform, setAddingPlatform] = useState(false)
  const [addingListing, setAddingListing] = useState(false)
  const [platformForm, setPlatformForm] = useState({
    platform: 'instagram' as SocialMediaPlatform['platform'],
    handle: '',
    url: '',
    follower_count: '',
    verified: false,
  })
  const [listingForm, setListingForm] = useState({
    title: '',
    description: '',
    category: '',
    price: '',
    currency: 'USD',
    status: 'active' as Listing['status'],
    location: '',
    images: [] as string[],
  })
  const [profileForm, setProfileForm] = useState<Partial<CreatorProfile | HotelProfile>>({})

  useEffect(() => {
    if (!authService.isLoggedIn() || !authService.isAdmin()) {
      router.push('/login')
      return
    }

    loadUsers()
  }, [router, page, filterType, filterStatus])

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (page === 1) {
        loadUsers()
      } else {
        setPage(1) // Reset to page 1 when search changes
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [searchTerm])

  // Reset active tab if it's invalid for the current user type
  useEffect(() => {
    if (viewingUser) {
      if (viewingUser.type === 'creator' && activeTab === 'listings') {
        setActiveTab('profile')
      } else if (viewingUser.type === 'hotel' && activeTab === 'social') {
        setActiveTab('profile')
      } else if (viewingUser.type === 'admin' && (activeTab === 'social' || activeTab === 'listings')) {
        setActiveTab('profile')
      }
    }
    if (editingUser) {
      if (editingUser.type === 'creator' && activeTab === 'listings') {
        setActiveTab('profile')
      } else if (editingUser.type === 'hotel' && activeTab === 'social') {
        setActiveTab('profile')
      } else if (editingUser.type === 'admin' && (activeTab === 'social' || activeTab === 'listings')) {
        setActiveTab('profile')
      }
    }
  }, [viewingUser, editingUser, activeTab])

  const loadUsers = async () => {
    try {
      setLoading(true)
      setError('')
      
      const params: any = {
        page,
        page_size: pageSize,
      }
      if (filterType !== 'all') params.type = filterType
      if (filterStatus !== 'all') params.status = filterStatus
      if (searchTerm) params.search = searchTerm
      
      const response = await usersService.getAllUsers(params)
      setUsers(response.users || [])
      setTotal(response.total || 0)
      setTotalPages(response.total_pages || 0)
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        if (err.status === 404) {
          setError('Admin endpoints not yet configured. Please set up backend admin routes.')
        } else {
          setError(err.data.detail as string || 'Failed to load users')
        }
      } else {
        setError('Failed to load users')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    loadUsers()
  }

  const handleViewUser = async (user: User) => {
    try {
      const fullUser = await usersService.getUserById(user.id)
      setViewingUser(fullUser)
      setActiveTab('profile')
      
      // Load social media platforms only for creators
      if (fullUser.type === 'creator') {
        setLoadingPlatforms(true)
        try {
          const platforms = await socialMediaService.getUserPlatforms(user.id)
          setUserPlatforms(platforms)
        } catch (err) {
          console.error('Failed to load platforms:', err)
          setUserPlatforms([])
        } finally {
          setLoadingPlatforms(false)
        }
      } else {
        setUserPlatforms([])
      }
      
      // Load listings only for hotels
      if (fullUser.type === 'hotel') {
        setLoadingListings(true)
        try {
          const response = await listingsService.getUserListings(user.id)
          setUserListings(response.listings || [])
        } catch (err) {
          console.error('Failed to load listings:', err)
          setUserListings([])
        } finally {
          setLoadingListings(false)
        }
      } else {
        setUserListings([])
      }
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to load user details')
      } else {
        alert('Failed to load user details')
      }
    }
  }

  const handleEdit = async (user: User) => {
    try {
      const fullUser = await usersService.getUserById(user.id)
      setEditingUser(fullUser)
      setEditForm({
        name: fullUser.name,
        email: fullUser.email,
        status: fullUser.status,
      })
      
      // Properly set profile form based on user type
      if (fullUser.type === 'creator' && fullUser.creator_profile) {
        setProfileForm({
          location: fullUser.creator_profile.location || '',
          bio: fullUser.creator_profile.bio || '',
          website: fullUser.creator_profile.website || '',
          niche: fullUser.creator_profile.niche || '',
          follower_count: fullUser.creator_profile.follower_count || undefined,
        })
      } else if (fullUser.type === 'hotel' && fullUser.hotel_profile) {
        setProfileForm({
          hotel_name: fullUser.hotel_profile.hotel_name || '',
          address: fullUser.hotel_profile.address || '',
          city: fullUser.hotel_profile.city || '',
          country: fullUser.hotel_profile.country || '',
          phone: fullUser.hotel_profile.phone || '',
          website: fullUser.hotel_profile.website || '',
          star_rating: fullUser.hotel_profile.star_rating || undefined,
        })
      } else {
        setProfileForm({})
      }
      
      setActiveTab('profile')
      
      // Load social media platforms only for creators
      if (fullUser.type === 'creator') {
        try {
          const platforms = await socialMediaService.getUserPlatforms(user.id)
          setUserPlatforms(platforms)
        } catch (err) {
          console.error('Failed to load platforms:', err)
          setUserPlatforms([])
        }
      } else {
        setUserPlatforms([])
      }
      
      // Load listings only for hotels
      if (fullUser.type === 'hotel') {
        try {
          const response = await listingsService.getUserListings(user.id)
          setUserListings(response.listings || [])
        } catch (err) {
          console.error('Failed to load listings:', err)
          setUserListings([])
        }
      } else {
        setUserListings([])
      }
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to load user details')
      } else {
        alert('Failed to load user details')
      }
    }
  }

  const handleSaveEdit = async () => {
    if (!editingUser) return

    try {
      await usersService.updateUser(editingUser.id, {
        name: editForm.name,
        email: editForm.email,
        status: editForm.status,
        ...(editingUser.type === 'creator' && { creator_profile: profileForm as CreatorProfile }),
        ...(editingUser.type === 'hotel' && { hotel_profile: profileForm as HotelProfile }),
      })
      setEditingUser(null)
      setProfileForm({})
      loadUsers()
      if (viewingUser?.id === editingUser.id) {
        handleViewUser(editingUser)
      }
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to update user')
      } else {
        alert('Failed to update user')
      }
    }
  }

  // Social Media Platform Handlers
  const handleAddPlatform = () => {
    setPlatformForm({
      platform: 'instagram',
      handle: '',
      url: '',
      follower_count: '',
      verified: false,
    })
    setEditingPlatform(null)
    setAddingPlatform(true)
  }

  const handleEditPlatform = (platform: SocialMediaPlatform) => {
    setEditingPlatform(platform)
    setPlatformForm({
      platform: platform.platform,
      handle: platform.handle || '',
      url: platform.url || '',
      follower_count: platform.follower_count?.toString() || '',
      verified: platform.verified || false,
    })
  }

  const handleSavePlatform = async () => {
    if (!editingUser) return

    try {
      const data = {
        platform: platformForm.platform,
        handle: platformForm.handle || undefined,
        url: platformForm.url || undefined,
        follower_count: platformForm.follower_count ? parseInt(platformForm.follower_count) : undefined,
        verified: platformForm.verified,
      }

      if (editingPlatform) {
        await socialMediaService.updatePlatform(editingUser.id, editingPlatform.id, data)
      } else {
        await socialMediaService.createPlatform(editingUser.id, data)
      }

      const platforms = await socialMediaService.getUserPlatforms(editingUser.id)
      setUserPlatforms(platforms)
      setEditingPlatform(null)
      setAddingPlatform(false)
      setPlatformForm({
        platform: 'instagram',
        handle: '',
        url: '',
        follower_count: '',
        verified: false,
      })
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to save platform')
      } else {
        alert('Failed to save platform')
      }
    }
  }

  const handleDeletePlatform = async (platformId: string) => {
    if (!editingUser || !confirm('Are you sure you want to delete this platform?')) return

    try {
      await socialMediaService.deletePlatform(editingUser.id, platformId)
      const platforms = await socialMediaService.getUserPlatforms(editingUser.id)
      setUserPlatforms(platforms)
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to delete platform')
      } else {
        alert('Failed to delete platform')
      }
    }
  }

  // Listing Handlers
  const handleAddListing = () => {
    setListingForm({
      title: '',
      description: '',
      category: '',
      price: '',
      currency: 'USD',
      status: 'active',
      location: '',
      images: [],
    })
    setEditingListing(null)
    setAddingListing(true)
  }

  const handleEditListing = (listing: Listing) => {
    setEditingListing(listing)
    setListingForm({
      title: listing.title,
      description: listing.description || '',
      category: listing.category || '',
      price: listing.price?.toString() || '',
      currency: listing.currency || 'USD',
      status: listing.status || 'active',
      location: listing.location || '',
      images: listing.images || [],
    })
  }

  const handleSaveListing = async () => {
    if (!editingUser) return

    try {
      const data = {
        title: listingForm.title,
        description: listingForm.description || undefined,
        category: listingForm.category || undefined,
        price: listingForm.price ? parseFloat(listingForm.price) : undefined,
        currency: listingForm.currency,
        status: listingForm.status,
        location: listingForm.location || undefined,
        images: listingForm.images,
      }

      if (editingListing) {
        await listingsService.updateListing(editingUser.id, editingListing.id, data)
      } else {
        await listingsService.createListing(editingUser.id, data)
      }

      const response = await listingsService.getUserListings(editingUser.id)
      setUserListings(response.listings || [])
      setEditingListing(null)
      setAddingListing(false)
      setListingForm({
        title: '',
        description: '',
        category: '',
        price: '',
        currency: 'USD',
        status: 'active',
        location: '',
        images: [],
      })
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to save listing')
      } else {
        alert('Failed to save listing')
      }
    }
  }

  const handleDeleteListing = async (listingId: string) => {
    if (!editingUser || !confirm('Are you sure you want to delete this listing?')) return

    try {
      await listingsService.deleteListing(editingUser.id, listingId)
      const response = await listingsService.getUserListings(editingUser.id)
      setUserListings(response.listings || [])
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to delete listing')
      } else {
        alert('Failed to delete listing')
      }
    }
  }

  // User Create/Delete Handlers
  const handleCreateUser = () => {
    setCreateForm({
      name: '',
      email: '',
      password: '',
      type: 'creator',
      status: 'pending',
    })
    setCreatingUser(true)
  }

  const handleSaveCreateUser = async () => {
    try {
      await usersService.createUser({
        name: createForm.name,
        email: createForm.email,
        password: createForm.password,
        type: createForm.type,
        status: createForm.status,
      })
      setCreatingUser(false)
      setCreateForm({
        name: '',
        email: '',
        password: '',
        type: 'creator',
        status: 'pending',
      })
      loadUsers()
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to create user')
      } else {
        alert('Failed to create user')
      }
    }
  }

  const handleDeleteUser = (user: User) => {
    setDeletingUser(user)
  }

  const handleConfirmDeleteUser = async () => {
    if (!deletingUser) return

    try {
      await usersService.deleteUser(deletingUser.id)
      setDeletingUser(null)
      loadUsers()
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to delete user')
      } else {
        alert('Failed to delete user')
      }
    }
  }

  const handleStatusChangeClick = (user: User, newStatus: User['status']) => {
    setEditingStatus({ user, newStatus })
    setStatusChangeReason('')
  }

  const handleStatusChange = async () => {
    if (!editingStatus) return

    try {
      const reason = statusChangeReason.trim() || undefined
      await usersService.updateUserStatus(editingStatus.user.id, editingStatus.newStatus, reason)
      setEditingStatus(null)
      setStatusChangeReason('')
      loadUsers()
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        alert(err.data.detail as string || 'Failed to update user status')
      } else {
        alert('Failed to update user status')
      }
    }
  }

  const getStatusBadgeColor = (status: User['status']) => {
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

  const getTypeBadgeColor = (type: User['type']) => {
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

  const startItem = (page - 1) * pageSize + 1
  const endItem = Math.min(page * pageSize, total)

  return (
    <div className="px-4 sm:px-6 lg:px-8">
      <div className="mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Users</h1>
          <p className="mt-2 text-gray-600">Manage all users in the system</p>
        </div>
        <Button
          variant="primary"
          onClick={handleCreateUser}
        >
          <PlusIcon className="w-5 h-5 mr-2" />
          Create User
        </Button>
      </div>

      {/* Filters and Search */}
      <div className="mb-6 bg-white p-4 rounded-lg shadow">
        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <Input
                type="text"
                placeholder="Search by name or email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
          <div className="flex gap-4">
            <select
              value={filterType}
              onChange={(e) => {
                setFilterType(e.target.value as any)
                setPage(1)
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">All Types</option>
              <option value="hotel">Hotels</option>
              <option value="creator">Creators</option>
              <option value="admin">Admins</option>
            </select>
            <select
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value as any)
                setPage(1)
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="verified">Verified</option>
              <option value="rejected">Rejected</option>
              <option value="suspended">Suspended</option>
            </select>
            <Button type="submit" variant="primary">Search</Button>
          </div>
        </form>
      </div>

      {error && (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-sm text-yellow-800">{error}</p>
        </div>
      )}

      {/* Users Table */}
      {loading ? (
        <div className="text-center py-12">
          <p className="text-gray-600">Loading users...</p>
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <UserIcon className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900">No users found</h3>
          <p className="mt-1 text-sm text-gray-500">Try adjusting your filters or search terms.</p>
        </div>
      ) : (
        <>
          <div className="bg-white shadow overflow-hidden sm:rounded-lg">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          {user.avatar ? (
                            <img className="h-10 w-10 rounded-full" src={user.avatar} alt={user.name} />
                          ) : (
                            <div className="h-10 w-10 rounded-full bg-gray-200 flex items-center justify-center">
                              <UserIcon className="h-6 w-6 text-gray-400" />
                            </div>
                          )}
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">{user.name}</div>
                          <div className="text-sm text-gray-500">{user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getTypeBadgeColor(user.type)}`}>
                        {user.type}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getStatusBadgeColor(user.status)}`}>
                        {user.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleViewUser(user)}
                          className="text-blue-600 hover:text-blue-900"
                          title="View Details"
                        >
                          <EyeIcon className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => handleEdit(user)}
                          className="text-primary-600 hover:text-primary-900"
                          title="Edit"
                        >
                          <PencilIcon className="w-5 h-5" />
                        </button>
                        {user.status !== 'verified' && (
                          <button
                            onClick={() => handleStatusChangeClick(user, 'verified')}
                            className="text-green-600 hover:text-green-900"
                            title="Approve"
                          >
                            <CheckCircleIcon className="w-5 h-5" />
                          </button>
                        )}
                        {user.status !== 'rejected' && (
                          <button
                            onClick={() => handleStatusChangeClick(user, 'rejected')}
                            className="text-red-600 hover:text-red-900"
                            title="Reject"
                          >
                            <XCircleIcon className="w-5 h-5" />
                          </button>
                        )}
                        {user.status !== 'suspended' && (
                          <button
                            onClick={() => handleStatusChangeClick(user, 'suspended')}
                            className="text-gray-600 hover:text-gray-900"
                            title="Suspend"
                          >
                            <XCircleIcon className="w-5 h-5" />
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteUser(user)}
                          className="text-red-600 hover:text-red-900"
                          title="Delete User"
                        >
                          <TrashIcon className="w-5 h-5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-between bg-white px-4 py-3 rounded-lg shadow sm:px-6">
              <div className="flex flex-1 justify-between sm:hidden">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  Next
                </Button>
              </div>
              <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    Showing <span className="font-medium">{startItem}</span> to{' '}
                    <span className="font-medium">{endItem}</span> of{' '}
                    <span className="font-medium">{total}</span> results
                  </p>
                </div>
                <div>
                  <nav className="isolate inline-flex -space-x-px rounded-md shadow-sm" aria-label="Pagination">
                    <button
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="relative inline-flex items-center rounded-l-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => {
                      if (
                        pageNum === 1 ||
                        pageNum === totalPages ||
                        (pageNum >= page - 1 && pageNum <= page + 1)
                      ) {
                        return (
                          <button
                            key={pageNum}
                            onClick={() => setPage(pageNum)}
                            className={`relative inline-flex items-center px-4 py-2 text-sm font-semibold ${
                              pageNum === page
                                ? 'z-10 bg-primary-600 text-white focus:z-20'
                                : 'text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0'
                            }`}
                          >
                            {pageNum}
                          </button>
                        )
                      } else if (pageNum === page - 2 || pageNum === page + 2) {
                        return (
                          <span key={pageNum} className="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-gray-700 ring-1 ring-inset ring-gray-300">
                            ...
                          </span>
                        )
                      }
                      return null
                    })}
                    <button
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="relative inline-flex items-center rounded-r-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </nav>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* User Detail Modal */}
      {viewingUser && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-10 mx-auto p-5 border w-full max-w-4xl shadow-lg rounded-md bg-white max-h-[90vh] overflow-y-auto">
            <div className="mt-3">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-gray-900">User Details</h3>
                <button
                  onClick={() => {
                    setViewingUser(null)
                    setUserPlatforms([])
                    setUserListings([])
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="w-6 h-6" />
                </button>
              </div>
              
              {/* Tabs */}
              <div className="border-b border-gray-200 mb-4">
                <nav className="-mb-px flex space-x-8">
                  <button
                    onClick={() => setActiveTab('profile')}
                    className={`py-2 px-1 border-b-2 font-medium text-sm ${
                      activeTab === 'profile'
                        ? 'border-primary-500 text-primary-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    Profile
                  </button>
                  <button
                    onClick={() => setActiveTab('social')}
                    className={`py-2 px-1 border-b-2 font-medium text-sm ${
                      activeTab === 'social'
                        ? 'border-primary-500 text-primary-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    Social Media ({userPlatforms.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('listings')}
                    className={`py-2 px-1 border-b-2 font-medium text-sm ${
                      activeTab === 'listings'
                        ? 'border-primary-500 text-primary-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    Listings ({userListings.length})
                  </button>
                </nav>
              </div>

              {/* Profile Tab */}
              {activeTab === 'profile' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Name</label>
                      <p className="mt-1 text-sm text-gray-900">{viewingUser.name}</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Email</label>
                      <p className="mt-1 text-sm text-gray-900">{viewingUser.email}</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Type</label>
                      <span className={`mt-1 inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getTypeBadgeColor(viewingUser.type)}`}>
                        {viewingUser.type}
                      </span>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Status</label>
                      <span className={`mt-1 inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(viewingUser.status)}`}>
                        {viewingUser.status}
                      </span>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Email Verified</label>
                      <p className="mt-1 text-sm text-gray-900">
                        {viewingUser.email_verified ? 'Yes' : 'No'}
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Created</label>
                      <p className="mt-1 text-sm text-gray-900">
                        {new Date(viewingUser.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  {viewingUser.creator_profile && (
                    <div className="border-t pt-4">
                      <h4 className="text-sm font-medium text-gray-900 mb-3">Creator Profile</h4>
                      <div className="grid grid-cols-2 gap-4">
                        {viewingUser.creator_profile.location && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Location:</span>
                            <p className="text-sm text-gray-900">{viewingUser.creator_profile.location}</p>
                          </div>
                        )}
                        {viewingUser.creator_profile.bio && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Bio:</span>
                            <p className="text-sm text-gray-900">{viewingUser.creator_profile.bio}</p>
                          </div>
                        )}
                        {viewingUser.creator_profile.website && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Website:</span>
                            <a href={viewingUser.creator_profile.website} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline">
                              {viewingUser.creator_profile.website}
                            </a>
                          </div>
                        )}
                        {viewingUser.creator_profile.niche && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Niche:</span>
                            <p className="text-sm text-gray-900">{viewingUser.creator_profile.niche}</p>
                          </div>
                        )}
                        {viewingUser.creator_profile.follower_count && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Total Followers:</span>
                            <p className="text-sm text-gray-900">{viewingUser.creator_profile.follower_count.toLocaleString()}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {viewingUser.hotel_profile && (
                    <div className="border-t pt-4">
                      <h4 className="text-sm font-medium text-gray-900 mb-3">Hotel Profile</h4>
                      <div className="grid grid-cols-2 gap-4">
                        {viewingUser.hotel_profile.hotel_name && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Hotel Name:</span>
                            <p className="text-sm text-gray-900">{viewingUser.hotel_profile.hotel_name}</p>
                          </div>
                        )}
                        {viewingUser.hotel_profile.address && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Address:</span>
                            <p className="text-sm text-gray-900">{viewingUser.hotel_profile.address}</p>
                          </div>
                        )}
                        {viewingUser.hotel_profile.city && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">City:</span>
                            <p className="text-sm text-gray-900">{viewingUser.hotel_profile.city}</p>
                          </div>
                        )}
                        {viewingUser.hotel_profile.country && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Country:</span>
                            <p className="text-sm text-gray-900">{viewingUser.hotel_profile.country}</p>
                          </div>
                        )}
                        {viewingUser.hotel_profile.phone && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Phone:</span>
                            <p className="text-sm text-gray-900">{viewingUser.hotel_profile.phone}</p>
                          </div>
                        )}
                        {viewingUser.hotel_profile.website && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Website:</span>
                            <a href={viewingUser.hotel_profile.website} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline">
                              {viewingUser.hotel_profile.website}
                            </a>
                          </div>
                        )}
                        {viewingUser.hotel_profile.star_rating && (
                          <div>
                            <span className="font-medium text-sm text-gray-700">Star Rating:</span>
                            <p className="text-sm text-gray-900">{viewingUser.hotel_profile.star_rating} ⭐</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Social Media Tab */}
              {activeTab === 'social' && (
                <div className="space-y-4">
                  {loadingPlatforms ? (
                    <p className="text-sm text-gray-600">Loading platforms...</p>
                  ) : userPlatforms.length === 0 ? (
                    <p className="text-sm text-gray-500">No social media platforms found.</p>
                  ) : (
                    <div className="space-y-3">
                      {userPlatforms.map((platform) => (
                        <div key={platform.id} className="border rounded-lg p-4">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 capitalize">
                                  {platform.platform}
                                </span>
                                {platform.verified && (
                                  <span className="px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                                    Verified
                                  </span>
                                )}
                              </div>
                              {platform.handle && (
                                <p className="text-sm text-gray-700">
                                  <span className="font-medium">Handle:</span> @{platform.handle}
                                </p>
                              )}
                              {platform.url && (
                                <a href={platform.url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                                  <LinkIcon className="w-4 h-4" />
                                  {platform.url}
                                </a>
                              )}
                              {platform.follower_count && (
                                <p className="text-sm text-gray-700 mt-1">
                                  <span className="font-medium">Followers:</span> {platform.follower_count.toLocaleString()}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Listings Tab */}
              {activeTab === 'listings' && (
                <div className="space-y-4">
                  {loadingListings ? (
                    <p className="text-sm text-gray-600">Loading listings...</p>
                  ) : userListings.length === 0 ? (
                    <p className="text-sm text-gray-500">No listings found.</p>
                  ) : (
                    <div className="space-y-3">
                      {userListings.map((listing) => (
                        <div key={listing.id} className="border rounded-lg p-4">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                <h4 className="font-medium text-gray-900">{listing.title}</h4>
                                <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                                  listing.status === 'active' ? 'bg-green-100 text-green-800' :
                                  listing.status === 'inactive' ? 'bg-gray-100 text-gray-800' :
                                  listing.status === 'sold' ? 'bg-blue-100 text-blue-800' :
                                  'bg-yellow-100 text-yellow-800'
                                }`}>
                                  {listing.status}
                                </span>
                              </div>
                              {listing.description && (
                                <p className="text-sm text-gray-600 mb-2">{listing.description}</p>
                              )}
                              <div className="flex flex-wrap gap-4 text-sm text-gray-700">
                                {listing.category && (
                                  <span><span className="font-medium">Category:</span> {listing.category}</span>
                                )}
                                {listing.price && (
                                  <span><span className="font-medium">Price:</span> {listing.currency} {listing.price.toLocaleString()}</span>
                                )}
                                {listing.location && (
                                  <span><span className="font-medium">Location:</span> {listing.location}</span>
                                )}
                              </div>
                              {listing.images && listing.images.length > 0 && (
                                <div className="mt-2 flex gap-2">
                                  {listing.images.slice(0, 3).map((img, idx) => (
                                    <img key={idx} src={img} alt={`${listing.title} ${idx + 1}`} className="w-16 h-16 object-cover rounded" />
                                  ))}
                                  {listing.images.length > 3 && (
                                    <div className="w-16 h-16 bg-gray-100 rounded flex items-center justify-center text-xs text-gray-600">
                                      +{listing.images.length - 3}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 mt-6 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setViewingUser(null)
                    setUserPlatforms([])
                    setUserListings([])
                    handleEdit(viewingUser)
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setViewingUser(null)
                    setUserPlatforms([])
                    setUserListings([])
                  }}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Status Change Modal */}
      {editingStatus && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Change User Status
              </h3>
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-gray-700 mb-2">
                    Change status for <span className="font-medium">{editingStatus.user.name}</span> from{' '}
                    <span className="font-medium">{editingStatus.user.status}</span> to{' '}
                    <span className="font-medium">{editingStatus.newStatus}</span>
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Reason (optional)
                  </label>
                  <textarea
                    value={statusChangeReason}
                    onChange={(e) => setStatusChangeReason(e.target.value)}
                    placeholder="Enter reason for status change..."
                    rows={3}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingStatus(null)
                    setStatusChangeReason('')
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleStatusChange}
                >
                  Confirm
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-10 mx-auto p-5 border w-full max-w-4xl shadow-lg rounded-md bg-white max-h-[90vh] overflow-y-auto">
            <div className="mt-3">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-gray-900">Edit User</h3>
                <button
                  onClick={() => {
                    setEditingUser(null)
                    setProfileForm({})
                    setUserPlatforms([])
                    setUserListings([])
                    setEditingPlatform(null)
                    setEditingListing(null)
                    setAddingPlatform(false)
                    setAddingListing(false)
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="w-6 h-6" />
                </button>
              </div>

              {/* Tabs */}
              <div className="border-b border-gray-200 mb-4">
                <nav className="-mb-px flex space-x-8">
                  <button
                    onClick={() => setActiveTab('profile')}
                    className={`py-2 px-1 border-b-2 font-medium text-sm ${
                      activeTab === 'profile'
                        ? 'border-primary-500 text-primary-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    Profile
                  </button>
                  {editingUser.type === 'creator' && (
                    <button
                      onClick={() => setActiveTab('social')}
                      className={`py-2 px-1 border-b-2 font-medium text-sm ${
                        activeTab === 'social'
                          ? 'border-primary-500 text-primary-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                      }`}
                    >
                      Social Media ({userPlatforms.length})
                    </button>
                  )}
                  {editingUser.type === 'hotel' && (
                    <button
                      onClick={() => setActiveTab('listings')}
                      className={`py-2 px-1 border-b-2 font-medium text-sm ${
                        activeTab === 'listings'
                          ? 'border-primary-500 text-primary-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                      }`}
                    >
                      Listings ({userListings.length})
                    </button>
                  )}
                </nav>
              </div>

              {/* Profile Tab */}
              {activeTab === 'profile' && (
                <div className="space-y-4">
                  <Input
                    label="Name"
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  />
                  <Input
                    label="Email"
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
                    <select
                      value={editForm.status}
                      onChange={(e) => setEditForm({ ...editForm, status: e.target.value as User['status'] })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value="pending">Pending</option>
                      <option value="verified">Verified</option>
                      <option value="rejected">Rejected</option>
                      <option value="suspended">Suspended</option>
                    </select>
                  </div>

                  {/* Creator Profile Fields */}
                  {editingUser.type === 'creator' && (
                    <div className="border-t pt-4 space-y-4">
                      <h4 className="text-sm font-medium text-gray-900">Creator Profile</h4>
                      <Input
                        label="Location"
                        value={(profileForm as CreatorProfile).location || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, location: e.target.value })}
                      />
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Bio</label>
                        <textarea
                          value={(profileForm as CreatorProfile).bio || ''}
                          onChange={(e) => setProfileForm({ ...profileForm, bio: e.target.value })}
                          rows={3}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <Input
                        label="Website"
                        type="url"
                        value={(profileForm as CreatorProfile).website || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, website: e.target.value })}
                      />
                      <Input
                        label="Niche"
                        value={(profileForm as CreatorProfile).niche || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, niche: e.target.value })}
                      />
                      <Input
                        label="Total Follower Count"
                        type="number"
                        value={(profileForm as CreatorProfile).follower_count?.toString() || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, follower_count: e.target.value ? parseInt(e.target.value) : undefined })}
                      />
                    </div>
                  )}

                  {/* Hotel Profile Fields */}
                  {editingUser.type === 'hotel' && (
                    <div className="border-t pt-4 space-y-4">
                      <h4 className="text-sm font-medium text-gray-900">Hotel Profile</h4>
                      <Input
                        label="Hotel Name"
                        value={(profileForm as HotelProfile).hotel_name || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, hotel_name: e.target.value })}
                      />
                      <Input
                        label="Address"
                        value={(profileForm as HotelProfile).address || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, address: e.target.value })}
                      />
                      <div className="grid grid-cols-2 gap-4">
                        <Input
                          label="City"
                          value={(profileForm as HotelProfile).city || ''}
                          onChange={(e) => setProfileForm({ ...profileForm, city: e.target.value })}
                        />
                        <Input
                          label="Country"
                          value={(profileForm as HotelProfile).country || ''}
                          onChange={(e) => setProfileForm({ ...profileForm, country: e.target.value })}
                        />
                      </div>
                      <Input
                        label="Phone"
                        type="tel"
                        value={(profileForm as HotelProfile).phone || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                      />
                      <Input
                        label="Website"
                        type="url"
                        value={(profileForm as HotelProfile).website || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, website: e.target.value })}
                      />
                      <Input
                        label="Star Rating"
                        type="number"
                        min="1"
                        max="5"
                        value={(profileForm as HotelProfile).star_rating?.toString() || ''}
                        onChange={(e) => setProfileForm({ ...profileForm, star_rating: e.target.value ? parseInt(e.target.value) : undefined })}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Social Media Tab */}
              {activeTab === 'social' && (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <h4 className="text-sm font-medium text-gray-900">Social Media Platforms</h4>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleAddPlatform}
                    >
                      <PlusIcon className="w-4 h-4 mr-1" />
                      Add Platform
                    </Button>
                  </div>

                  {/* Platform Form */}
                  {(editingPlatform || addingPlatform) && (
                    <div className="border rounded-lg p-4 bg-gray-50">
                      <h5 className="text-sm font-medium text-gray-900 mb-3">
                        {editingPlatform ? 'Edit Platform' : 'Add New Platform'}
                      </h5>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Platform</label>
                          <select
                            value={platformForm.platform}
                            onChange={(e) => setPlatformForm({ ...platformForm, platform: e.target.value as SocialMediaPlatform['platform'] })}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                          >
                            <option value="instagram">Instagram</option>
                            <option value="youtube">YouTube</option>
                            <option value="tiktok">TikTok</option>
                            <option value="twitter">Twitter</option>
                            <option value="facebook">Facebook</option>
                            <option value="linkedin">LinkedIn</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                        <Input
                          label="Handle"
                          placeholder="@username"
                          value={platformForm.handle}
                          onChange={(e) => setPlatformForm({ ...platformForm, handle: e.target.value })}
                        />
                        <Input
                          label="URL"
                          type="url"
                          placeholder="https://..."
                          value={platformForm.url}
                          onChange={(e) => setPlatformForm({ ...platformForm, url: e.target.value })}
                        />
                        <Input
                          label="Follower Count"
                          type="number"
                          value={platformForm.follower_count}
                          onChange={(e) => setPlatformForm({ ...platformForm, follower_count: e.target.value })}
                        />
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            id="verified"
                            checked={platformForm.verified}
                            onChange={(e) => setPlatformForm({ ...platformForm, verified: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <label htmlFor="verified" className="ml-2 block text-sm text-gray-700">
                            Verified
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={handleSavePlatform}
                          >
                            {editingPlatform ? 'Update' : 'Add'} Platform
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditingPlatform(null)
                              setAddingPlatform(false)
                              setPlatformForm({
                                platform: 'instagram',
                                handle: '',
                                url: '',
                                follower_count: '',
                                verified: false,
                              })
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Platforms List */}
                  {userPlatforms.length > 0 && (
                    <div className="space-y-2">
                      {userPlatforms.map((platform) => (
                        <div key={platform.id} className="border rounded-lg p-3 flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 capitalize">
                                {platform.platform}
                              </span>
                              {platform.verified && (
                                <span className="px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                                  Verified
                                </span>
                              )}
                            </div>
                            {platform.handle && <p className="text-sm text-gray-700 mt-1">@{platform.handle}</p>}
                            {platform.follower_count && (
                              <p className="text-xs text-gray-500 mt-1">{platform.follower_count.toLocaleString()} followers</p>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEditPlatform(platform)}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => handleDeletePlatform(platform.id)}
                            >
                              <TrashIcon className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Listings Tab */}
              {activeTab === 'listings' && (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <h4 className="text-sm font-medium text-gray-900">Listings</h4>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleAddListing}
                    >
                      <PlusIcon className="w-4 h-4 mr-1" />
                      Add Listing
                    </Button>
                  </div>

                  {/* Listing Form */}
                  {(editingListing || addingListing) && (
                    <div className="border rounded-lg p-4 bg-gray-50">
                      <h5 className="text-sm font-medium text-gray-900 mb-3">
                        {editingListing ? 'Edit Listing' : 'Add New Listing'}
                      </h5>
                      <div className="space-y-3">
                        <Input
                          label="Title"
                          value={listingForm.title}
                          onChange={(e) => setListingForm({ ...listingForm, title: e.target.value })}
                        />
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
                          <textarea
                            value={listingForm.description}
                            onChange={(e) => setListingForm({ ...listingForm, description: e.target.value })}
                            rows={3}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <Input
                            label="Category"
                            value={listingForm.category}
                            onChange={(e) => setListingForm({ ...listingForm, category: e.target.value })}
                          />
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
                            <select
                              value={listingForm.status}
                              onChange={(e) => setListingForm({ ...listingForm, status: e.target.value as Listing['status'] })}
                              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                            >
                              <option value="active">Active</option>
                              <option value="inactive">Inactive</option>
                              <option value="draft">Draft</option>
                              <option value="sold">Sold</option>
                            </select>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <Input
                            label="Price"
                            type="number"
                            value={listingForm.price}
                            onChange={(e) => setListingForm({ ...listingForm, price: e.target.value })}
                          />
                          <Input
                            label="Currency"
                            value={listingForm.currency}
                            onChange={(e) => setListingForm({ ...listingForm, currency: e.target.value })}
                          />
                        </div>
                        <Input
                          label="Location"
                          value={listingForm.location}
                          onChange={(e) => setListingForm({ ...listingForm, location: e.target.value })}
                        />
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Image URLs (one per line)</label>
                          <textarea
                            value={listingForm.images.join('\n')}
                            onChange={(e) => setListingForm({ ...listingForm, images: e.target.value.split('\n').filter(url => url.trim()) })}
                            rows={3}
                            placeholder="https://example.com/image1.jpg&#10;https://example.com/image2.jpg"
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={handleSaveListing}
                          >
                            {editingListing ? 'Update' : 'Add'} Listing
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditingListing(null)
                              setAddingListing(false)
                              setListingForm({
                                title: '',
                                description: '',
                                category: '',
                                price: '',
                                currency: 'USD',
                                status: 'active',
                                location: '',
                                images: [],
                              })
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Listings List */}
                  {userListings.length > 0 && (
                    <div className="space-y-2">
                      {userListings.map((listing) => (
                        <div key={listing.id} className="border rounded-lg p-3 flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h5 className="font-medium text-gray-900">{listing.title}</h5>
                              <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                                listing.status === 'active' ? 'bg-green-100 text-green-800' :
                                listing.status === 'inactive' ? 'bg-gray-100 text-gray-800' :
                                listing.status === 'sold' ? 'bg-blue-100 text-blue-800' :
                                'bg-yellow-100 text-yellow-800'
                              }`}>
                                {listing.status}
                              </span>
                            </div>
                            {listing.description && <p className="text-sm text-gray-600 mb-1">{listing.description}</p>}
                            <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                              {listing.category && <span>Category: {listing.category}</span>}
                              {listing.price && <span>Price: {listing.currency} {listing.price.toLocaleString()}</span>}
                              {listing.location && <span>Location: {listing.location}</span>}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEditListing(listing)}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => handleDeleteListing(listing.id)}
                            >
                              <TrashIcon className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 mt-6 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingUser(null)
                    setProfileForm({})
                    setUserPlatforms([])
                    setUserListings([])
                    setEditingPlatform(null)
                    setEditingListing(null)
                    setAddingPlatform(false)
                    setAddingListing(false)
                  }}
                >
                  Cancel
                </Button>
                {activeTab === 'profile' && (
                  <Button
                    variant="primary"
                    onClick={handleSaveEdit}
                  >
                    Save
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {creatingUser && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-gray-900">Create New User</h3>
                <button
                  onClick={() => {
                    setCreatingUser(false)
                    setCreateForm({
                      name: '',
                      email: '',
                      password: '',
                      type: 'creator',
                      status: 'pending',
                    })
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="w-6 h-6" />
                </button>
              </div>
              <div className="space-y-4">
                <Input
                  label="Name"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  required
                />
                <Input
                  label="Email"
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  required
                />
                <Input
                  label="Password"
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                  required
                />
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">User Type</label>
                  <select
                    value={createForm.type}
                    onChange={(e) => setCreateForm({ ...createForm, type: e.target.value as User['type'] })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="creator">Creator</option>
                    <option value="hotel">Hotel</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
                  <select
                    value={createForm.status}
                    onChange={(e) => setCreateForm({ ...createForm, status: e.target.value as User['status'] })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="pending">Pending</option>
                    <option value="verified">Verified</option>
                    <option value="rejected">Rejected</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreatingUser(false)
                    setCreateForm({
                      name: '',
                      email: '',
                      password: '',
                      type: 'creator',
                      status: 'pending',
                    })
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSaveCreateUser}
                  disabled={!createForm.name || !createForm.email || !createForm.password}
                >
                  Create User
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete User Confirmation Modal */}
      {deletingUser && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-gray-900">Delete User</h3>
                <button
                  onClick={() => setDeletingUser(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="w-6 h-6" />
                </button>
              </div>
              <div className="space-y-4">
                <p className="text-sm text-gray-700">
                  Are you sure you want to delete <span className="font-medium">{deletingUser.name}</span> ({deletingUser.email})?
                </p>
                <p className="text-sm text-red-600 font-medium">
                  This action cannot be undone. All associated data (social media platforms, listings, etc.) will also be deleted.
                </p>
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <Button
                  variant="outline"
                  onClick={() => setDeletingUser(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={handleConfirmDeleteUser}
                >
                  Delete User
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
