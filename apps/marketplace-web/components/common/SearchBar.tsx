"use client";

import { Input } from "@/components/ui";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  sortOption?: string;
  onSortChange?: (sort: string) => void;
  showSort?: boolean;
}

export function SearchBar({
  value,
  onChange,
  placeholder = "Search...",
  sortOption = "relevance",
  onSortChange,
  showSort = true,
}: SearchBarProps) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <Input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-md border-gray-200 bg-gray-50 pl-9 pr-3 text-sm focus:bg-white"
        />
      </div>
      {showSort && onSortChange && (
        <div className="flex-shrink-0">
          <select
            value={sortOption}
            onChange={(e) => onSortChange(e.target.value)}
            className="h-10 w-full min-w-[150px] rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 sm:w-auto"
          >
            <option value="relevance">Relevance</option>
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </div>
      )}
    </div>
  );
}
