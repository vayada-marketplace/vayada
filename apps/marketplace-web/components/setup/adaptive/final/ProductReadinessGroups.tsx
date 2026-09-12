"use client";
import type {
  ProductReadinessResult,
  ReadinessProviderFailure,
  PropertySetupStepId,
} from "@vayada/domain-hotels";
const names: Record<string, string> = {
  "marketplace.hotel_profile": "Hotel profile",
  "marketplace.collaboration_preferences": "Collaboration preferences",
  "booking.hotel_profile": "Hotel profile",
  "booking.page_style": "Booking page style",
  "booking.rooms": "Rooms",
  "booking.pricing": "Pricing",
  "booking.calendar": "Calendar",
  "booking.guest_experience": "Guest experience",
  "booking.payments": "Payments",
};
const statusNames = {
  ready: "Ready",
  blocked: "Needs attention",
  pending: "Waiting",
  error: "Temporarily unavailable",
};
export function ProductReadinessGroups({
  readiness,
  onEdit,
}: {
  readiness: ProductReadinessResult | ReadinessProviderFailure;
  onEdit: (step: PropertySetupStepId, entityId?: string) => void;
}) {
  if (readiness.outcome === "provider_failure")
    return (
      <p role="alert" className="mt-4 rounded-lg bg-amber-50 p-4 text-sm">
        {readiness.error.message}
      </p>
    );
  return (
    <div className="mt-5 divide-y divide-gray-100">
      {readiness.groups.map((group) => (
        <section key={group.groupId} className="py-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{names[group.groupId]}</h3>
            <span className="text-sm text-gray-600">{statusNames[group.status]}</span>
          </div>
          {group.steps.flatMap((step) =>
            step.entities.flatMap((entity) =>
              entity.blockers.map((blocker, index) => (
                <div
                  key={`${step.owningStepId}:${entity.source.entityId}:${index}`}
                  className="mt-3 text-sm"
                >
                  <p>{blocker.message}</p>
                  {blocker.kind === "user_fixable" && (
                    <button
                      type="button"
                      onClick={() => onEdit(blocker.owningStepId, entity.source.entityId)}
                      className="mt-2 font-semibold text-primary-700 hover:underline"
                    >
                      Edit {names[group.groupId]?.toLowerCase()}
                    </button>
                  )}
                </div>
              )),
            ),
          )}
        </section>
      ))}
    </div>
  );
}
