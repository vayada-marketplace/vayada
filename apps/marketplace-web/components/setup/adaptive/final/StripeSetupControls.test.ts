import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  providerAccountId: vi.fn(),
  start: vi.fn(),
  reconcile: vi.fn(),
  watch: vi.fn(),
  mark: vi.fn(),
}));
vi.mock("@/services/api/financePaymentReadinessClient", () => ({
  financePaymentReadinessClient: { load: mocks.load, providerAccountId: mocks.providerAccountId },
}));
vi.mock("@/services/api/hotelOperationsSetupClient", () => ({
  hotelOperationsSetupApi: {
    startStripeOnboarding: mocks.start,
    reconcileStripeProviderAccount: mocks.reconcile,
  },
}));
vi.mock("@/services/auth/sessionStore", () => ({
  getAuthSessionUser: () => ({ email: "owner@example.test" }),
}));
vi.mock("@/lib/utils/stripeOnboardingRefresh", () => ({
  coordinateStripeRefresh: (_: unknown, run: () => unknown) => run(),
  refreshStripeAfterOnboarding: async (
    _: unknown,
    input: {
      reconcile: (attempt: number) => Promise<unknown>;
      loadPaymentSettings: () => Promise<unknown>;
    },
  ) => {
    await input.reconcile(0);
    return input.loadPaymentSettings();
  },
  watchStripeOnboardingRefresh: mocks.watch,
  markStripeOnboardingStarted: mocks.mark,
}));
import { StripeSetupControls } from "./StripeSetupControls";
const propertyId = "22222222-2222-4222-8222-222222222222";
let browser: {
  location: { href: string; replace: ReturnType<typeof vi.fn> };
  history: { state: unknown; replaceState: ReturnType<typeof vi.fn> };
  localStorage: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
  };
};
beforeEach(() => {
  vi.clearAllMocks();
  browser = {
    location: {
      href: `https://marketplace.localhost/setup?propertyId=${propertyId}&step=payments&stripe=return&returnTo=%2Fsettings%3Fx%3D1`,
      replace: vi.fn(),
    },
    history: { state: { guard: true }, replaceState: vi.fn() },
    localStorage: { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn(), removeItem: vi.fn() },
  };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("navigator", {});
  mocks.watch.mockReturnValue(() => {});
  mocks.providerAccountId.mockResolvedValue(propertyId);
  mocks.start.mockResolvedValue({ onboardingUrl: "https://connect.stripe.com/setup/example" });
  mocks.reconcile.mockResolvedValue({ providerAccount: { ready: true } });
  mocks.load.mockResolvedValue({ propertyId, bookingPaymentReady: false });
});
afterEach(() => vi.unstubAllGlobals());
async function render(enabled = true) {
  const onReadiness = vi.fn();
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(
      createElement(StripeSetupControls, {
        propertyId,
        organizationId: "org",
        enabled,
        visible: true,
        onReadiness,
      }),
    );
  });
  return { view, onReadiness };
}
it("keeps history/return context and uses owner readiness after provider return", async () => {
  const h = await render();
  expect(browser.history.replaceState).toHaveBeenCalledWith(
    { guard: true },
    "",
    `/setup?propertyId=${propertyId}&step=payments&returnTo=%2Fsettings%3Fx%3D1`,
  );
  const watcher = mocks.watch.mock.calls[0][0];
  expect(watcher.isStripeReturn).toBe(true);
  await act(async () => {
    await watcher.onRefresh("flow", "reconcile");
  });
  expect(mocks.reconcile).toHaveBeenCalledWith(
    propertyId,
    "flow:attempt:1",
    expect.any(AbortSignal),
  );
  expect(h.onReadiness).toHaveBeenCalledWith({ propertyId, bookingPaymentReady: false });
  h.view.unmount();
});
it("does not create a provider account on entry and disables setup for unsaved methods", async () => {
  const h = await render(false);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(h.view.root.findByType("fieldset").props.disabled).toBe(true);
  h.view.unmount();
});
it("reuses an existing account and offers only a validated hosted link", async () => {
  const h = await render();
  await act(async () => {
    await h.view.root.findAllByType("button")[0].props.onClick();
  });
  expect(mocks.start).toHaveBeenCalledWith(
    propertyId,
    expect.objectContaining({ providerAccountId: propertyId, country: "" }),
  );
  expect(h.view.root.findByType("a").props.href).toBe("https://connect.stripe.com/setup/example");
  h.view.root.findByType("a").props.onClick();
  expect(mocks.mark).toHaveBeenCalledWith(propertyId, browser.localStorage);
  expect(browser.localStorage.setItem).toHaveBeenCalled();
  h.view.unmount();
});
it("requires explicit country for a new account and rejects external provider links", async () => {
  mocks.providerAccountId.mockResolvedValue(null);
  const h = await render();
  await act(async () => {
    await h.view.root.findAllByType("button")[0].props.onClick();
  });
  expect(mocks.start).not.toHaveBeenCalled();
  await act(async () =>
    h.view.root.findAllByType("input")[1].props.onChange({ target: { value: "de" } }),
  );
  mocks.start.mockResolvedValue({ onboardingUrl: "https://example.test/redirect" });
  await act(async () => {
    await h.view.root.findAllByType("button")[0].props.onClick();
  });
  expect(h.view.root.findAllByType("a")).toHaveLength(0);
  expect(JSON.stringify(h.view.toJSON())).toContain("invalid onboarding link");
  h.view.unmount();
});
it("preserves denied readiness as an error without reporting success", async () => {
  mocks.load.mockRejectedValue(new Error("Forbidden"));
  const h = await render();
  await act(async () => {
    await mocks.watch.mock.calls[0][0].onRefresh("flow", "reload");
  });
  expect(h.onReadiness).not.toHaveBeenCalled();
  expect(JSON.stringify(h.view.toJSON())).toContain("Forbidden");
  h.view.unmount();
});
