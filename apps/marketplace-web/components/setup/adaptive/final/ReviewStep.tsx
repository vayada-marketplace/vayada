"use client";
import { useState } from "react";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import { adaptivePrimaryButtonClass } from "../AdaptiveStepPrimitives";
import { BookingReviewCard } from "./BookingReviewCard";
import { MarketplaceReviewCard } from "./MarketplaceReviewCard";

export function ReviewStep({ route, goToStep, saveAndContinue }: AdaptiveSetupStepComponentProps) {
  const [leaving, setLeaving] = useState(false);
  const props = {
    propertyId: route.scope.propertyId,
    organizationId: route.scope.organizationId,
    onEdit: (step: Parameters<NonNullable<typeof goToStep>>[0], entityId?: string) =>
      goToStep?.(step, entityId),
  };
  return (
    <div className="space-y-6">
      {route.selectedTracks.includes("creator_marketplace") && <MarketplaceReviewCard {...props} />}
      {route.selectedTracks.includes("hotel_operations") && <BookingReviewCard {...props} />}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-gray-600">
          You can leave and return while submission or publication is pending.
        </p>
        <button
          type="button"
          className={adaptivePrimaryButtonClass}
          disabled={leaving}
          onClick={async () => {
            setLeaving(true);
            try {
              await saveAndContinue();
            } finally {
              setLeaving(false);
            }
          }}
        >
          Finish for now
        </button>
      </div>
    </div>
  );
}
