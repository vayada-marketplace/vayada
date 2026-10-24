import type { HotelAccountAgreementsStatus } from "@vayada/domain-hotels";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { fillTemplate } from "./fillTemplate";
import HotelAccountAgreementsBanner, {
  formatAgreementVersion,
  HOTEL_ACCOUNT_AGREEMENTS_MESSAGES,
} from "./HotelAccountAgreementsBanner";
import {
  createHotelAccountAgreementsClient,
  parseHotelAccountAgreementsStatus,
} from "./hotelAccountAgreementsApi";
import SharedSignupPage from "./SharedSignupPage";

const current = { termsVersion: "2026-10-24", dpaVersion: "2026-10-24" };
const accepted = {
  ...current,
  acceptedAt: "2026-10-24T09:00:00.000Z",
  acceptedBy: { name: "Anna Keller", email: "anna@example.test" },
  source: "signup" as const,
};
const status = (overrides: Partial<HotelAccountAgreementsStatus> = {}) => ({
  current,
  accepted: null,
  canAccept: true,
  accountName: "Alpenrose Hotels",
  ...overrides,
});

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const flush = () => act(async () => {});

describe("hotel account agreements (VAY-2246)", () => {
  it("fills a translated sentence with its parts in the language's own order", () => {
    expect(
      renderToStaticMarkup(
        <p>{fillTemplate("{a} vor {b}, {unknown}", { a: <b>Eins</b>, b: "zwei" })}</p>,
      ),
    ).toBe("<p><b>Eins</b> vor zwei, {unknown}</p>");
    expect(formatAgreementVersion("2026-10-24")).toBe("24 October 2026");
    expect(formatAgreementVersion("2026-10-24", "de")).toBe("24. Oktober 2026");
    expect(formatAgreementVersion("latest")).toBe("latest");
  });

  it("reads and accepts through the API and refuses answers that aren't one", async () => {
    expect(parseHotelAccountAgreementsStatus(status({ accepted }))).toEqual(status({ accepted }));
    for (const bad of [
      null,
      {},
      { ...status(), canAccept: "yes" },
      { ...status(), current: { termsVersion: "2026-10-24" } },
      { ...status(), accepted: { ...accepted, source: "email" } },
    ])
      expect(parseHotelAccountAgreementsStatus(bad)).toBeNull();
    expect(parseHotelAccountAgreementsStatus({ ...status(), accountName: 7 })).toMatchObject({
      accountName: null,
    });

    const http = {
      get: vi.fn(async () => status() as unknown),
      post: vi.fn(async () => status({ accepted }) as unknown),
    };
    const client = createHotelAccountAgreementsClient(http);
    expect(await client.load()).toEqual(status());
    expect(http.get).toHaveBeenCalledWith("/api/hotel-account/agreements", { cache: "no-store" });
    expect(await client.accept(current)).toEqual(status({ accepted }));
    expect(http.post).toHaveBeenCalledWith("/api/hotel-account/agreements/accept", current);
    http.get.mockResolvedValueOnce({ wrong: true });
    await expect(client.load()).rejects.toThrow("invalid");
  });

  it("shows the banner only to the account admin of an account that hasn't accepted", async () => {
    const render = async (value: HotelAccountAgreementsStatus, hidden = false) => {
      let view: ReactTestRenderer;
      await act(async () => {
        view = create(
          <HotelAccountAgreementsBanner
            client={{ load: async () => value, accept: vi.fn() }}
            hidden={hidden}
          />,
        );
      });
      const html = JSON.stringify(view!.toJSON());
      act(() => view!.unmount());
      return html;
    };
    expect(await render(status())).toContain(HOTEL_ACCOUNT_AGREEMENTS_MESSAGES.title);
    expect(await render(status({ accepted }))).toBe("null");
    expect(await render(status({ canAccept: false }))).toBe("null");
    expect(await render(status(), true)).toBe("null");
  });

  it("accepts the shown versions and confirms once", async () => {
    const accept = vi.fn(async () =>
      status({ accountName: null, accepted: { ...accepted, source: "account_admin" } }),
    );
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <HotelAccountAgreementsBanner
          client={{ load: async () => status({ accountName: null }), accept }}
          acceptedHref="/settings/privacy"
          messages={{
            ...HOTEL_ACCOUNT_AGREEMENTS_MESSAGES,
            acceptedWhere: "Find it in {link}.",
            acceptedWhereLink: "Privacy & data",
          }}
        />,
      );
    });
    const section = view!.root.findByType("section");
    expect(textOf(section)).toContain("As account admin, you accept it for your hotel account");
    expect(textOf(section)).toContain("Version of 24 October 2026");
    const acceptButton = view!.root.findAll(
      (node) => node.type === "button" && textOf(node) === "Accept",
    )[0]!;
    await act(async () => acceptButton.props.onClick());
    await flush();
    expect(accept).toHaveBeenCalledWith(current);
    const confirmation = view!.root.find((node) => node.props.role === "status");
    expect(textOf(confirmation)).toBe(
      "Data processing agreement accepted for your hotel account. Find it in Privacy & data.",
    );
    const close = view!.root.find((node) => node.props["aria-label"] === "Close");
    act(() => close.props.onClick());
    expect(view!.toJSON()).toBeNull();
    act(() => view!.unmount());
  });

  it("keeps the banner and says so when accepting fails", async () => {
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <HotelAccountAgreementsBanner
          client={{
            load: async () => status(),
            accept: vi.fn(async () => {
              throw new Error("offline");
            }),
          }}
        />,
      );
    });
    const acceptButton = view!.root.findAll(
      (node) => node.type === "button" && textOf(node) === "Accept",
    )[0]!;
    await act(async () => acceptButton.props.onClick());
    expect(view!.root.findByProps({ role: "alert" }).children).toEqual([
      HOTEL_ACCOUNT_AGREEMENTS_MESSAGES.failed,
    ]);
    expect(view!.root.findAllByType("section")).toHaveLength(1);
    act(() => view!.unmount());
  });
});

describe("sign-up tickbox (VAY-2246)", () => {
  async function renderSignup() {
    const onSubmit = vi.fn(async () => undefined);
    const onGoogleSignup = vi.fn();
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <SharedSignupPage
          isSubmitting={false}
          submitError=""
          onErrorClear={vi.fn()}
          onSubmit={onSubmit}
          onGoogleSignup={onGoogleSignup}
        />,
        {
          createNodeMock: () => ({ focus: vi.fn(), scrollIntoView: vi.fn() }),
        },
      );
    });
    const input = (name: string) => view!.root.findByProps({ name });
    act(() => input("email").props.onChange({ target: { value: "owner@example.test" } }));
    act(() => input("password").props.onChange({ target: { value: "correct-password" } }));
    const submit = () =>
      act(async () => view!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    const google = () =>
      act(async () =>
        view!.root
          .findAll((node) => node.type === "button" && textOf(node).includes("Google"))[0]!
          .props.onClick(),
      );
    return { view: view!, input, submit, google, onSubmit, onGoogleSignup };
  }

  it("names the Terms, the DPA and the Privacy Policy with links that open in a new tab", async () => {
    const { view } = await renderSignup();
    const label = view.root.findByProps({ htmlFor: "accept-agreements" });
    expect(textOf(label)).toBe(
      "I accept the Terms and the Data Processing Agreement for my hotel and acknowledge the Privacy Policy.",
    );
    expect(
      label.findAllByType("a").map((link) => [textOf(link), link.props.href, link.props.target]),
    ).toEqual([
      ["Terms", "https://vayada.com/terms", "_blank"],
      ["Data Processing Agreement", "https://vayada.com/terms/dpa", "_blank"],
      ["Privacy Policy", "https://vayada.com/privacy", "_blank"],
    ]);
    expect(JSON.stringify(view.toJSON())).not.toContain("By continuing");
    act(() => view.unmount());
  });

  it("sends nothing without the tick, by email or Google", async () => {
    const { view, submit, google, onSubmit, onGoogleSignup } = await renderSignup();
    await submit();
    await google();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onGoogleSignup).not.toHaveBeenCalled();
    expect(textOf(view.root.findByProps({ id: "accept-agreements-error" }))).toBe(
      "Tick the box to accept the Terms and the Data Processing Agreement first.",
    );
    expect(view.root.findByProps({ id: "accept-agreements" }).props["aria-invalid"]).toBe(true);
    act(() => view.unmount());
  });

  it("sends the current versions once ticked", async () => {
    const { view, input, submit, google, onSubmit, onGoogleSignup } = await renderSignup();
    act(() => input("acceptAgreements").props.onChange({ target: { checked: true } }));
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      email: "owner@example.test",
      password: "correct-password",
      acceptedAgreements: current,
    });
    await google();
    expect(onGoogleSignup).toHaveBeenCalledWith(current);
    expect(view.root.findAllByProps({ id: "accept-agreements-error" })).toHaveLength(0);
    act(() => view.unmount());
  });
});
