import { expect, test, type Page } from "@playwright/test";
import { alpenrose, harbour, overviewFixture } from "./aiBudgetsFixtures";
import { api, fulfillJson, signIn } from "./payoutsFixtures";

// VAY-2504: vayada staff see each hotel account's AI spend this month and set its monthly AI
// budget, with a reason, or put it back on the default ($0 = no AI).

// The table shows from 1280px; below that each hotel is a card (last test).
test.use({ viewport: { width: 1440, height: 900 } });

async function openPage(
  page: Page,
  baseURL: string | undefined,
  overview: () => unknown = () => overviewFixture,
) {
  const { adminBaseURL, origin } = await signIn(page, baseURL);
  const reads: number[] = [];
  await page.route(api("/api/platform/admin/ai-budgets"), (route) => {
    reads.push(Date.now());
    return fulfillJson(route, origin, overview());
  });
  await page.goto(new URL("/dashboard/ai-budgets", adminBaseURL).toString());
  return { origin, reads };
}

const row = (page: Page, name: RegExp) => page.locator("table").getByRole("row", { name });

test("staff see each hotel's AI spend this month and its budget (VAY-2504)", async ({
  page,
  baseURL,
}) => {
  await openPage(page, baseURL);

  await expect(page.getByRole("link", { name: "AI budgets", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI budgets" })).toBeVisible();
  await expect(page.getByText("November 2026 · what each hotel account spent")).toBeVisible();
  // The phone summary repeats the figures (hidden here); the wide one comes first.
  await expect(page.getByText("$18.57", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("$0.00 a month", { exact: true })).toBeVisible();
  await expect(page.getByText("4 hotels", { exact: true })).toBeVisible();
  await expect(page.getByText("1 has used up this month's budget")).toBeVisible();

  await expect(row(page, /Villa Serena Canggu/)).toContainText("$10.00 of $10.00");
  await expect(row(page, /Villa Serena Canggu/)).toContainText(
    "Used up · AI paused until December 1",
  );
  await expect(row(page, /Harbour House Lisbon/)).toContainText("$6.41 of $25.00");
  await expect(row(page, /Harbour House Lisbon/)).toContainText("Own");
  await expect(row(page, /Harbour House Lisbon/)).toContainText("3,077");
  await expect(row(page, /Harbour House Lisbon/)).toContainText("Nov 12");
  await expect(row(page, /Harbour House Lisbon/)).not.toContainText("Used up");
  await expect(row(page, /Hotel Alpenrose Munich/)).toContainText("No AI use");
  await expect(row(page, /Hotel Alpenrose Munich/)).toContainText("Default");
  await expect(row(page, /Hotel Alpenrose Munich/)).toContainText("—");
  await expect(
    row(page, /Hotel Alpenrose Munich/).getByRole("button", {
      name: "Set budget for Hotel Alpenrose Munich",
    }),
  ).toBeVisible();
  await expect(row(page, /Seaview Guesthouse Galle/)).toContainText("Suspended");
  // The API's order: the most use first.
  await expect(page.locator("table tbody tr").first()).toContainText("Villa Serena Canggu");

  await page.getByRole("searchbox", { name: "Search hotels" }).fill("lisbon");
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await expect(page.locator("table tbody tr")).toContainText("Harbour House Lisbon");
  await page.getByRole("searchbox", { name: "Search hotels" }).fill("nowhere");
  await expect(page.getByText("No hotel matches “nowhere”.")).toBeVisible();
});

test("staff raise a hotel's AI budget with a reason (VAY-2504)", async ({ page, baseURL }) => {
  const { origin, reads } = await openPage(page, baseURL);
  let saved: unknown = null;
  await page.route(api(`/api/platform/admin/ai-budgets/${harbour}`), (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saved = route.request().postDataJSON();
    return fulfillJson(route, origin, {
      ...overviewFixture.accounts[1],
      monthlyLimitMicroUsd: 40_000_000,
      updatedAt: "2026-11-23T10:00:00.000Z",
    });
  });

  await row(page, /Harbour House Lisbon/)
    .getByRole("button", { name: "Change budget for Harbour House Lisbon" })
    .click();
  const dialog = page.getByRole("dialog", { name: "AI budget for Harbour House Lisbon" });
  await expect(dialog).toContainText("Used $6.41 of $25.00 this month, in 3,077 AI calls.");
  await expect(dialog).toContainText("$0.00 a month today, so no AI for this hotel");
  const amount = dialog.getByRole("textbox", { name: "Monthly budget in dollars" });
  await expect(amount).toHaveValue("25.00");
  const save = dialog.getByRole("button", { name: "Save budget" });
  await expect(save).toBeDisabled(); // no reason yet

  await amount.fill("12.505");
  await dialog.getByRole("textbox", { name: "Reason" }).fill("  Busy season  ");
  await expect(dialog).toContainText("Enter dollars and cents up to $100,000, e.g. 25 or 12.50.");
  await expect(save).toBeDisabled();

  await amount.fill("40");
  await expect(save).toBeEnabled();
  const readsBefore = reads.length;
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toHaveText(
    "Harbour House Lisbon: AI budget is now $40.00 a month.",
  );
  expect(saved).toEqual({ monthlyLimitUsd: "40", reason: "Busy season" });
  // The list is read again after a change.
  await expect.poll(() => reads.length).toBeGreaterThan(readsBefore);
  // Opening another hotel's dialog clears the notice.
  await row(page, /Alpine Lodge/)
    .getByRole("button", { name: "Change budget for Alpine Lodge" })
    .click();
  await expect(page.getByRole("status")).toHaveText("");
});

test("staff put a hotel back on the default budget; Escape closes without saving (VAY-2504)", async ({
  page,
  baseURL,
}) => {
  const onDefault = {
    ...overviewFixture.accounts[1],
    monthlyLimitMicroUsd: 0,
    custom: false,
    updatedAt: null,
  };
  let reset = false;
  const { origin } = await openPage(page, baseURL, () =>
    reset
      ? {
          ...overviewFixture,
          accounts: overviewFixture.accounts.map((account) =>
            account.organizationId === harbour ? onDefault : account,
          ),
        }
      : overviewFixture,
  );
  const puts: unknown[] = [];
  await page.route(api(`/api/platform/admin/ai-budgets/${harbour}`), (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    puts.push(route.request().postDataJSON());
    reset = true;
    return fulfillJson(route, origin, onDefault);
  });

  const change = row(page, /Harbour House Lisbon/).getByRole("button", {
    name: "Change budget for Harbour House Lisbon",
  });
  await change.click();
  const dialog = page.getByRole("dialog", { name: "AI budget for Harbour House Lisbon" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(change).toBeFocused();

  await change.click();
  await dialog.getByRole("radio", { name: /Use the default/ }).check();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Pilot over");
  await dialog.getByRole("button", { name: "Save budget" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Harbour House Lisbon is back on the default AI budget ($0.00 a month).",
  );
  expect(puts).toEqual([{ monthlyLimitUsd: null, reason: "Pilot over" }]);
  // Back on the default: AI stops ($0 default) and there is no own budget to date.
  await expect(row(page, /Harbour House Lisbon/)).toContainText("$6.41 of $0.00");
  await expect(row(page, /Harbour House Lisbon/)).toContainText("AI off: the budget is $0");
  await expect(row(page, /Harbour House Lisbon/)).toContainText("Default");
  await expect(row(page, /Harbour House Lisbon/)).toContainText("—");
  await expect(
    row(page, /Harbour House Lisbon/).getByRole("button", {
      name: "Set budget for Harbour House Lisbon",
    }),
  ).toBeVisible();
});

test("a refused change says why and keeps the dialog open (VAY-2504)", async ({
  page,
  baseURL,
}) => {
  const { origin } = await openPage(page, baseURL);
  await page.route(api(`/api/platform/admin/ai-budgets/${alpenrose}`), (route) =>
    route.request().method() === "PUT"
      ? fulfillJson(route, origin, { statusCode: 403, message: "Forbidden" }, 403)
      : route.fallback(),
  );
  await row(page, /Hotel Alpenrose Munich/)
    .getByRole("button", { name: "Set budget for Hotel Alpenrose Munich" })
    .click();
  const dialog = page.getByRole("dialog", { name: "AI budget for Hotel Alpenrose Munich" });
  await expect(dialog).toContainText("No AI use this month.");
  await expect(dialog.getByRole("textbox", { name: "Monthly budget in dollars" })).toHaveValue("");
  await dialog.getByRole("textbox", { name: "Monthly budget in dollars" }).fill("5");
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Trial");
  await dialog.getByRole("button", { name: "Save budget" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Changing AI budgets needs vayada admin access.",
  );
  await expect(dialog).toBeVisible();
});

test("the page says when the staff member may not see AI budgets (VAY-2504)", async ({
  page,
  baseURL,
}) => {
  const { adminBaseURL, origin } = await signIn(page, baseURL);
  await page.route(api("/api/platform/admin/ai-budgets"), (route) =>
    fulfillJson(route, origin, { statusCode: 403, message: "Forbidden" }, 403),
  );
  await page.goto(new URL("/dashboard/ai-budgets", adminBaseURL).toString());
  await expect(page.getByText("AI budgets need vayada staff access.")).toBeVisible();
});

test("on a phone each hotel is a card (VAY-2504)", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, baseURL);
  // As on the approved board: the menu folded to icons (it doesn't fold by itself on phones).
  await page.getByRole("button", { name: "Collapse" }).click();
  const card = (name: string) => page.getByRole("listitem").filter({ hasText: name });
  await expect(card("Villa Serena Canggu")).toContainText("$10.00 of $10.00 · Own budget");
  await expect(card("Villa Serena Canggu")).toContainText("Used up · AI paused until December 1");
  await expect(card("Villa Serena Canggu")).toContainText("4,812 calls");
  await expect(card("Harbour House Lisbon")).toContainText("Changed Nov 12");
  await expect(card("Hotel Alpenrose Munich")).toContainText("No AI use · Default $0.00");
  await expect(
    card("Hotel Alpenrose Munich").getByRole("button", { name: /Set budget for/ }),
  ).toBeVisible();
  await expect(page.locator("table")).toBeHidden();
});
