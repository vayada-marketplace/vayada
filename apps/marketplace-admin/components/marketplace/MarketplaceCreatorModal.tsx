'use client'

import { Modal } from '@/components/ui/Modal'
import { MarketplaceCreator } from '@/services/api/marketplace'
import {
  MapPinIcon,
  StarIcon,
  GlobeAltIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'

interface MarketplaceCreatorModalProps {
  isOpen: boolean
  onClose: () => void
  creator: MarketplaceCreator | null
  notFoundMessage?: string
}

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
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

export function MarketplaceCreatorModal({
  isOpen,
  onClose,
  creator,
  notFoundMessage,
}: MarketplaceCreatorModalProps) {
  if (notFoundMessage) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Creator" size="md">
        <p className="text-sm text-gray-600">{notFoundMessage}</p>
      </Modal>
    )
  }

  if (!creator) return null

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={creator.name} size="xl">
      <div className="space-y-6">
        {/* Profile Header */}
        <div className="flex items-center gap-6">
          <div className="w-24 h-24 rounded-full bg-gray-200 overflow-hidden flex-shrink-0">
            {creator.profile_picture ? (
              <img
                src={creator.profile_picture}
                alt={creator.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <UserGroupIcon className="w-12 h-12 text-gray-400" />
              </div>
            )}
          </div>
          <div className="flex-1">
            <h3 className="text-xl font-semibold text-gray-900">{creator.name}</h3>
            <div className="flex items-center text-gray-500 mb-2">
              <MapPinIcon className="w-4 h-4 mr-1" />
              {creator.location || 'No location'}
            </div>
            <div className="flex items-center gap-6">
              <div>
                <p className="text-2xl font-bold text-gray-900">{formatNumber(creator.audience_size)}</p>
                <p className="text-sm text-gray-500">Total Audience</p>
              </div>
              {creator.total_reviews > 0 && (
                <div>
                  <p className="text-2xl font-bold text-gray-900 flex items-center">
                    <StarIcon className="w-5 h-5 text-yellow-400 mr-1" />
                    {creator.average_rating.toFixed(1)}
                  </p>
                  <p className="text-sm text-gray-500">{creator.total_reviews} reviews</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bio */}
        {creator.short_description && (
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">About</h4>
            <p className="text-gray-600">{creator.short_description}</p>
          </div>
        )}

        {/* Portfolio Link */}
        {creator.portfolio_link && (
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">Portfolio</h4>
            <a
              href={creator.portfolio_link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center text-primary-600 hover:text-primary-700"
            >
              <GlobeAltIcon className="w-4 h-4 mr-2" />
              {creator.portfolio_link}
            </a>
          </div>
        )}

        {/* Platforms */}
        <div>
          <h4 className="font-semibold text-gray-900 mb-3">Social Media Platforms</h4>
          <div className="space-y-4">
            {creator.platforms.map((platform) => (
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
  )
}
