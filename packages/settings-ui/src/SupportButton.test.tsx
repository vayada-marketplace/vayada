import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSupportAvailable, SupportButton, SupportDialog } from "./SupportButton";

const submit = async () => ({ status: "accepted", reference: "support-test" });

afterEach(() => vi.unstubAllEnvs());

describe("SupportButton placement", () => {
  it("preserves the floating default for existing consumers", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED", "true");
    const markup = renderToStaticMarkup(<SupportButton product="booking-admin" submit={submit} />);

    expect(markup).toContain("fixed bottom-4 right-4 z-40 px-3 py-2 shadow-sm");
    expect(markup).toContain(">Help / Report a bug</button>");
    expect(markup).toContain('aria-label="Help and bug reports"');
  });

  it("renders the dialog without a trigger so a menu item can open it", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED", "true");
    const markup = renderToStaticMarkup(<SupportDialog product="pms" submit={submit} />);

    expect(markup).toMatch(/^<dialog /);
    expect(markup).toContain('aria-label="Help and bug reports"');
    expect(markup).not.toContain("fixed bottom-4");
  });

  it("hides both entry points when AuthKit login is off", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED", "false");

    expect(isSupportAvailable()).toBe(false);
    expect(renderToStaticMarkup(<SupportButton product="pms" submit={submit} />)).toBe("");
    expect(renderToStaticMarkup(<SupportDialog product="pms" submit={submit} />)).toBe("");
  });
});
