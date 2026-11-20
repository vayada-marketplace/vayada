import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn() };
const ensureSession = vi.fn(async () => true);
const search = new URLSearchParams({
  response_type: "code",
  client_id: "partner_abc",
  redirect_uri: "https://partner.example/callback",
  state: "s",
});

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/partner/oauth/authorize",
  useSearchParams: () => search,
}));
vi.mock("@/services/auth", () => ({ authService: { ensureSession: () => ensureSession() } }));
vi.mock("@/lib/i18n", async () => {
  const en = (await import("../../messages/en.json")).default as Record<string, string>;
  const t = (key: string, values: Record<string, string> = {}) =>
    (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`);
  return { useTranslation: () => ({ t, locale: "en" }) };
});

import { PartnerAuthorizationRequestError } from "@/services/api/partnerConnectionsClient";
import { PartnerAuthorizePage } from "./PartnerAuthorizePage";

const alpina = {
  propertyId: "a0000000-0000-4000-8000-000000000001",
  name: "Hotel Alpina",
  promoCodesEnabled: true,
};
const seeblick = {
  propertyId: "b0000000-0000-4000-8000-000000000002",
  name: "Seeblick",
  promoCodesEnabled: false,
};

function client(overrides: Partial<Record<"loadAuthorization" | "decide", unknown>> = {}) {
  return {
    loadAuthorization: vi.fn(async () => ({
      app: { name: "Partner" },
      scopes: ["promo_codes", "bookings"],
      properties: [alpina, seeblick],
    })),
    decide: vi.fn(async (_q: URLSearchParams, decision: string) =>
      decision === "allow"
        ? "https://partner.example/callback?code=c&state=s"
        : "https://partner.example/callback?error=access_denied&state=s",
    ),
    list: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  };
}

async function render(props: Parameters<typeof PartnerAuthorizePage>[0]) {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<PartnerAuthorizePage {...props} />);
  });
  return view;
}

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());
const button = (view: ReactTestRenderer, label: string) =>
  view.root.findAll((node) => node.type === "button" && node.props.children === label)[0]!;

describe("partner app approval page (VAY-2436)", () => {
  beforeEach(() => {
    router.replace.mockReset();
    ensureSession.mockResolvedValue(true);
  });

  it("sends a signed-out hotel to log in and back to the same request", async () => {
    ensureSession.mockResolvedValue(false);
    const navigate = vi.fn();
    await render({ client: client() as never, navigate });
    expect(router.replace).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent(`/partner/oauth/authorize?${search}`)}`,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("asks once, lets a login with several hotels pick one, offers to switch on Promos, then goes back to the app", async () => {
    const api = client();
    const navigate = vi.fn();
    const enablePromos = vi.fn(async () => undefined);
    const view = await render({ client: api as never, navigate, enablePromos });
    expect(text(view)).toContain(
      "Allow Partner to make discount codes and see the bookings that use them?",
    );
    expect(text(view)).toContain("No guest names or contact details.");
    expect(view.root.findAllByType("input")).toHaveLength(0);

    await act(async () => {
      view.root.findByType("select").props.onChange({ target: { value: seeblick.propertyId } });
    });
    expect(text(view)).toContain(
      "Switch on Promos for this hotel. Partner's codes only work while Promos is on.",
    );
    await act(async () => {
      button(view, "Allow").props.onClick();
    });
    expect(enablePromos).toHaveBeenCalledWith(seeblick.propertyId);
    expect(api.decide).toHaveBeenCalledWith(search, "allow", seeblick.propertyId);
    expect(navigate).toHaveBeenCalledWith("https://partner.example/callback?code=c&state=s");
  });

  it("sends Cancel back to the app without a code", async () => {
    const api = client();
    const navigate = vi.fn();
    const view = await render({ client: api as never, navigate });
    await act(async () => {
      button(view, "Cancel").props.onClick();
    });
    expect(api.decide).toHaveBeenCalledWith(search, "deny", null);
    expect(navigate).toHaveBeenCalledWith(
      "https://partner.example/callback?error=access_denied&state=s",
    );
  });

  it("sends a request with a bad parameter back to the app, and shows an unknown app's request as an error", async () => {
    const navigate = vi.fn();
    await render({
      client: client({
        loadAuthorization: vi.fn(async () => {
          throw new PartnerAuthorizationRequestError(
            "invalid_scope",
            "https://partner.example/callback?error=invalid_scope&state=s",
          );
        }),
      }) as never,
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith(
      "https://partner.example/callback?error=invalid_scope&state=s",
    );

    const shown = await render({
      client: client({
        loadAuthorization: vi.fn(async () => {
          throw new PartnerAuthorizationRequestError("invalid_redirect_uri", null);
        }),
      }) as never,
      navigate: vi.fn(),
    });
    expect(text(shown)).toContain("This connection link isn't valid. Start again from the app.");
  });

  it("says so when this login may connect no hotel, and offers only Cancel", async () => {
    const view = await render({
      client: client({
        loadAuthorization: vi.fn(async () => ({
          app: { name: "Partner" },
          scopes: ["promo_codes"],
          properties: [],
        })),
      }) as never,
      navigate: vi.fn(),
    });
    expect(text(view)).toContain("You can't connect apps to any hotel.");
    expect(button(view, "Allow").props.disabled).toBe(true);
  });
});
