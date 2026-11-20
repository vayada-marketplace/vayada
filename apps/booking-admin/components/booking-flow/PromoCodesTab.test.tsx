import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n", async () => {
  const en = (await import("../../messages/en.json")).default as Record<string, string>;
  const t = (key: string, values: Record<string, string | number> = {}) =>
    (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
      String(values[name] ?? `{${name}}`),
    );
  return { useTranslation: () => ({ t, locale: "en" }) };
});

import type { BookingPromoCode } from "@/services/api/bookingPromoCodesClient";
import PromoCodesTab from "./PromoCodesTab";

const base: BookingPromoCode = {
  promoCodeId: "promo-hotel",
  hotelId: "hotel",
  propertyId: "property",
  code: "SUMMER20",
  discountType: "percentage",
  discountValue: "20.00",
  minBookingValue: null,
  applicableRoomIds: null,
  validFrom: null,
  validUntil: null,
  stayDateFrom: null,
  stayDateUntil: null,
  isActive: true,
  maxUses: 50,
  currentUses: 3,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  managedBy: null,
};

function render(props: Partial<Parameters<typeof PromoCodesTab>[0]> = {}) {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <PromoCodesTab
        promoCodes={[
          base,
          { ...base, promoCodeId: "promo-partner", code: "MIA10", managedBy: "Partner App" },
        ]}
        propertyCurrency="EUR"
        propertyTimeZone="Europe/Vienna"
        roomTypes={[]}
        onCreatePromoCode={vi.fn()}
        onUpdatePromoCode={vi.fn()}
        onDeletePromoCode={vi.fn()}
        onTogglePromoCode={vi.fn()}
        {...props}
      />,
    );
  });
  return view;
}

const labels = (view: ReactTestRenderer) =>
  view.root.findAll((node) => node.type === "button").map((node) => node.props["aria-label"]);

describe("Promos page: a connected app's codes (VAY-2437)", () => {
  it("marks a partner app's code as managed by it and offers no switch, edit or delete for it", () => {
    const view = render();
    const text = JSON.stringify(view.toJSON());
    expect(text).toContain("Managed by Partner App");
    expect(text).toContain("Change it in Partner App");
    expect(labels(view)).toEqual(expect.arrayContaining(["Edit SUMMER20", "Delete SUMMER20"]));
    expect(labels(view).filter((label) => String(label).includes("MIA10"))).toEqual([]);
  });

  it("doesn't open a partner app's code from a notification link", () => {
    const onPromoCodeOpened = vi.fn();
    const view = render({ openPromoCodeId: "promo-partner", onPromoCodeOpened });
    expect(onPromoCodeOpened).toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).not.toContain('"role":"dialog"');
  });
});
