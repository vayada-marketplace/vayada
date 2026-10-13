import { describe, expect, it } from "vitest";

import {
  isMarketplaceHotelSubmissionNote,
  parseMarketplaceHotelSubmissionDecisionRequest,
} from "./hotelSubmissionModeration.js";

describe("hotel submission moderation contract", () => {
  it("accepts approve without a note and request_changes with one", () => {
    expect(parseMarketplaceHotelSubmissionDecisionRequest({ decision: "approve" })).toEqual({
      decision: "approve",
    });
    expect(
      parseMarketplaceHotelSubmissionDecisionRequest({
        decision: "request_changes",
        note: "Use a photo of the hotel as the cover.",
      }),
    ).toEqual({ decision: "request_changes", note: "Use a photo of the hotel as the cover." });
  });

  it.each([
    null,
    [],
    {},
    { decision: "reject", note: "No" },
    { decision: "approve", note: "Looks good" },
    { decision: "request_changes", note: "x", extra: true },
  ])("rejects malformed decision %#", (value) => {
    expect(parseMarketplaceHotelSubmissionDecisionRequest(value)).toBe("invalid_decision");
  });

  it.each([undefined, "", " padded ", "two\nlines", "x".repeat(1001), "bad\ud800"])(
    "requires a one-line note for request_changes %#",
    (note) => {
      expect(
        parseMarketplaceHotelSubmissionDecisionRequest({ decision: "request_changes", note }),
      ).toBe("invalid_note");
    },
  );

  it("accepts a 1,000 character note", () => {
    expect(isMarketplaceHotelSubmissionNote("x".repeat(1000))).toBe(true);
  });
});
