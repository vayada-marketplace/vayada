"use client";

import type { ProfileCompletionProgressProps } from "./types";

export function ProfileCompletionProgress({ percentage }: ProfileCompletionProgressProps) {
  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Profile completion</span>
        <span className="text-sm font-semibold text-gray-950">{percentage}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className="h-2 rounded-full bg-primary-600 transition-all duration-500 ease-out"
          style={{ width: `${percentage}%` }}
        ></div>
      </div>
    </div>
  );
}
