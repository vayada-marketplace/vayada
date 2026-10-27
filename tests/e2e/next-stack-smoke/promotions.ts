import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  findPricingOffer,
  guestMoney,
  issueGuestQuote,
  parseGuestQuote,
  runQuoteLifecycle,
  waitForOffer,
  type BookingResource,
  type GuestQuote,
  type Stay,
} from "./booking-lifecycle";
import { NEXT_STACK_ORIGINS, record, type JsonApi, type SmokeEnvironment } from "./support";

export async function runPromotionAcceptance(input: {
  api: JsonApi;
  bookings: BookingResource[];
  environment: SmokeEnvironment;
  page: Page;
  propertyId: string;
  request: APIRequestContext;
  roomTypeId: string;
  slug: string;
  stay: Stay;
}): Promise<void> {
  const { api, bookings, environment, page, propertyId, request, roomTypeId, slug, stay } = input;
  const settingsPath = `/api/booking/hotels/${propertyId}/settings/last-minute`;
  const codesPath = `/api/booking/hotels/${propertyId}/promo-codes`;
  const acceptancePath = `/api/pms/properties/${propertyId}/booking-acceptance`;
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Early bird", exact: true }) });
  // The offer a guest books: the room card hands its key to /book, and the quote prices it.
  const offer = await findPricingOffer(request, slug, roomTypeId);
  const guestUrl = `https://${slug}.next-booking.vayada.com/en/book`;
  const guestQuery = (promoCode?: string) =>
    new URLSearchParams({
      offer: offer.publicOfferKey,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      adults: "2",
      children: "0",
      rooms: "1",
      ...(promoCode ? { promoCode } : {}),
    });

  /**
   * Opens /book the way a room card does (offer hand-off), which lands on the details step and
   * prices the stay. Returns that price and checks the summary shows it: the total, and a
   * Discount row only when something is taken off. Each visit gets its own tab, so no draft from
   * an earlier visit (sessionStorage) carries over.
   */
  async function readGuestCheckout(promoCode?: string): Promise<GuestQuote> {
    const guest = await page.context().newPage();
    try {
      const [response] = await Promise.all([
        guest.waitForResponse(
          (candidate) =>
            candidate.request().method() === "POST" &&
            new URL(candidate.url()).pathname.endsWith(`/hotels/${slug}/bookings/quote`) &&
            candidate.ok(),
          { timeout: 45_000 },
        ),
        guest.goto(`${guestUrl}?${guestQuery(promoCode)}`),
      ]);
      const quote = parseGuestQuote(record(await response.json()));
      // Step 2 of the checkout (VAY-2347): the heading the hand-off lands on.
      await expect(
        guest.getByRole("heading", { name: "Who’s staying?", exact: true }),
      ).toBeVisible();
      await expect(guest.getByTestId("stay-total")).toContainText(
        guestMoney(quote.totalMinor, quote.currency),
      );
      const discount = guest.getByText("Discount", { exact: true });
      if (quote.discountMinor > BigInt(0)) {
        await expect(discount).toBeVisible();
        await expect(discount.locator("..")).toContainText(
          `−${guestMoney(quote.discountMinor, quote.currency)}`,
        );
      } else {
        await expect(discount).toHaveCount(0);
      }
      return quote;
    } finally {
      await guest.close();
    }
  }

  /** The guest pays exactly `totalMinor` with nothing taken off: in the API quote and on /book. */
  async function expectGuestPrice(totalMinor: string, key: string): Promise<void> {
    const quote = await issueGuestQuote(request, environment, slug, stay, offer, key);
    expect(quote.totalMinor).toBe(totalMinor);
    expect(quote.discountMinor).toBe(BigInt(0));
    expect((await readGuestCheckout()).totalMinor).toBe(totalMinor);
  }

  await test.step("create, edit and pause an automatic promotion in deployed Promos", async () => {
    await page.goto(`${NEXT_STACK_ORIGINS.bookingAdmin}/promo-codes`);
    await expect(page.getByRole("heading", { name: "Promos", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New promotion", exact: true }).click();
    await page.getByRole("menuitem", { name: "Early bird", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "New early bird promotion" });
    // The smoke stay starts 60 days out, so the 30+ days chip still applies to it.
    await editor.getByRole("radio", { name: "30+ days", exact: true }).locator("..").click();
    await editor.getByRole("button", { name: "Create promotion", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(card).toContainText("10% off");
    await card.getByRole("button", { name: "Edit Early bird", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit early bird promotion" });
    await edit.getByRole("spinbutton", { name: "Discount", exact: true }).fill("20");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(card).toContainText("20% off");
    await card.getByRole("switch").click();
    await expect(card).toContainText("Paused");
    await page.reload();
    await expect(card).toContainText("Paused");
    const saved = await api.json<Record<string, unknown>>("GET", settingsPath);
    expect(saved.promotions).toEqual([
      expect.objectContaining({
        type: "EARLY_BIRD",
        active: false,
        discountPercent: 20,
        threshold: 30,
      }),
    ]);
  });

  await waitForOffer(request, slug, stay, 2);
  // The price without a code while the promotion is paused: what every later check compares to.
  const baseline = await issueGuestQuote(
    request,
    environment,
    slug,
    stay,
    offer,
    "promotion-baseline",
  );
  expect(baseline.discountMinor).toBe(BigInt(0));
  expect(BigInt(baseline.totalMinor)).toBe(baseline.roomMinor);
  expect((await readGuestCheckout()).totalMinor).toBe(baseline.totalMinor);
  await card.getByRole("switch").click();
  await expect(card).toContainText("Active");

  await test.step("an active promotion changes no guest price yet; promo codes still discount", async () => {
    // VAY-2319 (2026-10-23): the new pricing has no evaluator for Booking Admin's automatic
    // promotions, so an active Early bird changes no guest price, and the Promos page says so.
    // VAY-2333 builds the evaluator. When it ships, flip these checks in the same PR: an active
    // promotion then prices the stay below `baseline`, a paused one changes nothing, and
    // promotions and promo codes never stack (the highest single discount wins).
    await expectGuestPrice(baseline.totalMinor, "promotion-active");
    for (const [mode, percent] of [
      ["instant", 10],
      ["request", 30],
    ] as const) {
      const code = `QA${percent}`;
      await api.json("POST", codesPath, {
        code,
        discountType: "percentage",
        discountValue: String(percent),
        maxUses: 10,
        isActive: true,
      });
      await api.json("PUT", acceptancePath, { acceptanceMode: mode });
      // The code takes its share of the room price; the smoke's amounts divide evenly.
      const expectedDiscount = (baseline.roomMinor * BigInt(percent)) / BigInt(100);
      const assertQuote = (quote: GuestQuote) => {
        expect(quote.discountMinor).toBe(expectedDiscount);
        expect(BigInt(quote.totalMinor)).toBe(BigInt(baseline.totalMinor) - expectedDiscount);
      };
      assertQuote(await readGuestCheckout(code));
      const availability = await waitForOffer(request, slug, stay, 2);
      await runQuoteLifecycle(
        request,
        environment,
        slug,
        stay,
        offer,
        availability.availableRooms,
        mode,
        bookings,
        { key: `promotion-${mode}`, promoCode: code, assertQuote },
      );
      await waitForOffer(request, slug, stay, 2);
    }
  });

  await api.json("PUT", acceptancePath, { acceptanceMode: "instant" });

  await test.step("delete the promotion and confirm guests still pay the same", async () => {
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Delete Early bird", exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "New promotion", exact: true })).toBeEnabled();
    await expect(card).toHaveCount(0);
    const saved = await api.json<Record<string, unknown>>("GET", settingsPath);
    expect(saved.promotions).toEqual([]);
    await expectGuestPrice(baseline.totalMinor, "promotion-deleted");
  });
}
