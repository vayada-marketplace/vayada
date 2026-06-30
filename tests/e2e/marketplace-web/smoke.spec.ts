import { expect, test } from "@playwright/test";

test.describe("marketplace-web smoke", () => {
  test("login page redirects to hosted auth", async ({ request }) => {
    const response = await request.get("/login", { maxRedirects: 0 });

    expect(response.status()).toBe(307);

    const hostedLoginUrl = new URL(response.headers().location ?? "");
    expect(hostedLoginUrl.pathname).toBe("/auth/workos/login");
    expect(hostedLoginUrl.searchParams.get("surface")).toBe("marketplace-web");

    const returnTo = new URL(hostedLoginUrl.searchParams.get("return_to") ?? "");
    expect(returnTo.pathname).toBe("/login");
    expect(returnTo.searchParams.get("auth")).toBe("callback");
    expect(returnTo.searchParams.get("returnTo")).toBe("/marketplace");
  });

  test("login callback renders locally", async ({ request }) => {
    const response = await request.get("/login?auth=callback", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(200);
  });
});
