import { expect, test, type Page } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import { mockBookingApis, mockStayPrices, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2449: the hotel's Room Sorting (Booking Admin › Settings) on the booking page's sort menu.
const key = (letter: string) => `pricing-offer.v2:${letter.repeat(64)}`;
const STAY = "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=2";
const free = { kind: "free_until_days_before_arrival", days: 3 };
// Small saves 10% without a refund, Large 20%, Mid has no such rate.
const ROOMS = [
  {
    id: "small",
    guests: 2,
    size: 20,
    offers: [
      ["a", free, "20000"],
      ["b", null, "18000"],
    ],
  },
  {
    id: "large",
    guests: 4,
    size: 45,
    offers: [
      ["c", free, "30000"],
      ["d", null, "24000"],
    ],
  },
  { id: "mid", guests: 3, size: 30, offers: [["e", free, "25000"]] },
] as const;

async function open(
  page: Page,
  roomSorting?: unknown,
  rooms: readonly (typeof ROOMS)[number][] = ROOMS,
) {
  await page.clock.setFixedTime(new Date("2026-10-23T08:00:00Z"));
  // Analytics answered, so the prompt covers nothing on any of a test's visits.
  await page.addInitScript(
    ({ slug, version }) =>
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version, analytics: false }),
      ),
    { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
  );
  await mockBookingApis(page);
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: rooms.map((room) => ({
          roomTypeId: room.id,
          name: `${room.id[0]!.toUpperCase()}${room.id.slice(1)} Room`,
          occupancy: { maxGuests: room.guests, maxAdults: room.guests, maxChildren: 0 },
          size: { value: room.size, unit: "sqm" },
          offers: room.offers.map(([letter, cancellation]) => ({
            publicOfferKey: key(letter),
            currency: "EUR",
            mealPlan: "room_only",
            cancellation: cancellation ?? { kind: "non_refundable" },
            paymentMethods: ["card"],
          })),
        })),
        ...(roomSorting !== undefined && { roomSorting }),
      },
    }),
  );
  await mockStayPrices(
    page,
    Object.fromEntries(
      rooms.map((room) => [
        room.id,
        Object.fromEntries(room.offers.map(([letter, , total]) => [key(letter), total])),
      ]),
    ),
  );
  await page.goto(STAY);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await expect(page.locator('[data-testid^="room-card-"]')).toHaveCount(rooms.length);
}

const order = (page: Page) =>
  page
    .locator('[data-testid^="room-card-"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-testid")!.replace("room-card-", "")),
    );

test("keeps today's menu for a hotel that saved no Room Sorting", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await open(page);
  const sort = page.locator("#room-sort");
  await expect(sort.locator("option")).toHaveText([
    "Recommended",
    "Price: Low to High",
    "Price: High to Low",
    "Room size: Largest first",
  ]);
  await expect(sort).toHaveValue("recommended");
  await expect.poll(() => order(page)).toEqual(["small", "large", "mid"]);
  await sort.selectOption("roomSize");
  await expect.poll(() => order(page)).toEqual(["large", "mid", "small"]);
  await sort.selectOption("priceLow");
  await expect.poll(() => order(page)).toEqual(["small", "large", "mid"]);
  await assertHealthy();
});

test("shows the hotel's options in its order with its default, by best deal and capacity", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await open(page, {
    enabled: true,
    hideWithOneRoom: true,
    options: ["bestDeal", "capacity", "recommended"],
    defaultOption: "bestDeal",
  });
  const sort = page.locator("#room-sort");
  await expect(sort.locator("option")).toHaveText([
    "Best deal first",
    "Capacity: Most guests first",
    "Recommended",
  ]);
  await expect(sort).toHaveValue("bestDeal");
  // The cards' own "-20%" and "-10%": the biggest saving first, then none.
  await expect(page.getByTestId("room-card-large")).toContainText("-20%");
  await expect(page.getByTestId("room-card-small")).toContainText("-10%");
  await expect.poll(() => order(page)).toEqual(["large", "small", "mid"]);
  await sort.selectOption("capacity");
  await expect.poll(() => order(page)).toEqual(["large", "mid", "small"]);
  await sort.selectOption("recommended");
  await expect.poll(() => order(page)).toEqual(["small", "large", "mid"]);
  await page.screenshot({ path: testInfo.outputPath("room-sorting-menu.png"), fullPage: true });
  await assertHealthy();
});

test("hides the menu while sorting is off, with one option, or for a single room", async ({
  page,
}) => {
  const own = {
    enabled: true,
    hideWithOneRoom: true,
    options: ["bestDeal", "priceHigh"],
    defaultOption: "bestDeal",
  };
  // Off: the hotel's own order, whatever its default.
  await open(page, { ...own, enabled: false });
  await expect(page.locator("#room-sort")).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(["small", "large", "mid"]);

  // One option: no menu, sorted by it (the dearest first).
  await open(page, { ...own, options: ["priceHigh"], defaultOption: "priceHigh" });
  await expect(page.locator("#room-sort")).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(["mid", "large", "small"]);

  // One room: no menu by default, and the menu when the hotel keeps it.
  await open(page, undefined, ROOMS.slice(0, 1));
  await expect(page.locator("#room-sort")).toHaveCount(0);
  await open(page, { ...own, hideWithOneRoom: false }, ROOMS.slice(0, 1));
  await expect(page.locator("#room-sort")).toBeVisible();
});
