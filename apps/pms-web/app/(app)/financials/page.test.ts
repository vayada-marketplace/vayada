import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const resolveSelectedPmsPropertyId = vi.fn();
const getPublicPropertyProfile = vi.fn();
const getFinanceDashboard = vi.fn();

vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId,
}));

vi.mock("@/lib/settings/PmsAccessContext", () => ({
  usePmsAccess: () => ({ permissions: [] }),
}));

vi.mock("@/services/api/sharedHotelSetupClient", () => ({
  sharedHotelSetupApi: { getPublicPropertyProfile },
}));

vi.mock("@/services/finance/financialReports", () => ({
  getFinanceDashboard,
}));

describe("Financials Dashboard", () => {
  it("keeps AI Insights and exports inert while Financials loads", async () => {
    resolveSelectedPmsPropertyId.mockResolvedValue("property-1");
    getFinanceDashboard.mockImplementation(() => new Promise(() => {}));
    getPublicPropertyProfile.mockImplementation(() => new Promise(() => {}));
    const { default: FinancialsPage } = await import("./page");
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(createElement(FinancialsPage));
    });

    expect(getFinanceDashboard).toHaveBeenCalledWith("property-1", expect.anything());
    expect(view.root.findByProps({ "aria-label": "Loading Financials" }).props["aria-busy"]).toBe(
      "true",
    );
    const tabs = (tablist: string) =>
      view.root
        .findByProps({ "aria-label": tablist })
        .findAllByProps({ role: "tab" })
        .map(textContent);
    expect(tabs("Financials sections")).toEqual(["Dashboard", "Folios"]);
    expect(tabs("Financial insights")).toEqual([
      "Dashboard",
      "Revenue",
      "Expenses",
      "Profit & Loss",
    ]);
    // Exports render only once data is ready, so the only action shown is AI Insights.
    const actions = view.root
      .findAllByType("button")
      .filter((button) => button.props.role !== "tab");
    expect(actions.map(textContent)).toEqual(["AI Insights"]);
    expect(actions.filter((button) => !button.props.disabled).map(textContent)).toEqual([]);
  });
});

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("")
    .trim();
}
