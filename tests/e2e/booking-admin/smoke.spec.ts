import { expect, test } from "@playwright/test";

test.describe("booking-admin smoke", () => {
  test("login page redirects to AuthKit", async ({ page, baseURL }) => {
    const response = await page.request.get("/login");
    const html = await response.text();
    expect(html).toContain("Booking Engine");
    expect(html).not.toContain("Email address");
    expect(html).not.toContain("Continue with WorkOS");
    expect(html).not.toContain("Use legacy password fallback");

    const loginRequests: string[] = [];
    await page.route("**/auth/workos/login**", (route) => {
      loginRequests.push(route.request().url());
      return route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/login");
    await expect.poll(() => loginRequests.length).toBe(1);

    const loginUrl = new URL(loginRequests[0]!);
    expect(loginUrl.searchParams.get("surface")).toBe("booking-admin");
    expect(loginUrl.searchParams.get("return_to")).toBe(
      `${new URL(baseURL!).origin}/login?auth=callback`,
    );
  });
});
