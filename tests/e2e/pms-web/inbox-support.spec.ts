import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebInboxThread,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

async function openHelpFromProfileMenu(page: Page) {
  const avatar = page.getByRole("banner").getByRole("button", { name: "PO", exact: true });
  await avatar.click();
  const currency = page.getByRole("button", { name: /^Currency/ });
  const help = page.getByRole("button", { name: "Help", exact: true });
  const signOut = page.getByRole("button", { name: "Sign Out", exact: true });
  await expect(help).toBeVisible();
  // VAY-2073: Help sits between Currency and Sign Out.
  const [currencyBox, helpBox, signOutBox] = await Promise.all(
    [currency, help, signOut].map((item) => item.boundingBox()),
  );
  expect(currencyBox!.y).toBeLessThan(helpBox!.y);
  expect(helpBox!.y).toBeLessThan(signOutBox!.y);
  await help.click();
  await expect(help).toBeHidden();
  return avatar;
}

for (const viewport of [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
  { width: 390, height: 480 },
  { width: 768, height: 900 },
  { width: 1440, height: 1000 },
]) {
  test(`opens Help from the profile menu over the Inbox composer at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize(viewport);
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    let supportRequests = 0;
    await page.route("**/api/support", async (route) => {
      supportRequests += 1;
      expect(route.request().postDataJSON()).toEqual({
        kind: "bug",
        message: "Synthetic mobile support test",
        page: "/inbox",
        product: "pms",
      });
      await route.fulfill({ json: { status: "accepted", reference: "support-e2e" } });
    });

    await page.goto("/inbox");
    await page.getByRole("button", { name: /Ada Lovelace, Booking.com/ }).click();
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await reply.fill("Draft preserved while asking for help.");
    await expect(send).toBeEnabled();
    // The top bar no longer carries its own Help button.
    await expect(page.getByRole("banner").getByRole("button", { name: /Help/ })).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);

    // Test the bottom edge that the former floating Help button covered.
    const sendBox = await send.boundingBox();
    expect(sendBox).not.toBeNull();
    await send.click({ trial: true, position: { x: sendBox!.width / 2, y: sendBox!.height - 2 } });

    const avatar = await openHelpFromProfileMenu(page);
    const dialog = page.getByRole("dialog", { name: "Help and bug reports" });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("inbox-help-dialog.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(avatar).toBeFocused();
    await expect(reply).toHaveValue("Draft preserved while asking for help.");

    await openHelpFromProfileMenu(page);
    await dialog.getByLabel("What do you need?").selectOption("bug");
    await dialog.getByLabel("Message", { exact: true }).fill("Synthetic mobile support test");
    await dialog.getByRole("button", { name: "Send request" }).click();
    await expect(dialog.getByRole("status")).toContainText("support-e2e");
    expect(supportRequests).toBe(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(reply).toHaveValue("Draft preserved while asking for help.");
    await send.click();
    await expect(page.getByText("Queued", { exact: true })).toBeVisible();
    await assertHealthy();
  });
}

test("keeps mobile Help reachable while direct email sending is held", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(
    (url) =>
      url.pathname ===
      `/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads/${pmsWebInboxThread.id}`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          thread: {
            ...pmsWebInboxThread,
            channel: "email",
            providerChannel: null,
            unreadCount: 0,
            lastMessage: { preview: null, at: null, hasAttachments: false },
            replyRoute: {
              state: "held",
              channel: null,
              providerChannel: null,
              reasonCode: "approved_sender_unavailable",
            },
          },
          availableProviderActions: [],
          timeline: [],
          previousCursor: null,
        },
      }),
  );
  await page.goto(`/inbox?thread=${pmsWebInboxThread.id}`);
  const reply = page.getByRole("textbox", { name: "Reply", exact: true });
  await reply.fill("Do not send this draft.");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await openHelpFromProfileMenu(page);
  await expect(page.getByRole("dialog", { name: "Help and bug reports" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reply).toHaveValue("Do not send this draft.");
  await expect(send).toBeDisabled();
});
