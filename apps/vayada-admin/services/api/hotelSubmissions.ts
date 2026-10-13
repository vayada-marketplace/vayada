import {
  getMarketplaceAdminHotelSubmission,
  getMarketplaceAdminHotelSubmissions,
  type MarketplaceAdminHotelSubmissionQueueItem,
  type MarketplaceAdminHotelSubmissionReview,
} from "@vayada/marketplace-shared/api/admin";

export type {
  MarketplaceAdminHotelSubmissionQueueItem as HotelSubmissionQueueItem,
  MarketplaceAdminHotelSubmissionReview as HotelSubmissionReview,
} from "@vayada/marketplace-shared/api/admin";

export const hotelSubmissionsService = {
  async list(): Promise<MarketplaceAdminHotelSubmissionQueueItem[]> {
    return (await getMarketplaceAdminHotelSubmissions()).submissions;
  },
  async get(revisionId: string): Promise<MarketplaceAdminHotelSubmissionReview> {
    return (await getMarketplaceAdminHotelSubmission(revisionId)).review;
  },
};

/** The shared API client throws its own error class; read its status and code structurally. */
export function readApiError(error: unknown): { status?: number; code?: string } {
  if (!error || typeof error !== "object") return {};
  const candidate = error as { status?: unknown; data?: { code?: unknown } };
  return {
    status: typeof candidate.status === "number" ? candidate.status : undefined,
    code: typeof candidate.data?.code === "string" ? candidate.data.code : undefined,
  };
}

export function formatSubmissionDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US");
}

export function formatHotelLocation(city: string | null, countryCode: string | null): string {
  let country = countryCode ?? "";
  if (countryCode) {
    try {
      country = new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) ?? countryCode;
    } catch {
      country = countryCode;
    }
  }
  return [city, country].filter(Boolean).join(", ") || "Location not set";
}

export function formatPropertyType(type: string | null): string {
  if (!type) return "Hotel";
  const words = type.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function hotelInitials(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "H").slice(0, 2)
  ).toUpperCase();
}

export type SubmissionHistoryBadge = {
  label: string;
  tone: "neutral" | "warning" | "info";
  detail: string | null;
};

/** The HISTORY column: what happened to this hotel's previous submission. */
export function describeSubmissionHistory(
  item: Pick<MarketplaceAdminHotelSubmissionQueueItem, "previous" | "live">,
): SubmissionHistoryBadge {
  const previous = item.previous;
  if (!previous) return { label: "First submission", tone: "neutral", detail: null };
  if (previous.status === "approved")
    return {
      label: "Update",
      tone: "info",
      detail: item.live ? "Current version is live" : "Previous version approved",
    };
  const date = previous.decidedAt ? ` ${formatSubmissionDate(previous.decidedAt)}` : "";
  if (previous.status === "changes_requested")
    return { label: "Resubmitted", tone: "warning", detail: `Changes requested${date}` };
  return { label: "Resubmitted", tone: "warning", detail: null };
}

const COMPENSATION: Record<string, string> = {
  free_stay: "Free stay",
  paid: "Paid",
  discount: "Discount",
  affiliate: "Affiliate",
};
const PLATFORMS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
  blog: "Blog",
  x: "X",
  other: "Other",
};
const CONTENT: Record<string, string> = {
  post: "Posts",
  story: "Stories",
  short_form_video: "Short videos",
  long_form_video: "Long videos",
  photography: "Photography",
  other: "Other",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The private collaboration preferences as label/value rows for the review dialog. */
export function describePreferences(
  preferences: MarketplaceAdminHotelSubmissionReview["preferences"],
): { label: string; value: string }[] {
  if (!preferences) return [];
  const list = (values: string[], names: Record<string, string>) =>
    values.map((value) => names[value] ?? value).join(", ") || "—";
  const availability =
    preferences.availability.mode === "year_round"
      ? "Year-round"
      : preferences.availability.selectedMonths
          .map((month) => MONTHS[month - 1] ?? String(month))
          .join(", ") || "—";
  return [
    { label: "Compensation", value: list(preferences.compensationTypes, COMPENSATION) },
    { label: "Platforms", value: list(preferences.contentPlatforms, PLATFORMS) },
    { label: "Content", value: list(preferences.contentTypes, CONTENT) },
    { label: "Availability", value: availability },
  ];
}

/** "Submitted 10/12/2026 by owner@example.com · First submission" */
export function describeSubmission(
  review: Pick<
    MarketplaceAdminHotelSubmissionReview,
    "submittedAt" | "submittedByEmail" | "revisionNumber"
  >,
): string {
  const by = review.submittedByEmail ? ` by ${review.submittedByEmail}` : "";
  const which =
    review.revisionNumber === 1 ? "First submission" : `Submission ${review.revisionNumber}`;
  return `Submitted ${formatSubmissionDate(review.submittedAt)}${by} · ${which}`;
}
