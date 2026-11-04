import { expect, test, type Page } from "@playwright/test";

import {
  agencyPage,
  agencyUrl,
  mockAgencyPage,
  searchDates,
  staySlug,
} from "../support/agencyPageMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2459: an agency's address (one booking page for all its stays) shows its overview: the
// agency's header, the hotel page's search card, and a card per stay for the search.

// No hotel has the agency's address: the page asks for one first, then for the agency page.
const expectedMissingUrls = [
  /\/api\/booking-web\/hotels\/the-travel-ubud(\/checkout-config)?(\?.*)?$/,
];
const { checkIn, checkOut } = searchDates();
const search = `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`;

/** The range as the page writes it ("12 – 14 Nov"), in the browser's own Intl. */
const range = (page: Page, from: string, to: string) =>
  page.evaluate(
    ([a, b]) =>
      new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).formatRange(new Date(`${a}T00:00:00Z`), new Date(`${b}T00:00:00Z`)),
    [from, to],
  );
const cards = (page: Page) => page.getByTestId("agency-stays").getByRole("link");
const day = (date: string, add: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
};

test("shows the agency's stays for the search, cheapest first, full stays at the end", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  const requests = await mockAgencyPage(page);
  await page.goto(agencyUrl(baseURL, `/${search}`));

  // The agency's header: its title and line, name top left, and the switches it has on.
  await expect(page.getByRole("heading", { level: 1, name: "The Travel Ubud" })).toBeVisible();
  await expect(
    page.getByText("13 villas, guest houses and resorts in and around Ubud"),
  ).toBeVisible();
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link", { name: "The Travel Ubud" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Open photo gallery" }).first()).toBeVisible();
  await expect(nav.getByRole("button", { name: "Contact" })).toBeVisible();
  await expect(nav.getByRole("button", { name: /^EN/ }).first()).toBeVisible();
  await expect(nav.getByRole("button", { name: /^USD/ }).first()).toBeVisible();
  // No booking stepper on the overview.
  await expect(page.getByText("Review & pay")).toHaveCount(0);

  const dates = await range(page, checkIn, checkOut);
  await expect(page.getByTestId("agency-count")).toHaveText(
    `8 of 10 stays are available for ${dates} and fit 2 adults`,
  );
  await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("price_low");
  await expect(cards(page)).toHaveCount(8);
  const first = cards(page).first();
  await expect(first).toHaveAttribute("data-testid", `agency-stay-${staySlug("mertha")}`);
  await expect(first).toContainText("Guest house");
  await expect(first).toContainText("Lowest price");
  await expect(first).toContainText("Mertha Carik Guest House");
  await expect(first).toContainText("Ubud");
  await expect(first).toContainText("2 room types free · fits 2 adults");
  await expect(first).toContainText("from US$38 / night");
  await expect(first).toContainText("from US$76 total");
  await expect(first).toContainText("View rooms");
  // Its page on the agency's address, with the search (VAY-2461).
  await expect(first).toHaveAttribute(
    "href",
    `/stays/${staySlug("mertha")}?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`,
  );
  await expect(cards(page).filter({ hasText: "Lowest price" })).toHaveCount(1);
  await expect(cards(page).nth(1)).toContainText("Adhidrawa Ubud");
  await expect(cards(page).last()).toContainText("Eskabbe Maha Villa");
  await expect(page.getByTestId(`agency-stay-${staySlug("uma")}`)).toHaveCount(0);

  const full = page.getByTestId("agency-full-stays");
  await expect(full.getByRole("heading")).toHaveText(`Not available for ${dates} (2)`);
  await expect(full.getByTestId(`agency-full-${staySlug("uma")}`)).toContainText(
    `Next free: ${await range(page, day(checkIn, 4), day(checkIn, 6))}`,
  );
  await expect(full.getByRole("button", { name: /Use these dates/ })).toHaveCount(2);

  // One search (React's development effects may start and cancel a first copy), for the guests
  // in one room.
  expect(new Set(requests.map(String)).size).toBe(1);
  expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({
    checkIn,
    checkOut,
    adults: "2",
    children: "0",
    rooms: "1",
  });
  await assertHealthy();
});

test("sorts by the highest price or Recommended; the badge stays on the cheapest", async ({
  page,
  baseURL,
}) => {
  await mockAgencyPage(page);
  await page.goto(agencyUrl(baseURL, `/${search}`));
  await expect(cards(page)).toHaveCount(8);

  await page.getByRole("combobox", { name: "Sort by" }).selectOption("price_high");
  await expect(cards(page).first()).toContainText("Eskabbe Maha Villa");
  await expect(cards(page).last()).toContainText("Mertha Carik Guest House");
  await expect(cards(page).last()).toContainText("Lowest price");

  // Recommended: the agency's own order.
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("recommended");
  await expect(cards(page).first()).toContainText("The Escape Villa Ubud");
  await expect(cards(page).nth(1)).toContainText("Mandala's Villa");
});

test("opens with the agency's default sort, and only the header switches it has on", async ({
  page,
  baseURL,
}) => {
  await mockAgencyPage(page, {
    page: agencyPage({
      header: { gallery: false, language: false, currency: false, contact: null },
      results: { defaultSort: "recommended", lowestPriceBadge: false, showFullStays: false },
    }),
  });
  await page.goto(agencyUrl(baseURL, `/${search}`));

  await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("recommended");
  await expect(cards(page).first()).toContainText("The Escape Villa Ubud");
  await expect(cards(page).first()).toContainText("from US$95 / night");
  await expect(cards(page).filter({ hasText: "Lowest price" })).toHaveCount(0);
  await expect(page.getByTestId("agency-full-stays")).toHaveCount(0);
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("button", { name: "Open photo gallery" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Contact" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: /^(EN|USD)/ })).toHaveCount(0);
});

test("Use these dates searches a full stay's next free dates", async ({ page, baseURL }) => {
  const requests = await mockAgencyPage(page);
  await page.goto(agencyUrl(baseURL, `/${search}`));
  await expect(cards(page)).toHaveCount(8);

  await page.getByRole("button", { name: "Use these dates: Uma Nature Villa" }).click();
  const next = { checkIn: day(checkIn, 4), checkOut: day(checkIn, 6) };
  await expect(page.getByTestId("agency-count")).toHaveText(
    `9 of 10 stays are available for ${await range(page, next.checkIn, next.checkOut)} and fit 2 adults`,
  );
  await expect(page.getByTestId(`agency-stay-${staySlug("uma")}`)).toContainText(
    "from US$90 / night",
  );
  expect(requests.at(-1)?.searchParams.get("checkIn")).toBe(next.checkIn);
  // The search card and the address follow.
  await expect(page.locator("#stay-search")).toContainText("2 nights");
  expect(new URL(page.url()).searchParams.get("checkIn")).toBe(next.checkIn);
});

test("searches again for more guests in more rooms, and with a promo code", async ({
  page,
  baseURL,
}) => {
  const requests = await mockAgencyPage(page);
  await page.goto(agencyUrl(baseURL, `/${search}`));
  await expect(cards(page)).toHaveCount(8);

  await page
    .locator("#stay-search")
    .getByRole("button", { name: /Guests/ })
    .click();
  const guests = page.getByTestId("guest-selector");
  await guests.getByRole("button", { name: "More Adults" }).click();
  await guests.getByRole("button", { name: "More Adults" }).click();
  await guests.getByRole("button", { name: "More Rooms" }).click();
  await guests.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Check Availability" }).click();

  await expect(page.getByTestId("agency-count")).toContainText("and fit 4 adults in 2 rooms");
  const escape = page.getByTestId(`agency-stay-${staySlug("escape")}`);
  await expect(escape).toContainText("fits 4 adults in 2 rooms");
  await expect(escape).toContainText("from US$190 / night");
  await expect(escape).toHaveAttribute("href", /&adults=4&children=0&rooms=2$/);
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({
    adults: "4",
    rooms: "2",
  });

  // A code only The Escape takes: it applies, and only The Escape's link carries it; the others
  // keep it as the agency's, for their way back.
  await page.getByRole("button", { name: "Add promo" }).click();
  await page.getByPlaceholder("Enter code").fill("AUTUMN");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#stay-search")).toContainText("AUTUMN");
  await expect(escape).toContainText("from US$171 / night");
  await expect(escape).toHaveAttribute("href", /&rooms=2&promoCode=AUTUMN$/);
  const mertha = page.getByTestId(`agency-stay-${staySlug("mertha")}`);
  await expect(mertha).not.toHaveAttribute("href", /promoCode/);
  await expect(mertha).toHaveAttribute("href", /&agencyPromo=AUTUMN$/);

  // A code no stay takes says so.
  await page.getByRole("button", { name: "Remove promo code" }).click();
  await page.getByRole("button", { name: "Add promo" }).click();
  await page.getByPlaceholder("Enter code").fill("NOPE");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByText("This code doesn't apply to any stay for these dates."),
  ).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("promoCode")).toBe("NOPE");
  // It leaves the address, and no card carries it.
  await expect.poll(() => new URL(page.url()).searchParams.has("promoCode")).toBe(false);
  await expect(page.locator('[data-testid^="agency-stay-"][href*="promoCode"]')).toHaveCount(0);
});

test("a stay that takes no children is read for the adults alone, and opened with the search", async ({
  page,
  baseURL,
}) => {
  await mockAgencyPage(page, { page: agencyPage({ adultsOnly: ["mertha"] }) });
  await page.goto(agencyUrl(baseURL, `/${search.replace("children=0", "children=1")}`));

  await expect(page.getByTestId("agency-count")).toContainText("and fit 2 adults and 1 child");
  await expect(
    page.getByText("Prices are for the adults; each stay prices children on its own page."),
  ).toBeVisible();
  const mertha = page.getByTestId(`agency-stay-${staySlug("mertha")}`);
  await expect(mertha).toContainText("2 room types free · fits 2 adults · Adults only");
  // Its page reads the children as none, and keeps them for the way back.
  await expect(mertha).toHaveAttribute("href", /&adults=2&children=1$/);
  const escape = page.getByTestId(`agency-stay-${staySlug("escape")}`);
  await expect(escape).toContainText("fits 2 adults and 1 child");
  await expect(escape).toHaveAttribute("href", /&adults=2&children=1$/);
});

test("says when searches are busy, and Try again searches again", async ({ page, baseURL }) => {
  let busy = true;
  await mockAgencyPage(page, {
    stayPrices: () =>
      busy
        ? { status: 503, json: { statusCode: 503, message: "Too many searches right now." } }
        : null,
  });
  await page.goto(agencyUrl(baseURL, `/${search}`));

  const alert = page.locator("#stays").getByRole("alert");
  await expect(alert).toContainText("Too many searches right now. Please try again in a moment.");
  // The stays are listed meanwhile, without prices.
  await expect(cards(page)).toHaveCount(10);
  busy = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(alert).toHaveCount(0);
  await expect(cards(page).first()).toContainText("from US$38 / night");
});

test("an agency page that is off isn't reachable", async ({ page, baseURL }) => {
  await mockAgencyPage(page);
  await page.route(/\/api\/booking-web\/agency-pages\/the-travel-ubud(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 404,
      json: { statusCode: 404, error: "Not Found", message: "Agency page not found." },
    }),
  );
  await page.goto(agencyUrl(baseURL, "/"));
  await expect(
    page.getByRole("heading", { name: "This booking page isn't online right now" }),
  ).toBeVisible();
  await expect(page.getByTestId("agency-stays")).toHaveCount(0);
});
