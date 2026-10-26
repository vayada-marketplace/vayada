import { expect, test, type Page } from "@playwright/test";

// Before a page hydrates, a click submits the plain HTML form, which is what the JavaScript-off checks do.
// A GET would put the email and password in the URL, the browser history and request logs (VAY-2271).

// A production build of Booking Admin prerenders its auth pages without their forms (they read the
// URL in the browser), so there is nothing to submit before hydration (VAY-2329). With
// `formsMayWaitForHydration`, such a page skips the check; a page that does render forms is
// checked in full.
type Options = { formsMayWaitForHydration?: boolean };

async function skipWithoutForms(page: Page, path: string, options: Options) {
  if (!options.formsMayWaitForHydration) return;
  test.skip(
    (await page.locator("form").count()) === 0,
    `${path} renders its forms only after hydration (VAY-2329)`,
  );
}

/** The page server-renders at least one form, and every one of them submits with POST. */
export async function expectServerRenderedFormsPost(
  page: Page,
  path: string,
  options: Options = {},
) {
  await page.goto(path);
  await skipWithoutForms(page, path, options);
  const forms = page.locator("form");
  await expect(forms, `${path} renders no form before hydration`).not.toHaveCount(0);
  const methods = await forms.evaluateAll((all) =>
    all.map((form) => (form as HTMLFormElement).method),
  );
  expect(
    methods.filter((method) => method !== "post"),
    `${path} forms: ${methods}`,
  ).toEqual([]);
}

/** A form the page renders only after hydration (reset password reads its token in the browser) also posts. */
export async function expectHydratedFormPosts(page: Page, path: string) {
  await page.goto(path);
  const form = page.locator("form");
  await expect(form).toHaveCount(1);
  await expect(form).toHaveAttribute("method", "post");
}

/** Signing in before the page is interactive posts the form and keeps the email and password out of the URL. */
export async function expectSignInKeepsCredentialsOutOfTheUrl(
  page: Page,
  path = "/login",
  options: Options = {},
) {
  const password = "kept-out-of-the-url";
  await page.goto(path);
  await skipWithoutForms(page, path, options);
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill(password);
  const [request] = await Promise.all([
    page.waitForRequest(
      (request) => request.isNavigationRequest() && request.frame() === page.mainFrame(),
    ),
    page.getByRole("button", { name: "Sign In", exact: true }).click(),
  ]);
  expect(request.method()).toBe("POST");
  const url = new URL(request.url());
  expect(url.searchParams.has("password")).toBe(false);
  expect(url.searchParams.has("email")).toBe(false);
  expect(request.url()).not.toContain(password);
  expect((await request.response())?.status() ?? 0).toBeLessThan(500);
  expect(page.url()).not.toContain(password);
}
