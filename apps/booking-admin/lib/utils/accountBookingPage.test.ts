import { defaultAccountBookingPageSettings } from "@vayada/domain-booking/account-booking-page";
import { describe, expect, it } from "vitest";
import type { AccountBookingPageProperty } from "@/services/api/accountBookingPageClient";
import {
  contactValue,
  controlFree,
  draftProblems,
  filterSplit,
  includeAllReady,
  moveIncluded,
  orderedProperties,
  propertyStatus,
  setIncluded,
  validEmail,
  validWhatsapp,
  type AccountBookingPageDraft,
} from "./accountBookingPage";

// VAY-2457: the rules behind Settings › Multi-property booking engine.
function stay(
  id: string,
  changes: Partial<AccountBookingPageProperty> = {},
): AccountBookingPageProperty {
  return {
    propertyId: id,
    name: id,
    propertyType: "villa",
    area: "Ubud",
    photoUrl: null,
    units: 2,
    ready: true,
    missing: [],
    included: false,
    ...changes,
  };
}

function draft(changes: Partial<AccountBookingPageDraft> = {}): AccountBookingPageDraft {
  return {
    slug: "thetravelubud",
    live: false,
    settings: defaultAccountBookingPageSettings("The Travel Ubud"),
    propertyIds: ["a", "b"],
    headerImage: null,
    ...changes,
  };
}

describe("agency booking page form rules", () => {
  it("names what keeps a stay off the page, else whether the page shows it", () => {
    expect(propertyStatus(stay("a"), true)).toBe("live");
    expect(propertyStatus(stay("a"), false)).toBe("hidden");
    const missing = (list: AccountBookingPageProperty["missing"]) =>
      propertyStatus(stay("a", { ready: false, missing: list }), true);
    expect(missing(["setup", "type", "location"])).toBe("notSetUp");
    expect(missing(["type"])).toBe("noType");
    expect(missing(["location"])).toBe("noLocation");
    expect(missing(["type", "location"])).toBe("noTypeNoLocation");
  });

  it("includes stays at the end and resets the design when its stay leaves", () => {
    expect(setIncluded(draft(), "c", true).propertyIds).toEqual(["a", "b", "c"]);
    expect(setIncluded(draft(), "a", true).propertyIds).toEqual(["b", "a"]);
    const designed = draft();
    designed.settings.header.designPropertyId = "b";
    const without = setIncluded(designed, "b", false);
    expect(without.propertyIds).toEqual(["a"]);
    expect(without.settings.header.designPropertyId).toBeNull();
    expect(setIncluded(designed, "a", false).settings.header.designPropertyId).toBe("b");
  });

  it("adds every ready stay not yet included, in the list's order", () => {
    const properties = [
      stay("a"),
      stay("c"),
      stay("d", { ready: false, missing: ["type"] }),
      stay("e"),
    ];
    expect(includeAllReady(draft(), properties).propertyIds).toEqual(["a", "b", "c", "e"]);
    const all = draft({ propertyIds: ["a", "c", "e"] });
    expect(includeAllReady(all, properties)).toBe(all);
  });

  it("moves an included stay within the order and ignores moves out of range", () => {
    expect(moveIncluded(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveIncluded(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveIncluded(["a", "b", "c"], "a", 3)).toEqual(["a", "b", "c"]);
    expect(moveIncluded(["a", "b", "c"], "x", 0)).toEqual(["a", "b", "c"]);
  });

  it("lists included stays first in their order, then the others as listed", () => {
    const list = orderedProperties([stay("a"), stay("b"), stay("c"), stay("d")], ["c", "a"]);
    expect(list.map((property) => property.propertyId)).toEqual(["c", "a", "b", "d"]);
  });

  it("shows the type and area filters only when they split the included stays", () => {
    const villas = [stay("a"), stay("b")];
    expect(filterSplit("propertyType", villas)).toEqual({ splits: false, values: ["villa"] });
    const mixed = [...villas, stay("c", { propertyType: "resort", area: " Penestanan " })];
    expect(filterSplit("propertyType", mixed)).toEqual({
      splits: true,
      values: ["villa", "resort"],
    });
    expect(filterSplit("area", mixed)).toEqual({ splits: true, values: ["Ubud", "Penestanan"] });
    expect(filterSplit("area", [stay("a", { area: null }), stay("b", { area: "" })]).splits).toBe(
      false,
    );
    expect(filterSplit("price", villas)).toEqual({ splits: true, values: [] });
  });

  it("finds what next-api would refuse, field by field", () => {
    expect(draftProblems(draft())).toEqual(new Set());
    const broken = draft({ slug: "The Travel Ubud" });
    broken.settings.page.title = "  ";
    broken.settings.page.description = "x".repeat(301);
    broken.settings.header.contact = true;
    expect(draftProblems(broken)).toEqual(
      new Set(["titleRequired", "descriptionTooLong", "invalidSlug", "contactNeeded"]),
    );
    const contact = draft();
    contact.settings.header.contact = true;
    contact.settings.header.contactEmail = "stay@";
    contact.settings.header.contactWhatsapp = "0812";
    expect(draftProblems(contact)).toEqual(new Set(["invalidEmail", "invalidWhatsapp"]));
    contact.settings.header.contactEmail = "stay@travelubud.example";
    contact.settings.header.contactWhatsapp = "+6281234567890";
    expect(draftProblems(contact)).toEqual(new Set());
  });

  it("keeps title and description on one line, as next-api requires", () => {
    expect(controlFree("The\tTravel\r\nUbud")).toBe("The Travel Ubud");
    expect(controlFree("Ubud")).toBe("Ubud");
  });

  it("checks contacts as next-api does", () => {
    expect(validEmail("stay@travelubud.example")).toBe(true);
    for (const value of [null, "stay@", "stay @x.y", `${"a".repeat(250)}@x.yz`])
      expect(validEmail(value), String(value)).toBe(false);
    expect(validWhatsapp("+6281234567890")).toBe(true);
    for (const value of [null, "6281234567890", "+0812345678", "+62 812"])
      expect(validWhatsapp(value), String(value)).toBe(false);
  });

  it("keeps typed contacts tidy: trimmed, numbers without spaces, empty as none", () => {
    expect(contactValue("  stay@travelubud.example ", "email")).toBe("stay@travelubud.example");
    expect(contactValue("+62 (812) 3456-7890", "whatsapp")).toBe("+6281234567890");
    expect(contactValue("   ", "email")).toBeNull();
  });
});
