import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
  authenticated: true,
  accountComplete: true,
  prepared: null as unknown,
  wizard: vi.fn((props: unknown) => {
    void props;
    return null;
  }),
  adaptive: vi.fn(() => null),
  account: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.params,
}));
vi.mock("@vayada/product-onboarding", async (original) => ({
  ...(await original<object>()),
  SharedFirstRunPropertySetupWizard: mocks.wizard,
  SharedAccountDetailsStep: mocks.account,
  isSharedAccountDetailsComplete: () => mocks.accountComplete,
}));
vi.mock("@/services/auth", () => ({
  authService: {
    ensureSession: async () => mocks.authenticated,
    getUserType: () => "hotel",
  },
}));
vi.mock("@/services/auth/sessionStore", () => ({
  getAuthSessionUser: () => ({ name: "Hotel Owner", email: "owner@example.test" }),
  getAuthCsrfToken: () => null,
  getAuthOrganizationId: () => "organization-1",
  getAuthWorkosOrganizationId: () => "workos-organization-1",
}));
vi.mock("@/services/api/sharedHotelSetupClient", () => ({
  sharedHotelSetupApi: {},
  sharedSetupClient: { get: vi.fn(async () => ({ import: mocks.prepared })) },
  sharedAccountProfileImageUploader: vi.fn(),
}));
vi.mock("@/services/api/hotelOperationsSetupClient", () => ({
  hotelOperationsSetupApi: {
    getPropertyLaunchSettings: vi.fn(),
    updatePropertyLaunchSettings: vi.fn(),
  },
}));
vi.mock("./adaptive/rooms/AdaptiveRoomAuthoringSetupController", () => ({
  AdaptiveRoomAuthoringSetupController: mocks.adaptive,
}));
vi.mock("./SetupTaskFormRouter", () => ({ SetupTaskFormRouter: () => null }));

import { SharedHotelSetupPage } from "./SharedHotelSetupPage";

describe("invitation setup entry", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.params = new URLSearchParams("entryProduct=pms&returnProduct=pms");
    mocks.authenticated = true;
    mocks.accountComplete = true;
    mocks.prepared = null;
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  async function render(adaptiveShellEnabled = true) {
    await act(async () => {
      renderer = create(
        createElement(SharedHotelSetupPage, {
          defaultEntryProduct: "marketplace",
          defaultReturnTo: "/marketplace",
          adaptiveShellEnabled,
        }),
      );
    });
  }

  it.each([true, false])(
    "opens property setup without a property ID (adaptive=%s)",
    async (flag) => {
      await render(flag);
      expect(mocks.wizard).toHaveBeenCalled();
      expect(mocks.adaptive).not.toHaveBeenCalled();
      const props = mocks.wizard.mock.calls.at(-1)?.[0] as unknown as {
        entryProduct: string;
        onPropertySelected: (id: string) => void;
      };
      expect(props.entryProduct).toBe("pms");
      await act(async () => props.onPropertySelected("property-1"));
      expect(mocks.replace).toHaveBeenCalledWith(
        "/setup?entryProduct=pms&returnProduct=pms&propertyId=property-1",
        { scroll: false },
      );
    },
  );

  it("retains the adaptive route when a property is already selected", async () => {
    mocks.params.set("propertyId", "property-1");
    await render();
    expect(mocks.wizard).toHaveBeenCalled();
    expect(
      (mocks.wizard.mock.calls.at(-1)?.[0] as { renderAfterHotelDetails?: unknown })
        .renderAfterHotelDetails,
    ).toBeTypeOf("function");
  });

  it.each([false, true])(
    "passes prepared details only to initial creation (add=%s)",
    async (add) => {
      mocks.prepared = {
        sourceId: "invite",
        propertyId: null,
        data: { property: { displayName: "Prepared Hotel" }, rooms: [] },
        results: {},
      };
      if (add) mocks.params.set("mode", "add");
      await render();
      const props = mocks.wizard.mock.calls.at(-1)?.[0] as {
        initialProfileSuggestions?: unknown;
        propertyCreateIdempotencyKey?: string;
      };
      expect(props.initialProfileSuggestions).toEqual(
        add ? undefined : { displayName: "Prepared Hotel" },
      );
      expect(props.propertyCreateIdempotencyKey).toBe(add ? undefined : "prepared-property:invite");
    },
  );

  it("requires account details before property setup", async () => {
    mocks.accountComplete = false;
    await render();
    expect(mocks.account).toHaveBeenCalled();
    expect(mocks.wizard).not.toHaveBeenCalled();
  });

  it("redirects an unauthenticated visitor before showing property setup", async () => {
    mocks.authenticated = false;
    await render();
    expect(mocks.replace).toHaveBeenCalledWith("/login");
    expect(mocks.wizard).not.toHaveBeenCalled();
  });
});
