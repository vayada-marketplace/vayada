import { beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { finishCurrentQuoteAcceptanceTime } from "./currentQuoteAcceptanceTime.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
const scope = {
  propertyId: "property",
  organizationId: "organization",
  authorityRevision: "00000000-0000-4000-8000-000000000001",
};
const current = {
  scope,
  quote: {
    stay: { checkIn: "2026-09-14" },
    evidence: {
      issuedAt: "2026-09-14T09:55:00.000Z",
      expiresAt: "2026-09-14T10:05:00.000Z",
    },
  },
  sameDay: { propertyTimeZone: "Asia/Taipei", policyRevision: 2, currentLocalDate: "2026-09-14" },
} as Parameters<typeof finishCurrentQuoteAcceptanceTime>[2];
let policy: unknown;
let timezone: string;
let now: Date;
let events: string[];
const query = vi.fn(async (sql: string) => {
  if (sql.includes("same_day_booking_policies")) {
    events.push("policy");
    return { rows: policy ? [policy] : [] };
  }
  if (sql.includes("property_locations")) {
    events.push("location");
    return { rows: [{ timezone }] };
  }
  expect(sql).toBe("SELECT clock_timestamp() AS now");
  events.push("clock");
  return { rows: [{ now }] };
});
const client = { query } as unknown as PoolClient;
beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  policy = { enabled: true, cutoffLocalTime: "18:00", revision: 2 };
  timezone = "Asia/Taipei";
  now = new Date("2026-09-14T09:59:59.999Z");
  vi.mocked(lockPublicPricingAuthority).mockImplementation(async () => {
    events.push("authority");
    return scope as Awaited<ReturnType<typeof lockPublicPricingAuthority>>;
  });
});
it("reads the database clock after every owner and authority wait, preserving the quote", async () => {
  const original = structuredClone(current);
  expect(await finishCurrentQuoteAcceptanceTime(client, "hotel", current)).toBe(now.toISOString());
  expect(events).toEqual(["policy", "location", "authority", "clock"]);
  expect(current).toEqual(original);
  expect(query.mock.calls.every(([sql]) => !/UPDATE|INSERT|COMMIT|ROLLBACK/.test(sql))).toBe(true);
});
it("rejects a cutoff crossed while waiting for public authority", async () => {
  vi.mocked(lockPublicPricingAuthority).mockImplementation(async () => {
    now = new Date("2026-09-14T10:00:00.000Z");
    return scope as Awaited<ReturnType<typeof lockPublicPricingAuthority>>;
  });
  await expect(finishCurrentQuoteAcceptanceTime(client, "hotel", current)).rejects.toThrow(
    "unavailable",
  );
});
it.each(["2026-09-14T09:54:59.999Z", "2026-09-14T10:05:00.000Z", "invalid"])(
  "rejects an unissued, expired or invalid database time %s",
  async (value) => {
    now = new Date(value);
    policy = { enabled: true, cutoffLocalTime: null, revision: 2 };
    await expect(finishCurrentQuoteAcceptanceTime(client, "hotel", current)).rejects.toThrow(
      "unavailable",
    );
  },
);
it.each([
  { enabled: false, cutoffLocalTime: null, revision: 2 },
  { enabled: true, cutoffLocalTime: "17:17", revision: 2 },
  { enabled: true, cutoffLocalTime: null, revision: 3 },
  { enabled: "yes", cutoffLocalTime: null, revision: 2 },
  null,
])("rejects disabled, malformed, changed or removed policies %j", async (value) => {
  policy = value;
  await expect(finishCurrentQuoteAcceptanceTime(client, "hotel", current)).rejects.toThrow(
    "unavailable",
  );
});
it("rejects changed timezone or revoked/different public scope", async () => {
  timezone = "UTC";
  await expect(finishCurrentQuoteAcceptanceTime(client, "hotel", current)).rejects.toThrow(
    "unavailable",
  );
  timezone = "Asia/Taipei";
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(null);
  await expect(finishCurrentQuoteAcceptanceTime(client, "hotel", current)).rejects.toThrow(
    "unavailable",
  );
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue({
    ...scope,
    propertyId: "other",
  } as never);
  await expect(finishCurrentQuoteAcceptanceTime(client, "hotel", current)).rejects.toThrow(
    "unavailable",
  );
});
it("rejects a changed authority revision", async () => {
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue({
    ...scope,
    authorityRevision: "00000000-0000-4000-8000-000000000002",
  });
  await expect(finishCurrentQuoteAcceptanceTime(client, "hotel", current)).rejects.toThrow(
    "unavailable",
  );
});
it("preserves the existing absent-policy default and rejects a changed property date", async () => {
  policy = null;
  const absent = { ...current, sameDay: { ...current.sameDay, policyRevision: 0 } };
  expect(await finishCurrentQuoteAcceptanceTime(client, "hotel", absent)).toBe(now.toISOString());
  absent.sameDay.currentLocalDate = "2026-09-13";
  await expect(finishCurrentQuoteAcceptanceTime(client, "hotel", absent)).rejects.toThrow(
    "unavailable",
  );
});
