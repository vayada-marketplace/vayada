import type { Page } from "@playwright/test";

/** How far the room page's tab bar sits below its title. Every message goes under the tab bar, so this stays the
 * same on every tab, with or without a banner (VAY-2337). */
export async function roomTabBarOffset(page: Page): Promise<number> {
  const [tab, title] = await Promise.all([
    page.locator("main").getByRole("button", { name: "Room Details", exact: true }).boundingBox(),
    page.locator("main h1").first().boundingBox(),
  ]);
  if (!tab || !title) throw new Error("The room page's title or tab bar is not on screen");
  return tab.y - title.y;
}
