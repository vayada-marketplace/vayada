import { describe, expect, it } from "vitest";

import {
  firstRunUuid,
  runFirstRunPricing,
  type HotelFirstRunPricingPorts,
} from "./hotelFirstRunPricing.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";
import { PricingStorageError } from "./replacementPricingStore.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const roomTypeId = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const actor = { propertyId } as HotelFirstRunActor;
const input = {
  roomTypeId,
  capacity: { total: 2, adults: 2, children: 1 },
  currency: "EUR",
  pricePerNight: "145",
  pricesIncludeMandatoryCharges: true,
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Draft = {
  revision: number;
  baseRevision: number;
  snapshot: { ownerReferences: Record<string, string> };
};

/** pricing-v2 in memory: records the call order and keeps one draft. */
function fakePricing(start: { priced?: boolean; draft?: Draft; fail?: string } = {}) {
  const calls: Array<[string, unknown]> = [];
  let draft: Draft | null = start.draft ?? null;
  const record = (name: string, value?: unknown) => calls.push([name, value]);
  const pricing = {
    read: async () => {
      record("read");
      return start.priced
        ? { revision: 3, currency: "EUR", rooms: [{ roomTypeId, offers: [{}] }] }
        : null;
    },
    stageTerms: async (_id: string, command: unknown, context: unknown) => {
      record("stageTerms", { command, context });
      if (start.fail) throw new PricingStorageError(start.fail as "stale");
      return { revision: "11111111-2222-4333-8444-555555555555" };
    },
    prepare: async (
      _id: string,
      value: { rooms: Array<{ revision: number; offers: unknown[] }> },
    ) => {
      record("prepare", value);
      return { sources: { rooms: "1" }, snapshot: { ownerReferences: {} } };
    },
    readDraft: async () => {
      record("readDraft");
      return draft;
    },
    saveDraft: async (
      _id: string,
      value: { expectedDraftRevision: number; snapshot: Draft["snapshot"] },
    ) => {
      record("saveDraft", value);
      draft = {
        revision: value.expectedDraftRevision + 1,
        baseRevision: 0,
        snapshot: value.snapshot,
      };
      return draft.revision;
    },
    reviewCharges: async (_id: string, draftId: string) => {
      record("reviewCharges");
      return draft
        ? {
            draftId,
            ...draft,
            sources: { rooms: "1" },
            fingerprint: "f".repeat(64),
            declaration: "all_mandatory_charges_included",
          }
        : null;
    },
    confirmCharges: async (_id: string, value: unknown) => {
      record("confirmCharges", value);
      return { id: "99999999-8888-4777-8666-555555555555" };
    },
    publish: async (_id: string, value: unknown) => {
      record("publish", value);
      return { revision: 1, replayed: false };
    },
  } as unknown as HotelFirstRunPricingPorts["pricing"];
  return { ports: { pricing }, calls, draft: () => draft };
}

describe("first run step 4: the first price (VAY-2247)", () => {
  it("stages terms, prepares, saves, declares the taxes, attaches the declaration and publishes", async () => {
    const fake = fakePricing();
    expect(await runFirstRunPricing(fake.ports, actor, input)).toEqual({ ok: true, wrote: true });
    expect(fake.calls.map(([name]) => name)).toEqual([
      "read",
      "stageTerms",
      "prepare",
      "readDraft",
      "saveDraft",
      "reviewCharges",
      "confirmCharges",
      "saveDraft",
      "publish",
    ]);
    const staged = fake.calls[1]![1] as {
      command: { expectedRevision: null; terms: { offerId: string } };
      context: { draftId: string; baseRevision: number };
    };
    expect(staged.command.expectedRevision).toBeNull();
    expect(staged.command.terms.offerId).toMatch(uuidPattern);
    expect(staged.context).toEqual({
      draftId: expect.stringMatching(uuidPattern),
      baseRevision: 0,
    });
    // The staged terms revision replaces the offer's own, and the rooms move to the next revision.
    const prepared = fake.calls[2]![1] as {
      rooms: Array<{ revision: number; offers: Array<{ termsRevision: string }> }>;
    };
    expect(prepared.rooms[0]!.revision).toBe(1);
    expect(prepared.rooms[0]!.offers[0]!.termsRevision).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(fake.calls[6]![1]).toMatchObject({
      expectedDraftRevision: 1,
      declaration: "all_mandatory_charges_included",
      declaredVia: "save_prices",
    });
    expect(fake.calls[8]![1]).toMatchObject({
      expectedRevision: 0,
      draft: { revision: 2 },
      snapshot: { ownerReferences: { charges: "99999999-8888-4777-8666-555555555555" } },
    });
  });

  it("never declares the taxes on the hotel's behalf", async () => {
    const fake = fakePricing();
    expect(
      await runFirstRunPricing(fake.ports, actor, {
        ...input,
        pricesIncludeMandatoryCharges: false,
      }),
    ).toEqual({
      ok: false,
      code: "mandatory_charges_declaration_required",
      cause: undefined,
    });
    expect(fake.calls).toEqual([]);
  });

  it("leaves a room type alone that already has a price", async () => {
    const fake = fakePricing({ priced: true });
    expect(await runFirstRunPricing(fake.ports, actor, input)).toEqual({ ok: true, wrote: false });
    expect(fake.calls.map(([name]) => name)).toEqual(["read"]);
  });

  it("resumes after the declaration was attached but before publishing", async () => {
    const fake = fakePricing({
      draft: {
        revision: 2,
        baseRevision: 0,
        snapshot: { ownerReferences: { charges: "existing-charges" } },
      },
    });
    expect(await runFirstRunPricing(fake.ports, actor, input)).toEqual({ ok: true, wrote: true });
    expect(fake.calls.map(([name]) => name)).toEqual([
      "read",
      "stageTerms",
      "prepare",
      "readDraft",
      "reviewCharges",
      "publish",
    ]);
    expect(fake.calls[5]![1]).toMatchObject({ draft: { revision: 2 } });
  });

  it("turns a pricing store refusal into a step error", async () => {
    expect(
      await runFirstRunPricing(fakePricing({ fail: "stale" }).ports, actor, input),
    ).toMatchObject({
      ok: false,
      code: "first_run_pricing_stale",
    });
  });

  it("derives stable UUIDs", () => {
    expect(firstRunUuid(propertyId, "x", 1)).toBe(firstRunUuid(propertyId, "x", 1));
    expect(firstRunUuid(propertyId, "x", 1)).not.toBe(firstRunUuid(propertyId, "x", 2));
    expect(firstRunUuid(propertyId, "x")).toMatch(uuidPattern);
  });
});
