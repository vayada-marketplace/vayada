import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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
    resolveSelectedPmsPropertyId.mockImplementation(() => new Promise(() => {}));
    const { default: FinancialsPage } = await import("./page");
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(createElement(FinancialsPage));
    });

    expect(view.root.findByProps({ "aria-label": "Loading Financials" })).toBeDefined();
    const buttons = view.root.findAllByType("button");
    expect(buttons.filter((button) => button.props.disabled)).toHaveLength(2);
    expect(view.root.findAllByProps({ role: "tab" })).toHaveLength(4);
  });
});
