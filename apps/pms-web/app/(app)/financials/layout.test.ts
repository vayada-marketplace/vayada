import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";

const resolveSelectedPmsPropertyId = vi.fn();
const verifyFinancialsAccess = vi.fn();
const replace = vi.fn();
const router = { replace };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/services/api/pmsPropertyClient", () => ({ resolveSelectedPmsPropertyId }));
vi.mock("@/services/finance/financialReports", () => ({ verifyFinancialsAccess }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("hides an open Financials route when access is revoked", async () => {
  const browserWindow = new EventTarget();
  vi.stubGlobal("window", browserWindow);
  resolveSelectedPmsPropertyId.mockResolvedValue("property-1");
  verifyFinancialsAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("403"));

  const { default: FinancialsLayout } = await import("./layout");
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      createElement(FinancialsLayout, null, createElement("span", null, "Sensitive data")),
    );
  });
  expect(view.toJSON()).toMatchObject({ type: "span", children: ["Sensitive data"] });

  await act(async () => {
    browserWindow.dispatchEvent(new Event("focus"));
  });
  expect(view.toJSON()).toBeNull();
  expect(replace).toHaveBeenCalledWith("/dashboard");

  act(() => view.unmount());
});
