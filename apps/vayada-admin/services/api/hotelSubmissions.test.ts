import { describe, expect, it } from "vitest";

import {
  describePreferences,
  describeSubmission,
  describeSubmissionHistory,
  formatHotelLocation,
  formatPropertyType,
  formatSubmissionDate,
  hotelInitials,
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
});
