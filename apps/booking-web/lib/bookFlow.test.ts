/** @vitest-environment jsdom */
import { beforeEach, expect, it } from "vitest";
import {
  bookEntry,
  bookStepQuery,
  bookSteps,
  clearBookFlowDraft,
  parseBookStep,
  reachableStep,
  readBookFlowDraft,
  saveBookFlowDraft,
  type BookFlowDraft,
} from "./bookFlow";

beforeEach(() => sessionStorage.clear());

it("shows Extras only for a hotel with extras", () => {
  expect(bookSteps(true)).toEqual(["rooms", "extras", "payment"]);
  expect(bookSteps(false)).toEqual(["rooms", "payment"]);
  expect(parseBookStep("extras")).toBe("extras");
  expect(parseBookStep("addons")).toBe("rooms");
  expect(parseBookStep(null)).toBe("rooms");
});

it("opens a later step only when the steps before it are complete", () => {
  const steps = bookSteps(true);
  expect(reachableStep("payment", steps, { rooms: true, extras: true })).toBe("payment");
  expect(reachableStep("payment", steps, { rooms: true, extras: false })).toBe("extras");
  expect(reachableStep("payment", steps, {})).toBe("rooms");
  // A hotel without extras: a link to Extras goes on to the next step.
  expect(reachableStep("extras", bookSteps(false), { rooms: true })).toBe("payment");
});

it("keeps the hand-off in the step URL and tells hand-offs apart", () => {
  const search = "?checkIn=2026-11-06&checkOut=2026-11-08&adults=2&offer=k";
  expect(bookStepQuery(search, "extras")).toBe(
    "checkIn=2026-11-06&checkOut=2026-11-08&adults=2&offer=k&step=extras",
  );
  expect(bookStepQuery(`${search}&step=payment`, "rooms")).toBe(search.slice(1));
  expect(bookEntry(`${search}&step=payment`)).toBe(bookEntry(search));
  expect(bookEntry(search)).not.toBe(bookEntry(search.replace("adults=2", "adults=3")));
});

const draft: BookFlowDraft = {
  version: 1,
  entry: "checkIn=2026-11-06",
  checkIn: "2026-11-06",
  checkOut: "2026-11-08",
  promoCode: "",
  choices: [{ selectionId: "r1", publicOfferKey: "k", adults: "2", childAges: ["4"] }],
  allocationRevision: 3,
  extras: null,
  payment: "card",
};

it("brings a tab's draft back for the same hand-off only", () => {
  saveBookFlowDraft("alpenrose", draft);
  expect(readBookFlowDraft("alpenrose", draft.entry)).toEqual(draft);
  expect(readBookFlowDraft("alpenrose", "checkIn=2026-12-01")).toBeNull();
  expect(readBookFlowDraft("other-hotel", draft.entry)).toBeNull();
  clearBookFlowDraft("alpenrose");
  expect(readBookFlowDraft("alpenrose", draft.entry)).toBeNull();
});

it("ignores a draft it can't trust", () => {
  sessionStorage.setItem("bookFlow:alpenrose", "{not json");
  expect(readBookFlowDraft("alpenrose", draft.entry)).toBeNull();
  sessionStorage.setItem(
    "bookFlow:alpenrose",
    JSON.stringify({ ...draft, payment: "cash", choices: [{ selectionId: 1 }] }),
  );
  expect(readBookFlowDraft("alpenrose", draft.entry)).toBeNull();
});
