/** @vitest-environment jsdom */
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AffiliateClickTracker } from "./AffiliateClickTracker";

const state = vi.hoisted(() => ({ query: "ref=A", record: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(state.query) }));
vi.mock("@/services/api/hotel", () => ({ hotelService: { recordAffiliateClick: state.record } }));

it("gives repeat referral arrivals distinct IDs, reuses the ID on effect replay, and ignores cookie-only visits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  document.cookie = "ref=old-creator";
  const render = async (query: string) => {
    state.query = query;
    await act(async () =>
      root.render(
        createElement(StrictMode, null, createElement(AffiliateClickTracker, { slug: "hotel" })),
      ),
    );
  };
  try {
    await render("ref=A");
    expect(state.record).toHaveBeenCalledTimes(2);
    const firstId = state.record.mock.calls[0][2];
    expect(state.record.mock.calls[1][2]).toBe(firstId);
    await render("ref=B");
    await render("ref=A");
    const calls = state.record.mock.calls;
    expect(calls.map((c) => c[1])).toEqual(["A", "A", "B", "A"]);
    expect(new Set(calls.map((c) => c[2])).size).toBe(3);
    await render("");
    expect(state.record).toHaveBeenCalledTimes(4);
    await render("ref=A");
    expect(new Set(state.record.mock.calls.map((c) => c[2])).size).toBe(4);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
