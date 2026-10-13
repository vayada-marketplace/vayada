"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { Modal } from "@/components/ui/Modal";
import {
  describePreferences,
  describeSubmission,
  formatHotelLocation,
  formatPropertyType,
  hotelInitials,
  hotelSubmissionsService,
  readApiError,
  type HotelSubmissionReview,
} from "@/services/api/hotelSubmissions";

type Props = {
  revisionId: string | null;
  onClose: () => void;
  /** Decision controls for the loaded review; omitted while the review can only be read. */
  renderActions?: (review: HotelSubmissionReview) => ReactNode;
};

/** What creators will see on /hotels/[id] once approved, plus the private preferences. */
export function HotelSubmissionReviewDialog({ revisionId, onClose, renderActions }: Props) {
  const [review, setReview] = useState<HotelSubmissionReview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!revisionId) return;
    let cancelled = false;
    setReview(null);
    setError(null);
    hotelSubmissionsService
      .get(revisionId)
      .then((loaded) => {
        if (!cancelled) setReview(loaded);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          readApiError(cause).status === 404
            ? "This submission no longer exists. Refresh the list."
            : "The submission could not be loaded. Try again.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [revisionId]);

  return (
    <Modal isOpen={!!revisionId} onClose={onClose} title="Review hotel profile" size="lg">
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : !review ? (
        <p className="text-sm text-gray-600">Loading submission...</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">{describeSubmission(review)}</p>
          <Label>Public profile preview</Label>
          {review.preview ? <Preview preview={review.preview} /> : <PreviewUnavailable />}
          <Label>Collaboration preferences · not public</Label>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {describePreferences(review.preferences).map((row) => (
              <div key={row.label}>
                <dt className="text-xs font-medium text-gray-500">{row.label}</dt>
                <dd className="text-sm font-medium text-gray-900">{row.value}</dd>
              </div>
            ))}
          </dl>
          {renderActions?.(review)}
        </div>
      )}
    </Modal>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{children}</p>;
}

function Preview({ preview }: { preview: NonNullable<HotelSubmissionReview["preview"]> }) {
  const cover = preview.media.find((item) => item.mediaType === "hero_image");
  const logo = preview.media.find((item) => item.mediaType === "logo");
  const gallery = preview.media.filter((item) => item.mediaType === "gallery_image").slice(0, 4);
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      {cover ? (
        <img src={cover.url} alt={cover.altText ?? ""} className="h-40 w-full object-cover" />
      ) : (
        <div className="flex h-36 w-full flex-col items-center justify-center gap-1.5 bg-gray-100 text-xs font-medium text-gray-500">
          <PhotoIcon className="h-7 w-7 text-gray-400" />
          No cover photo
        </div>
      )}
      <div className="space-y-3.5 p-4">
        <div className="flex items-center gap-3">
          {logo ? (
            <img
              src={logo.url}
              alt={logo.altText ?? ""}
              className="h-[52px] w-[52px] rounded-[10px] border border-gray-200 object-cover"
            />
          ) : (
            <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[10px] border border-gray-200 bg-primary-50 text-base font-bold text-primary-700">
              {hotelInitials(preview.displayName)}
            </span>
          )}
          <div>
            <p className="text-lg font-bold text-gray-900">{preview.displayName}</p>
            <p className="text-sm text-gray-500">
              {formatPropertyType(preview.propertyType)}
              {preview.locality
                ? ` · ${formatHotelLocation(preview.locality.city, preview.locality.countryCode)}`
                : " · Location not public"}
            </p>
          </div>
        </div>
        <p className="text-sm text-gray-700">{preview.shortDescription}</p>
        {gallery.length > 0 && (
          <div className="flex gap-2">
            {gallery.map((item) => (
              <img
                key={item.url}
                src={item.url}
                alt={item.altText ?? ""}
                className="h-16 w-24 rounded-md object-cover"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewUnavailable() {
  return (
    <div role="alert" className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
      <p className="text-sm font-semibold text-yellow-900">The public preview can’t be shown</p>
      <p className="mt-1 text-sm text-yellow-800">
        Its photos aren’t publicly available, so the public page would stay unavailable. Ask the
        hotel to upload its photos again.
      </p>
    </div>
  );
}
