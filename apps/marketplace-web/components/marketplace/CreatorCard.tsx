import { useState } from "react";
import Image from "next/image";
import { Creator } from "@/lib/types";
import { Button, StarRating, PlatformIcon } from "@/components/ui";
import {
  MapPinIcon,
  CheckBadgeIcon,
  UserGroupIcon,
  SparklesIcon,
  PaperAirplaneIcon,
  ChartBarIcon,
  ArrowRightIcon,
} from "@heroicons/react/24/outline";
import { formatNumber } from "@/lib/utils";
import { CreatorDetailModal } from "./CreatorDetailModal";

interface CreatorCardProps {
  creator: Creator;
  isPublic?: boolean;
}

export function CreatorCard({ creator, isPublic = false }: CreatorCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [imageError, setImageError] = useState(false);
  const totalFollowers = creator.platforms.reduce((sum, platform) => sum + platform.followers, 0);
  // Weighted average engagement rate (proportional to follower count)
  const avgEngagementRate =
    totalFollowers > 0
      ? creator.platforms.reduce(
          (sum, platform) =>
            sum +
            platform.followers *
              (typeof platform.engagementRate === "number" ? platform.engagementRate : 0),
          0,
        ) / totalFollowers
      : 0;
  const primaryPlatform = creator.platforms[0];
  const topCountries = Array.from(
    new Set(
      creator.platforms
        .flatMap(
          (platform) => platform.topCountries?.slice(0, 2).map((country) => country.country) || [],
        )
        .filter(Boolean),
    ),
  ).slice(0, 3);

  return (
    <>
      <div className="group flex h-full flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-colors hover:border-gray-300">
        <div className="flex gap-4 border-b border-gray-100 p-4">
          <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-lg bg-gray-100">
            {creator.profilePicture && !imageError ? (
              <Image
                src={creator.profilePicture}
                alt={creator.name}
                fill
                className="object-cover"
                onError={() => setImageError(true)}
                unoptimized
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-primary-600 text-2xl font-bold text-white">
                {creator.name.charAt(0)}
              </div>
            )}
            {creator.status === "verified" && (
              <div className="absolute bottom-1 right-1 rounded-full bg-white p-0.5 shadow-sm">
                <CheckBadgeIcon className="h-5 w-5 text-primary-600" />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-gray-950" title={creator.name}>
                  {creator.name}
                </h3>
                <div className="mt-1 flex items-center text-sm text-gray-500">
                  <MapPinIcon className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" />
                  <span className="truncate">{creator.location}</span>
                </div>
              </div>
              {creator.creatorType && (
                <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">
                  {creator.creatorType === "Lifestyle" ? (
                    <SparklesIcon className="h-3.5 w-3.5" />
                  ) : (
                    <PaperAirplaneIcon className="h-3.5 w-3.5" />
                  )}
                  {creator.creatorType}
                </span>
              )}
            </div>

            {creator.rating && creator.rating.totalReviews > 0 && (
              <div className="mt-2">
                <StarRating
                  rating={creator.rating.averageRating}
                  totalReviews={creator.rating.totalReviews}
                  size="sm"
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col p-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0 rounded-md border border-gray-200 bg-gray-50 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-gray-500">
                <UserGroupIcon className="h-3.5 w-3.5 text-gray-400" />
                <span>Reach</span>
              </div>
              <p className="truncate text-lg font-semibold text-gray-950">
                {formatNumber(totalFollowers)}
              </p>
            </div>
            <div className="min-w-0 rounded-md border border-gray-200 bg-gray-50 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-gray-500">
                <ChartBarIcon className="h-3.5 w-3.5 text-gray-400" />
                <span>Engagement</span>
              </div>
              <p className="truncate text-lg font-semibold text-gray-950">
                {avgEngagementRate.toFixed(1)}%
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {primaryPlatform && (
              <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700">
                <PlatformIcon platform={primaryPlatform.name} className="h-3.5 w-3.5" />
                {primaryPlatform.name === "YT" ? "YouTube" : primaryPlatform.name}
              </span>
            )}
            {topCountries.map((country) => (
              <span
                key={country}
                className="inline-flex items-center rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600"
              >
                {country}
              </span>
            ))}
          </div>

          {creator.shortDescription && (
            <p className="mt-3 line-clamp-2 text-sm leading-6 text-gray-600">
              {creator.shortDescription}
            </p>
          )}
        </div>

        <div className="mt-auto border-t border-gray-100 bg-white p-3">
          <Button
            variant="primary"
            size="sm"
            className="w-full gap-2 rounded-md py-2"
            onClick={() => setIsModalOpen(true)}
          >
            <span>View Profile</span>
            <ArrowRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <CreatorDetailModal
        creator={creator}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        isPublic={isPublic}
      />
    </>
  );
}
