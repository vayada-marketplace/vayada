import { describe, expect, it } from "vitest";

import {
  describePreferences,
  describeSubmission,
  describeSubmissionHistory,
  formatHotelLocation,
  formatPropertyType,
  formatSubmissionDate,
  decisionErrorMessage,
  hotelInitials,
  hotelNoteError,
  marketplaceProfileUrl,
  readApiError,
} from "./hotelSubmissions";

describe("hotel submission review copy", () => {
  it("names the hotel's location, type and initials", () => {
    expect(formatHotelLocation("Munich", "DE")).toBe("Munich, Germany");
    expect(formatHotelLocation(null, "PT")).toBe("Portugal");
    expect(formatHotelLocation(null, null)).toBe("Location not set");
    expect(formatPropertyType("guest_house")).toBe("Guest house");
    expect(formatPropertyType(null)).toBe("Hotel");
    expect(hotelInitials("Hotel Alpenrose Munich")).toBe("HA");
    expect(hotelInitials("Lumen")).toBe("LU");
    expect(hotelInitials(null)).toBe("H");
  });

  it("describes what happened to the previous submission", () => {
    expect(describeSubmissionHistory({ previous: null, live: false })).toEqual({
      label: "First submission",
      tone: "neutral",
      detail: null,
    });
    const decidedAt = "2026-10-11T12:00:00.000Z";
    expect(
      describeSubmissionHistory({
        previous: { status: "changes_requested", decidedAt },
        live: false,
      }),
    ).toEqual({
      label: "Resubmitted",
      tone: "warning",
      detail: `Changes requested ${formatSubmissionDate(decidedAt)}`,
    });
    expect(
      describeSubmissionHistory({ previous: { status: "approved", decidedAt }, live: true }),
    ).toEqual({ label: "Update", tone: "info", detail: "Current version is live" });
    expect(
      describeSubmissionHistory({
        previous: { status: "changes_requested", decidedAt },
        live: true,
      }).detail,
    ).toBe(`Changes requested ${formatSubmissionDate(decidedAt)} · current version is live`);
  });

  it("turns preferences into readable rows", () => {
    expect(
      describePreferences({
        compensationTypes: ["free_stay", "paid"],
        contentPlatforms: ["instagram", "tiktok"],
        contentTypes: ["short_form_video", "story"],
        availability: { mode: "selected_months", selectedMonths: [6, 7, 8] },
      }),
    ).toEqual([
      { label: "Compensation", value: "Free stay, Paid" },
      { label: "Platforms", value: "Instagram, TikTok" },
      { label: "Content", value: "Short videos, Stories" },
      { label: "Availability", value: "Jun, Jul, Aug" },
    ]);
    expect(describePreferences(null)).toEqual([]);
  });

  it("summarises who submitted which version", () => {
    const submittedAt = "2026-10-12T12:00:00.000Z";
    expect(
      describeSubmission({ submittedAt, submittedByEmail: "owner@example.com", revisionNumber: 1 }),
    ).toBe(
      `Submitted ${formatSubmissionDate(submittedAt)} by owner@example.com · First submission`,
    );
    expect(describeSubmission({ submittedAt, submittedByEmail: null, revisionNumber: 3 })).toBe(
      `Submitted ${formatSubmissionDate(submittedAt)} · Submission 3`,
    );
  });

  it("reads status and code from the shared client's errors", () => {
    expect(readApiError({ status: 409, data: { code: "submission_already_decided" } })).toEqual({
      status: 409,
      code: "submission_already_decided",
    });
    expect(readApiError(new Error("network"))).toEqual({ status: undefined, code: undefined });
    expect(readApiError(null)).toEqual({});
  });

  it("requires a one-line note of up to 1,000 characters", () => {
    expect(hotelNoteError("   ")).toBe("Write a note so the hotel knows what to change.");
    expect(hotelNoteError("x".repeat(1001))).toBe("Keep the note under 1,000 characters.");
    expect(hotelNoteError("first line\nsecond")).toBe(
      "Use one line without line breaks or special characters.",
    );
    expect(hotelNoteError("  Use a photo of the hotel as the cover.  ")).toBeNull();
  });

  it("explains refusals and says when the list is out of date", () => {
    expect(
      decisionErrorMessage({ status: 409, data: { code: "submission_already_decided" } }),
    ).toEqual({
      message: "Another admin already decided on this submission. The list has been refreshed.",
      refresh: true,
    });
    expect(
      decisionErrorMessage({ status: 409, data: { code: "marketplace_entitlement_inactive" } }),
    ).toEqual({
      message: "This hotel’s Marketplace access isn’t active, so its profile can’t be published.",
      refresh: false,
    });
    expect(
      decisionErrorMessage({ status: 409, data: { code: "submission_media_unavailable" } }).message,
    ).toBe(
      "The public preview can’t be shown, so this profile can’t be published yet. Request changes instead.",
    );
    expect(decisionErrorMessage({ status: 403, data: {} }).message).toBe(
      "You don’t have permission to review hotel profiles.",
    );
    expect(decisionErrorMessage(new TypeError("Failed to fetch")).message).toBe(
      "The decision could not be saved. Try again.",
    );
  });

  it("links to the public profile on the marketplace web app", () => {
    const previous = process.env.NEXT_PUBLIC_MARKETPLACE_URL;
    process.env.NEXT_PUBLIC_MARKETPLACE_URL = "https://next-marketplace.vayada.com/";
    expect(marketplaceProfileUrl("/hotels/abc")).toBe(
      "https://next-marketplace.vayada.com/hotels/abc",
    );
    if (previous === undefined) delete process.env.NEXT_PUBLIC_MARKETPLACE_URL;
    else process.env.NEXT_PUBLIC_MARKETPLACE_URL = previous;
  });
});
