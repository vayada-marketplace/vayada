"use client";

import { SearchBar } from "@/components/common";
import { HotelFilters, type HotelFiltersState } from "./HotelFilters";
import { CreatorFilters, type CreatorFiltersState } from "./CreatorFilters";

// Combined filters state for marketplace
export interface MarketplaceFiltersState extends HotelFiltersState, CreatorFiltersState {}

interface MarketplaceFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  filters: MarketplaceFiltersState;
  onFiltersChange: (filters: MarketplaceFiltersState) => void;
  viewType: "all" | "hotels" | "creators";
}

export function MarketplaceFilters({
  searchQuery,
  onSearchChange,
  filters,
  onFiltersChange,
  viewType,
}: MarketplaceFiltersProps) {
  const getPlaceholder = () => {
    switch (viewType) {
      case "hotels":
        return "Search hotels or locations";
      case "creators":
        return "Search creators or locations";
      default:
        return "Search marketplace";
    }
  };

  const handleHotelFiltersChange = (hotelFilters: HotelFiltersState) => {
    // Create new filters, explicitly handling removed keys
    const newFilters: MarketplaceFiltersState = { ...filters };
    // Update or remove hotel filter keys
    const hotelKeys: (keyof HotelFiltersState)[] = [
      "hotelType",
      "offering",
      "availability",
      "budget",
    ];
    hotelKeys.forEach((key) => {
      if (key in hotelFilters) {
        (newFilters as Record<string, unknown>)[key] = hotelFilters[key];
      } else {
        delete newFilters[key];
      }
    });
    onFiltersChange(newFilters);
  };

  const handleCreatorFiltersChange = (creatorFilters: CreatorFiltersState) => {
    // Create new filters, explicitly handling removed keys
    const newFilters: MarketplaceFiltersState = { ...filters };
    // Update or remove creator filter keys
    const creatorKeys: (keyof CreatorFiltersState)[] = [
      "minFollowers",
      "minEngagementRate",
      "creatorPlatforms",
      "topCountries",
      "creatorTypes",
    ];
    creatorKeys.forEach((key) => {
      if (key in creatorFilters) {
        (newFilters as Record<string, unknown>)[key] = creatorFilters[key];
      } else {
        delete newFilters[key];
      }
    });
    onFiltersChange(newFilters);
  };

  const handleClearAll = () => {
    onFiltersChange({});
  };

  // Extract hotel and creator filters from combined state
  const hotelFilters: HotelFiltersState = {
    hotelType: filters.hotelType,
    offering: filters.offering,
    availability: filters.availability,
    budget: filters.budget,
  };

  const creatorFilters: CreatorFiltersState = {
    minFollowers: filters.minFollowers,
    minEngagementRate: filters.minEngagementRate,
    creatorPlatforms: filters.creatorPlatforms,
    topCountries: filters.topCountries,
    creatorTypes: filters.creatorTypes,
  };

  const showHotelFilters = viewType === "all" || viewType === "hotels";
  const showCreatorFilters = viewType === "all" || viewType === "creators";

  return (
    <div>
      <SearchBar value={searchQuery} onChange={onSearchChange} placeholder={getPlaceholder()} />

      {showHotelFilters && (
        <HotelFilters
          filters={hotelFilters}
          onFiltersChange={handleHotelFiltersChange}
          onClearAll={handleClearAll}
          showClearAll={!showCreatorFilters}
        />
      )}

      {showCreatorFilters && (
        <div className={showHotelFilters ? "mt-4" : ""}>
          <CreatorFilters
            filters={creatorFilters}
            onFiltersChange={handleCreatorFiltersChange}
            onClearAll={handleClearAll}
            showClearAll={true}
          />
        </div>
      )}
    </div>
  );
}
