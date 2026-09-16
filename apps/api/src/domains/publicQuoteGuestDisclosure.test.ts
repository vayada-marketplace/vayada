import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import { createPublicQuoteGuestDisclosure } from "./publicQuoteGuestDisclosure.js";
vi.mock("./currentQuoteGuestDisclosure.js", () => ({ lockCurrentQuoteGuestDisclosure: vi.fn() }));
const quoteId = "11111111-1111-4111-8111-111111111111";
const choices = {
  defaultGuestLanguage: "en",
  childrenEnabled: true,
  adultAgeThreshold: 12,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
  checkInUntil: "00:00",
  checkOutFrom: "06:00",
};
const current = {
  quote: {
    quoteId,
    evidence: {
      issuedAt: "2026-09-14T00:00:00.000Z",
      expiresAt: "2026-09-14T00:05:00.000Z",
      revisions: { finance: "private" },
    },
  },
  quoteEvidenceId: `sha256:${"a".repeat(64)}`,
  guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
  checkedAt: "2026-09-14T00:01:00.000Z",
  disclosure: { propertyTimeZone: "Europe/Berlin", choices },
  policy: { sourceRevision: "private-policy" },
  disclosureJson: "private-disclosure",
};
const query = vi.fn();
const release = vi.fn();
const connect = vi.fn(async () => ({ query, release }));
const read = createPublicQuoteGuestDisclosure({ connect } as unknown as Pool).read;
beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockResolvedValue(current as never);
});
it("projects exact current quote identities and complete guest choices without private evidence", async () => {
  const result = await read("hotel", quoteId);
  expect(result).toEqual({
    version: "public-quote-guest-disclosure.v1",
    quoteId,
    quoteEvidenceId: current.quoteEvidenceId,
    guestPolicyEvidenceId: current.guestPolicyEvidenceId,
    issuedAt: current.quote.evidence.issuedAt,
    expiresAt: current.quote.evidence.expiresAt,
    checkedAt: current.checkedAt,
    propertyTimeZone: "Europe/Berlin",
    choices,
  });
  expect(result!.choices).not.toBe(choices);
  expect(lockCurrentQuoteGuestDisclosure).toHaveBeenCalledWith(
    { query, release },
    "hotel",
    quoteId,
  );
  expect(query.mock.calls.map(([sql]) => sql)).toEqual([
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "ROLLBACK",
  ]);
  expect(release).toHaveBeenCalledOnce();
});
it("returns no disclosure for stale/unavailable owner evidence and rejects malformed IDs before reads", async () => {
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockResolvedValueOnce(null);
  expect(await read("hotel", quoteId)).toBeNull();
  expect(await read("hotel", "bad-id")).toBeNull();
  expect(connect).toHaveBeenCalledOnce();
});
it("rolls back and releases after owner failure, and releases after rollback failure", async () => {
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockRejectedValueOnce(new Error("owner"));
  await expect(read("hotel", quoteId)).rejects.toThrow("owner");
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(release).toHaveBeenCalledOnce();
  query.mockRejectedValueOnce(new Error("begin")).mockRejectedValueOnce(new Error("rollback"));
  await expect(read("hotel", quoteId)).rejects.toThrow("rollback");
  expect(release).toHaveBeenCalledTimes(2);
});
