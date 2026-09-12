import { createHash } from "node:crypto";
import { pricingCurrencyScale, pricingInteger, pricingObject, type PricingConversionRate } from "@vayada/domain-pms";

export const REPLACEMENT_FX_ATTRIBUTION = { label: "Rates By Exchange Rate API", url: "https://www.exchangerate-api.com" } as const;
const provider = REPLACEMENT_FX_ATTRIBUTION.url;
const hour = 3_600_000, day = 24 * hour, maxBytes = 131_072;
// Node 24+ source text avoids rounding JSON rate tokens through Number.
class ExactNumber { constructor(readonly text: string | undefined) {} }
type Observation = { rates: Record<string, unknown>; observed: number; expires: number };
const epoch = (v: unknown): number => v instanceof ExactNumber && v.text && /^(0|[1-9][0-9]{0,10})$/.test(v.text) ? Number(v.text) * 1000 : NaN;
function decode(body: string, base: string, now: number): Observation | null {
  const data: unknown = JSON.parse(body, (_key, value, context?: { source?: string }) => typeof value === "number" ? new ExactNumber(context?.source) : value);
  if (!pricingObject(data) || data.result !== "success" || data.provider !== provider || data.base_code !== base || !pricingObject(data.rates)) return null;
  const observed = epoch(data.time_last_update_unix), next = epoch(data.time_next_update_unix), eol = epoch(data.time_eol_unix);
  const expires = Math.min(next, observed + day, eol === 0 ? Infinity : eol);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || !Number.isFinite(eol) || observed > now || expires <= now) return null;
  const baseRate = data.rates[base];
  if (!(baseRate instanceof ExactNumber) || !baseRate.text || !/^1(?:\.0+)?(?:[eE][+]?0+)?$/.test(baseRate.text)) return null;
  return { rates: data.rates, observed, expires };
}
function ratio(value: unknown, fromScale: number, toScale: number): { numerator: string; denominator: string } | null {
  if (!(value instanceof ExactNumber) || !value.text || value.text.length > 80) return null;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(value.text);
  if (!match) return null;
  const shift = Number(match[3] ?? "0") - (match[2]?.length ?? 0) + toScale - fromScale;
  if (Math.abs(shift) > 100) return null;
  let n = BigInt(match[1] + (match[2] ?? "")), d = 1n;
  if (n <= 0n) return null;
  if (shift >= 0) n *= 10n ** BigInt(shift); else d = 10n ** BigInt(-shift);
  let a = n, b = d;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  n /= a; d /= a;
  return n.toString().length <= 18 && d.toString().length <= 18 ? { numerator: n.toString(), denominator: d.toString() } : null;
}
async function boundedBody(response: Response): Promise<string> {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel(); throw new Error("FX response too large or empty");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) throw new Error("FX response too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Server-owned reader; dependencies are server/test wiring, never request JSON.
 * Fetch outside property DB locks. This supplies FX observations, not publication approval. */
export function createReplacementPricingFxReader(dependencies: { fetch?: typeof fetch; now?: () => number } = {}) {
  const request = dependencies.fetch ?? fetch, now = dependencies.now ?? Date.now;
  const cache = new Map<string, { until: number; promise: Promise<Observation | null> }>();
  async function load(base: string): Promise<Observation | null> {
    try {
      const response = await request(`https://open.er-api.com/v6/latest/${base}`, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (!response.ok || response.redirected) { await response.body?.cancel(); return null; }
      return decode(await boundedBody(response), base, now());
    } catch { return null; }
  }
  return {
    async read(from: string, to: string): Promise<PricingConversionRate | null> {
      const fromScale = pricingCurrencyScale(from), toScale = pricingCurrencyScale(to), started = now();
      if (from === to || fromScale === null || toScale === null || !pricingInteger(started)) return null;
      let entry = cache.get(from);
      if (!entry || started >= entry.until) {
        const fresh = { until: started + hour, promise: load(from) };
        fresh.promise = fresh.promise.then((data) => { fresh.until = data?.expires ?? now() + hour; return data; });
        cache.set(from, fresh); entry = fresh;
      }
      const data = await entry.promise, current = now();
      if (!data || !pricingInteger(current) || data.observed > current || data.expires <= current) return null;
      const rate = ratio(data.rates[to], fromScale, toScale);
      if (!rate) return null;
      const observation = { from, to, ...rate, observedAt: new Date(data.observed).toISOString(), expiresAt: new Date(data.expires).toISOString() };
      const id = createHash("sha256").update(JSON.stringify({ provider, ...observation })).digest("hex");
      return { id: `exchange-rate-api:${id}`, ...observation };
    },
  };
}
