import type { Page } from "@playwright/test";

/**
 * VAY-2462: a stand-in for Stripe.js, so a spec can go through the card step without Stripe: its
 * Payment Element mounts nothing, and `confirmPayment` succeeds at once, keeping what it was asked
 * (the connected account it was made for and the return link) for the spec to read.
 */
const STRIPE_FAKE = `
(() => {
  const noop = () => {};
  window.Stripe = function (key, options) {
    const element = {
      mount: noop, unmount: noop, destroy: noop, update: noop, focus: noop, blur: noop, clear: noop,
      collapse: noop,
      on(event, handler) {
        if (event === "ready") setTimeout(() => handler({ elementType: "payment" }));
        return element;
      },
      off() { return element; },
      once() { return element; },
    };
    const elements = {
      create: () => element,
      getElement: () => element,
      update: noop,
      fetchUpdates: async () => ({}),
      submit: async () => ({}),
    };
    return {
      elements: () => elements,
      createToken: async () => ({}),
      createPaymentMethod: async () => ({}),
      confirmCardPayment: async () => ({}),
      async confirmPayment(args) {
        window.__stripeConfirm = {
          account: options && options.stripeAccount,
          returnUrl: args.confirmParams && args.confirmParams.return_url,
          redirect: args.redirect,
        };
        return {};
      },
    };
  };
})();
`;

export async function mockStripe(page: Page) {
  await page.route("https://js.stripe.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: STRIPE_FAKE }),
  );
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { __stripeConfirm?: Record<string, string> }).__stripeConfirm ?? null,
    );
}
