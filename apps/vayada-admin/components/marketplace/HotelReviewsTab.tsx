"use client";

import { CheckBadgeIcon, EyeIcon } from "@heroicons/react/24/outline";
import {
  describeSubmissionHistory,
  formatHotelLocation,
  formatPropertyType,
  formatSubmissionDate,
  hotelInitials,
  type HotelSubmissionQueueItem,
} from "@/services/api/hotelSubmissions";

const TONES = {
  neutral: "bg-gray-100 border-gray-200 text-gray-800",
  warning: "bg-yellow-100 border-yellow-200 text-yellow-800",
  info: "bg-blue-50 border-blue-200 text-blue-800",
} as const;

type Props = {
  submissions: HotelSubmissionQueueItem[];
  loading: boolean;
  error: string | null;
  onReview: (submission: HotelSubmissionQueueItem) => void;
};

/** Hotel profiles submitted from setup that wait for a Vayada decision, oldest first. */
export function HotelReviewsTab({ submissions, loading, error, onReview }: Props) {
  if (loading)
    return (
      <div className="text-center py-12 bg-white rounded-lg shadow">
        <p className="text-gray-600">Loading hotel reviews...</p>
      </div>
    );
  if (error)
    return (
      <div role="alert" className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-sm text-red-800">{error}</p>
      </div>
    );
  if (submissions.length === 0)
    return (
      <div className="text-center py-14 bg-white rounded-lg shadow">
        <CheckBadgeIcon className="mx-auto h-8 w-8 text-gray-400" />
        <h3 className="mt-2 text-base font-semibold text-gray-900">
          No hotel profiles are waiting for review
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          When a hotel submits its profile from setup, it appears here.
        </p>
      </div>
    );
  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="px-6 py-5">
        <h2 className="text-base font-semibold text-gray-900">
          {submissions.length} hotel profile{submissions.length === 1 ? "" : "s"} waiting for review
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Oldest first. Approving publishes the hotel’s profile on its public Marketplace page.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-y border-gray-200">
            <tr>
              {["Hotel", "Location", "Submitted", "History"].map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700"
                >
                  {column}
                </th>
              ))}
              <th
                scope="col"
                className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-700"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {submissions.map((submission) => {
              const history = describeSubmissionHistory(submission);
              const name = submission.displayName ?? "Unnamed hotel";
              return (
                <tr key={submission.revisionId}>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-sm font-bold text-primary-700">
                        {hotelInitials(submission.displayName)}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{name}</p>
                        <p className="text-xs text-gray-500">
                          {formatPropertyType(submission.propertyType)}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {formatHotelLocation(submission.city, submission.countryCode)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {formatSubmissionDate(submission.submittedAt)}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[history.tone]}`}
                    >
                      {history.label}
                    </span>
                    {history.detail && (
                      <p className="mt-1 text-xs text-gray-500">{history.detail}</p>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      type="button"
                      onClick={() => onReview(submission)}
                      aria-label={`Review ${name}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border-2 border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      <EyeIcon className="h-4 w-4" />
                      Review
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
