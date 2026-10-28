/** @vitest-environment jsdom */
import { beforeEach, expect, it } from "vitest";
import {
  bookEntry,
  bookStepQuery,
  bookSteps,
  clearBookFlowDraft,
  clearStayCarryOver,
  parseBookStep,
  reachableStep,
  readBookFlowDraft,
  readStayCarryOver,
  saveBookFlowDraft,
  saveStayCarryOver,
  type BookFlowDraft,
  type StayCarryOver,
} from "./bookFlow";

beforeEach(() => sessionStorage.clear());

it("shows Extras only for a hotel with extras", () => {
  expect(bookSteps(true)).toEqual(["rooms", "extras", "details", "payment"]);
  expect(bookSteps(false)).toEqual(["rooms", "details", "payment"]);
  expect(parseBookStep("extras")).toBe("extras");
  expect(parseBookStep("addons")).toBe("rooms");
  expect(parseBookStep(null)).toBe("rooms");
});

it("opens a later step only when the steps before it are complete", () => {
  const steps = bookSteps(true);
  expect(reachableStep("payment", steps, { rooms: true, extras: true, details: true })).toBe(
    "payment",
  );
  expect(reachableStep("payment", steps, { rooms: true, extras: true })).toBe("details");
  expect(reachableStep("payment", steps, { rooms: true, extras: false })).toBe("extras");
  expect(reachableStep("details", steps, {})).toBe("rooms");
  // A hotel without extras: a link to Extras goes on to the next step.
  expect(reachableStep("extras", bookSteps(false), { rooms: true })).toBe("details");
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
  guest: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
    phone: "",
    countryCode: "",
    arrivalTime: "",
    specialRequests: "",
  },
};

it("brings a tab's draft back for the same hand-off only", () => {
  saveBookFlowDraft("alpenrose", draft);
  expect(readBookFlowDraft("alpenrose", draft.entry)).toEqual(draft);
  expect(readBookFlowDraft("alpenrose", "checkIn=2026-12-01")).toBeNull();
  expect(readBookFlowDraft("other-hotel", draft.entry)).toBeNull();
  clearBookFlowDraft("alpenrose");
  expect(readBookFlowDraft("alpenrose", draft.entry)).toBeNull();
});

it("keeps only the guest's text fields from a draft", () => {
  sessionStorage.setItem(
    "bookFlow:alpenrose",
    JSON.stringify({ ...draft, guest: { firstName: "Ada", phone: 49, terms: true } }),
  );
  expect(readBookFlowDraft("alpenrose", draft.entry)?.guest).toEqual({
    ...draft.guest,
    lastName: "",
    email: "",
  });
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

// VAY-2393: Change or Remove on the Extras step hands its choices to the next hand-off.
it("carries a changed room's choices over to the same stay for a while", () => {
  const carry: StayCarryOver = {
    checkIn: draft.checkIn,
    checkOut: draft.checkOut,
    childAges: [["4"], []],
    extras: { scope: "old", items: [] },
    payment: "pay_at_property",
    guest: draft.guest,
    at: 1_000_000,
  };
  saveStayCarryOver("alpenrose", carry);
  const stay = { checkIn: draft.checkIn, checkOut: draft.checkOut };
  expect(readStayCarryOver("alpenrose", stay, 1_000_000 + 60_000)).toEqual(carry);
  // Other dates, or after 30 minutes: nothing carries over.
  expect(readStayCarryOver("alpenrose", { ...stay, checkOut: "2026-11-09" }, 1_000_000)).toBe(null);
  expect(readStayCarryOver("alpenrose", stay, 1_000_000 + 30 * 60_000)).toBeNull();
  sessionStorage.setItem("bookCarry:alpenrose", JSON.stringify({ ...carry, childAges: [[4]] }));
  expect(readStayCarryOver("alpenrose", stay, 1_000_000)).toBeNull();
  clearStayCarryOver("alpenrose");
  expect(sessionStorage.getItem("bookCarry:alpenrose")).toBeNull();
});
