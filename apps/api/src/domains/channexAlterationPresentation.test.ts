import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { presentChannexAlteration } from "./channexAlterationPresentation.js";
const snapshot = () => ({
  channex: {
    eventId: randomUUID(),
    connectionId: randomUUID(),
    bindingGeneration: randomUUID(),
    providerPropertyId: randomUUID(),
  },
  oldTotal: "300.00",
  newTotal: null,
  priceDifference: null,
  currency: "EUR",
  oldAdults: 2,
  requestedAdults: 3,
});
it("keeps unknown money unknown and actions off by default", () => {
  expect(presentChannexAlteration(snapshot())).toMatchObject({
    state: "pending",
    oldTotal: 300,
    newTotal: null,
    priceDifference: null,
    allowedActions: [],
    refreshAction: null,
  });
});
it("projects provider outcomes without leaking binding or actor metadata", () => {
  const base = snapshot();
  const journal = {
    action: "accept",
    actorUserId: randomUUID(),
    sendStartedAt: "2026-09-01",
    providerState: "declined",
    deliveryState: "resolved",
  };
  const result = presentChannexAlteration(
    { ...base, channex: { ...base.channex, decision: journal } },
    true,
  );
  expect(result).toMatchObject({ state: "declined", allowedActions: [], refreshAction: null });
  expect(JSON.stringify(result)).not.toContain(base.channex.eventId);
  expect(JSON.stringify(result)).not.toContain(journal.actorUserId);
});
it.each(["accept", "decline"])("exposes only readback for uncertain %s", (action) => {
  const base = snapshot();
  expect(
    presentChannexAlteration(
      { ...base, channex: { ...base.channex, decision: { action, sendStartedAt: "2026-09-01" } } },
      true,
    ),
  ).toMatchObject({ state: "unknown", allowedActions: [], refreshAction: action });
});
it("keeps acceptance distinct from an applied booking revision", () => {
  const base = snapshot();
  const changes = {
    ...base,
    channex: { ...base.channex, decision: { action: "accept", providerState: "accepted" } },
  };
  expect(presentChannexAlteration(changes, true)).toMatchObject({
    state: "awaiting_confirmation",
    allowedActions: [],
  });
  expect(presentChannexAlteration(changes, true, "accepted")).toMatchObject({
    state: "applied",
    allowedActions: [],
  });
});
it("does not enable malformed provider records", () => {
  expect(presentChannexAlteration({ channex: {} }, true)).toMatchObject({
    state: "unavailable",
    allowedActions: [],
  });
  expect(presentChannexAlteration({}, true)).toBeUndefined();
});
