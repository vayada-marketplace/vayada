import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { watchPageHealth } from "../support/pageHealth";
import { expectNotFrameable } from "../support/contentSecurityPolicy";
import { roomBlockAction, routeAssistant } from "../support/assistantMocks";

// VAY-2528: the one-tap vayada page. A change an AI app asked for over MCP (VAY-2524) is answered
// here, signed in to the PMS, with the in-app assistant's Yes/No card (VAY-2519). Nothing links
// here yet: AI changes on MCP don't exist.
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const ids = (n: number) => `${String(n).padStart(8, "0")}-6b7c-4d8e-9f01-2a3b4c5d6e7f`;
const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();
const now = () => new Date().toISOString();
const mcpAction = (id: string, changes: Parameters<typeof roomBlockAction>[2] = {}) =>
  roomBlockAction(id, inFifteenMinutes(), { surface: "mcp", client: "claude.ai", ...changes });

async function signedIn(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
}

// Two hotels, as in the booking link's spec (VAY-2099): the changes are Alpenrose's
// (PMS_WEB_PROPERTY_ID), and Dewari is chosen.
const DEWARI = "f6853000-0000-4000-8000-000000002451";
const hotel = (propertyId: string) =>
  propertyId === DEWARI
    ? {
        propertyId,
        publicId: "prop_dewari",
        displayName: "Dewari Villa",
        locationSummary: "Ubud, ID",
      }
    : {
        propertyId,
        publicId: "prop_alpenrose",
        displayName: "Alpenrose Munich",
        locationSummary: "Munich, DE",
      };

async function signedInWithDewari(page: Page) {
  await mockPmsWebAuthenticatedSession(page, DEWARI);
  await page.addInitScript((dewari) => {
    window.localStorage.setItem("selectedSharedPropertyId", dewari);
    window.localStorage.setItem("selectedSharedPropertyOrganizationId", "org_pms_owner");
  }, DEWARI);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/hotel-setup/status**", (route) => {
    const asked = new URL(route.request().url()).searchParams.get("propertyId");
    const known = asked === PMS_WEB_PROPERTY_ID || asked === DEWARI ? asked : null;
    const status = createAdaptiveHotelSetupStatusMock({
      entryProduct: "pms",
      organizationId: "org_pms_owner",
      organizationDisplayName: "Alpenrose Hotel Group",
      selectedTracks: ["hotel_operations"],
      propertyId: known,
      publicId: hotel(known ?? PMS_WEB_PROPERTY_ID).publicId,
      propertyDisplayName: hotel(known ?? PMS_WEB_PROPERTY_ID).displayName,
      locationSummary: hotel(known ?? PMS_WEB_PROPERTY_ID).locationSummary,
    });
    return route.fulfill({
      json: {
        ...status,
        propertySelection: {
          state: "multiple_properties",
          selectedPropertyId: status.propertySelection.selectedPropertyId,
          availableProperties: [hotel(PMS_WEB_PROPERTY_ID), hotel(DEWARI)],
        },
      },
    });
  });
}

/** AI changes off, as in production today: the Yes/No routes are not mounted. */
const changesOff = (
  page: Page,
  answer = { status: 404, json: { statusCode: 404, code: "not_found" } },
) => {
  const reads: string[] = [];
  return page
    .route(/\/api\/ai\/pending-actions\//, (route) => {
      reads.push(route.request().url());
      return route.fulfill(answer);
    })
    .then(() => reads);
};

const cardOf = (page: Page) => page.getByRole("region", { name: "Needs your answer" });
const shot = (page: Page, testInfo: TestInfo, name: string) =>
  page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

test.use({ viewport: DESKTOP });

test("an AI app's change is answered here with one tap: the card, then Done", async ({
  page,
}, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  const id = ids(1);
  await signedIn(page);
  const seen = await routeAssistant(page, {
    pendingActions: { [id]: mcpAction(id) },
    onAnswer: () => ({
      view: mcpAction(id, {
        state: "done",
        answerBy: null,
        answeredAt: now(),
        finishedAt: now(),
        cardSha256: null,
      }),
    }),
  });
  await page.goto(`/ai/changes/${id}`);
  await expect(page.getByRole("heading", { name: "Your AI app asked for a change" })).toBeVisible();
  await expect(
    page.getByText("Nothing changes until you say yes, and your AI app can't answer for you."),
  ).toBeVisible();
  const card = cardOf(page);
  await expect(card.getByRole("heading", { name: "Block room 12 for 3 nights?" })).toBeVisible();
  await expect(card).toContainText("12 · Deluxe Double");
  await expect(card).toContainText("Guests can't book room 12 on these nights.");
  await expect(card).toContainText(/Answer by \d\d:\d\d/);
  // The page's own words: the AI app can't answer, and nothing speaks of a chat.
  await expect(card).toContainText("nothing your AI app says or does can.");
  await expect(card).not.toContainText(/chat/i);
  await shot(page, testInfo, "one-tap-desktop");

  await card.getByRole("button", { name: "Yes, block room 12" }).click();
  await expect(page.getByText("Blocked room 12 for 3 nights")).toBeVisible();
  await expect(
    page.getByText(/You said yes at \d\d:\d\d\. You can go back to your AI app\./),
  ).toBeVisible();
  expect(seen.answers).toEqual([{ id, body: { answer: "yes", cardSha256: "a".repeat(64) } }]);
  await healthy();
});

test("No closes it, and nothing is made", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  const id = ids(2);
  await signedIn(page);
  const seen = await routeAssistant(page, {
    pendingActions: { [id]: mcpAction(id) },
    onAnswer: () => ({
      view: mcpAction(id, {
        state: "declined",
        answerBy: null,
        answeredAt: now(),
        finishedAt: now(),
        cardSha256: null,
      }),
    }),
  });
  await page.goto(`/ai/changes/${id}`);
  await cardOf(page).getByRole("button", { name: "No", exact: true }).click();
  await expect(page.getByText("Not done")).toBeVisible();
  await expect(page.getByText(/You said no at \d\d:\d\d\. Nothing changed\./)).toBeVisible();
  expect(seen.answers).toEqual([{ id, body: { answer: "no" } }]);
  await healthy();
});

// No page-health watch here: the browser logs the refused answer's 409 as a console error.
test("a change that moved on sends the person back to their AI app, with no Ask again here", async ({
  page,
}) => {
  const id = ids(3);
  await signedIn(page);
  await routeAssistant(page, {
    pendingActions: { [id]: mcpAction(id) },
    onAnswer: () => ({
      view: mcpAction(id, {
        state: "changed",
        answerBy: null,
        finishedAt: now(),
        cardSha256: null,
      }),
      refusal: { statusCode: 409, code: "changed" },
    }),
  });
  await page.goto(`/ai/changes/${id}`);
  await cardOf(page).getByRole("button", { name: "Yes, block room 12" }).click();
  await expect(page.getByText("This changed since")).toBeVisible();
  await expect(
    page.getByText("Nothing changed. Ask your AI app again to see what's possible now."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask again" })).toHaveCount(0);
});

test("with AI changes off there is no such change: the page says it can't be shown", async ({
  page,
}, testInfo) => {
  const id = ids(4);
  await signedIn(page);
  await changesOff(page);
  await page.goto(`/ai/changes/${id}`);
  await expect(page.getByText("This change can't be shown right now.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Yes/ })).toHaveCount(0);
  await shot(page, testInfo, "one-tap-off");
});

test("on a phone the card fits the screen", async ({ page }, testInfo) => {
  await page.setViewportSize(PHONE);
  const id = ids(5);
  await signedIn(page);
  await routeAssistant(page, { pendingActions: { [id]: mcpAction(id) } });
  await page.goto(`/ai/changes/${id}`);
  const card = cardOf(page);
  const yes = card.getByRole("button", { name: "Yes, block room 12" });
  await yes.scrollIntoViewIfNeeded();
  await expect(yes).toBeInViewport({ ratio: 1 });
  // The shell hides sideways overflow, so measure the card itself against the screen.
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  await shot(page, testInfo, "one-tap-phone");
});

test("a change for another hotel than the one open is not shown under its name", async ({
  page,
}) => {
  const id = ids(7);
  await signedInWithDewari(page);
  await routeAssistant(page, { pendingActions: { [id]: mcpAction(id) } });
  await page.goto(`/ai/changes/${id}`);
  await expect(page.getByText("This change is for another of your hotels.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes, block room 12" })).toBeHidden();
});

test("the AI app's link names its hotel, so the change opens under it", async ({ page }) => {
  const id = ids(8);
  await signedInWithDewari(page);
  await routeAssistant(page, { pendingActions: { [id]: mcpAction(id) } });
  await page.goto(`/ai/changes/${id}?property=${PMS_WEB_PROPERTY_ID}`);
  await expect(cardOf(page).getByRole("button", { name: "Yes, block room 12" })).toBeVisible();
  await expect(page.getByText("This change is for another of your hotels.")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/ai/changes/${id}$`));
});

// No page-health watch: the browser logs the refused read's 403 as a console error.
test("a change of another account says so, and is not read again", async ({ page }) => {
  const id = ids(9);
  await signedIn(page);
  const reads = await changesOff(page, {
    status: 403,
    json: { statusCode: 403, code: "other_account", message: "Switch to it to answer." },
  });
  await page.goto(`/ai/changes/${id}`);
  await expect(
    page.getByText("This change belongs to another of your vayada accounts."),
  ).toBeVisible();
  // A failed read is tried again after 10 s; a refusal never is. (The dev server's strict mode may
  // read twice on the first render, so count from here.)
  const first = reads.length;
  await page.waitForTimeout(11_000);
  expect(reads).toHaveLength(first);
});

test("another site can't show the one-tap page in a frame", async ({ page, baseURL }) => {
  await expectNotFrameable(page, `${baseURL}/ai/changes/${ids(6)}`);
});
