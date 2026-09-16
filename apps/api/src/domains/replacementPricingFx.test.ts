import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createReplacementPricingFxReader, REPLACEMENT_FX_ATTRIBUTION } from "./replacementPricingFx.js";
const initial = Date.parse("2026-09-10T12:00:00.000Z"), hour = 3_600_000;
const payload = (rates = '"EUR":1,"JPY":160.123456789012345,"IDR":50000,"KWD":0.307', base = "EUR") => `{
  "result":"success","provider":"https://www.exchangerate-api.com","base_code":"${base}",
  "time_last_update_unix":${(initial - hour) / 1000},"time_next_update_unix":${(initial + hour) / 1000},"time_eol_unix":0,"rates":{${rates}}}`;
const response = (body = payload()) => new Response(body, { headers: { "content-type": "application/json" } });
describe("trusted replacement pricing FX reader", () => {
  it("uses fixed HTTPS and exact JSON numeric tokens, including scale normalization", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response()), reader = createReplacementPricingFxReader({ fetch: fetcher, now: () => initial });
    const fx = await reader.read("EUR", "JPY");
    expect(fx).toMatchObject({ from: "EUR", to: "JPY", numerator: "32024691357802469", denominator: "20000000000000000",
      observedAt: "2026-09-10T11:00:00.000Z", expiresAt: "2026-09-10T13:00:00.000Z" });
    expect(fetcher).toHaveBeenCalledWith("https://open.er-api.com/v6/latest/EUR", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
    expect(await reader.read("EUR", "JPY")).toEqual(fx);
    expect(await reader.read("EUR", "IDR")).toMatchObject({ numerator: "50000", denominator: "1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(REPLACEMENT_FX_ATTRIBUTION.url).toBe("https://www.exchangerate-api.com");
    const kwd = createReplacementPricingFxReader({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response(payload('"KWD":1,"IDR":5e4', "KWD"))), now: () => initial });
    expect(await kwd.read("KWD", "IDR")).toMatchObject({ numerator: "5000", denominator: "1" });
    const precise = createReplacementPricingFxReader({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response(payload('"EUR":1,"USD":9007199254740993'))), now: () => initial });
    expect(await precise.read("EUR", "USD")).toMatchObject({ numerator: "9007199254740993", denominator: "1" });
    const small = createReplacementPricingFxReader({ fetch: async () => response(payload('"EUR":1,"USD":3.07e-3')), now: () => initial });
    expect(await small.read("EUR", "USD")).toMatchObject({ numerator: "307", denominator: "100000" });
  });
  it("coalesces concurrent requests, refreshes at expiry and never serves stale data on failure", async () => {
    let time = initial;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockRejectedValue(new Error("offline"));
    const reader = createReplacementPricingFxReader({ fetch: fetcher, now: () => time });
    const results = await Promise.all([reader.read("EUR", "JPY"), reader.read("EUR", "IDR"), reader.read("EUR", "JPY")]);
    expect(results.every(Boolean)).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    time += hour;
    expect(await reader.read("EUR", "JPY")).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await reader.read("EUR", "JPY")).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
    time += hour;
    expect(await reader.read("EUR", "JPY")).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("binds IDs to exact pair, ratio and provider observation window", async () => {
    async function read(body: string, to = "IDR") { return createReplacementPricingFxReader({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response(body)), now: () => initial }).read("EUR", to); }
    const first = await read(payload());
    expect(first?.id).toMatch(/^exchange-rate-api:[a-f0-9]{64}$/);
    expect((await read(payload()))?.id).toBe(first?.id);
    expect((await read(payload(), "JPY"))?.id).not.toBe(first?.id);
    expect((await read(payload().replace(String((initial + hour) / 1000), String((initial + 2 * hour) / 1000))))?.id).not.toBe(first?.id);
    expect((await read(payload().replace('"IDR":50000', '"IDR":50001')))?.id).not.toBe(first?.id);
    expect((await read(payload().replace(String((initial - hour) / 1000), String((initial - hour + 1000) / 1000))))?.id).not.toBe(first?.id);
  });
  it("rejects invalid, stale, future, retired and missing evidence without a fallback", async () => {
    const bodies = ["bad json", "null", payload().replace('"success"', '"error"'), payload().replace('"base_code":"EUR"', '"base_code":"USD"'),
      payload().replace('https://www.exchangerate-api.com', 'https://other.test'),
      payload().replace(String((initial - hour) / 1000), String((initial + 1000) / 1000)),
      payload().replace(String((initial + hour) / 1000), String(initial / 1000)),
      payload().replace('"time_eol_unix":0', `"time_eol_unix":${initial / 1000}`),
      ...['0', '-1', '"160"', 'null', '{"text":"160"}', '1e999', '1e-100', '123456789012345678901'].map((r) => payload(`"EUR":1,"JPY":${r}`)),
      payload('"EUR":2,"JPY":160'), payload('"EUR":1'),
    ];
    for (const body of bodies) {
      const reader = createReplacementPricingFxReader({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response(body)), now: () => initial });
      expect(await reader.read("EUR", "JPY"), body).toBeNull();
    }
    const fetcher = vi.fn<typeof fetch>(), reader = createReplacementPricingFxReader({ fetch: fetcher, now: () => initial });
    for (const [from, to] of [["EUR", "EUR"], ["../EUR", "USD"], ["EUR", "XXX"], ["eur", "JPY"]]) expect(await reader.read(from, to)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks freshness after body consumption, caps validity and honors earlier EOL", async () => {
    let time = initial;
    const reader = createReplacementPricingFxReader({ now: () => time, fetch: async () => { time += 2 * hour; return response(); } });
    expect(await reader.read("EUR", "JPY")).toBeNull();
    const body = payload().replace(String((initial + hour) / 1000), String((initial + 72 * hour) / 1000));
    const capped = createReplacementPricingFxReader({ now: () => initial, fetch: async () => response(body) });
    expect((await capped.read("EUR", "JPY"))?.expiresAt).toBe(new Date(initial + 23 * hour).toISOString());
    const eol = body.replace('"time_eol_unix":0', `"time_eol_unix":${(initial + hour) / 1000}`);
    expect((await createReplacementPricingFxReader({ now: () => initial, fetch: async () => response(eol) }).read("EUR", "JPY"))?.expiresAt).toBe(new Date(initial + hour).toISOString());
  });
  it("aborts an actual stalled response body at the transport deadline", async () => {
    let bodyStarted = false;
    const server = createServer((_request, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); bodyStarted = true; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init));
    try {
      expect(await createReplacementPricingFxReader({ fetch: transport, now: () => initial }).read("EUR", "JPY")).toBeNull();
      expect(bodyStarted).toBe(true);
      expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 15_000);
  it("fails closed on HTTP, redirect, body limits and aborted transport", async () => {
    const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true });
    for (const res of [new Response("rate limited", { status: 429 }), redirected,
      new Response(" ".repeat(131073)), new Response("{}", { headers: { "content-length": "999999" } })]) {
      expect(await createReplacementPricingFxReader({ fetch: async () => res, now: () => initial }).read("EUR", "JPY")).toBeNull();
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    expect(await createReplacementPricingFxReader({ fetch: fetcher, now: () => initial }).read("EUR", "JPY")).toBeNull();
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
