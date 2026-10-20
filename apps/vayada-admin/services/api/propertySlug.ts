import { apiClient } from "./client";

/** The address change the operator approves (VAY-2295); the server re-checks it before changing. */
export type PropertySlugChangePreview = {
  plan: {
    propertyId: string;
    fromSlug: string;
    toSlug: string;
    change: "new_address" | "former_address" | "already_applied";
    livePage: { pageSlug: string; organizationId: string; republishAsUserId: string } | null;
  };
  planSha256: string;
};

export type PropertySlugChangeResult = PropertySlugChangePreview & {
  publication: { status: string; operationId?: string; code?: string };
};

const MESSAGES: Record<string, string> = {
  invalid_slug: "Use lowercase letters, numbers and single hyphens, up to 63 characters.",
  slug_taken: "Another hotel already uses this address.",
  property_not_found: "This hotel wasn't found.",
  property_unavailable: "This hotel is suspended or retired, so its address can't change.",
  canonical_slug_missing: "This hotel has no booking page address yet.",
  legacy_page_only:
    "This hotel's page was never published from setup, so its address can't move yet.",
  publication_in_progress: "The booking page is being published right now. Try again in a minute.",
  page_not_ready: "The booking page can't be republished: the hotel's setup has open items.",
  republish_user_unavailable:
    "The hotel user who published the page no longer has access, so it can't be republished.",
  republish_unavailable:
    "This server can't republish booking pages, so the live page's address can't move here.",
  plan_changed: "Something changed since the preview. Preview the change again.",
  invalid_platform_scope: "You don't have permission to change booking page addresses.",
};

export const propertySlugService = {
  preview(propertyId: string, slug: string): Promise<PropertySlugChangePreview> {
    return apiClient.post(`/api/platform/admin/properties/${propertyId}/slug/preview`, { slug });
  },

  change(
    propertyId: string,
    preview: PropertySlugChangePreview,
    reason: string,
  ): Promise<PropertySlugChangeResult> {
    return apiClient.post(`/api/platform/admin/properties/${propertyId}/slug`, {
      slug: preview.plan.toSlug,
      reason,
      expectedPlanSha256: preview.planSha256,
    });
  },
};

/** Reads the route's refusal code structurally (the client may throw another error class). */
export function propertySlugErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object"
      ? (error as { data?: { code?: unknown } }).data?.code
      : undefined;
  return (
    (typeof code === "string" && MESSAGES[code]) || "The address couldn't be changed. Try again."
  );
}
