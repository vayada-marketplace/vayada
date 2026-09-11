import { parseMinorInput } from "./pricingAmounts";
export type IncludedInput = { adults: string; adjustments: { kind: string; value: string }[] };
export function includedPrice(input: IncludedInput, base: string, capacity: number, scale: number) {
  const baseGuests = Number(input.adults), baseMinor = parseMinorInput(base, scale);
  if (!/^\d+$/.test(input.adults) || !Number.isSafeInteger(baseGuests) || baseGuests < 1 || baseGuests > capacity) throw new Error("Choose the number of adults included in the base price.");
  const adjustments = Array.from({ length: capacity }, (_, index) => {
    if (index + 1 === baseGuests) return { kind: "fixed" as const, deltaMinor: "0" };
    const row = input.adjustments[index];
    if (!row || !["fixed", "percentage"].includes(row.kind) || !/^[+-]?\d+(?:\.\d+)?$/.test(row.value)) throw new Error("Enter an adjustment and choose its type for every other adult count.");
    const unsigned = parseMinorInput(row.value.replace(/^[+-]/, ""), row.kind === "fixed" ? scale : 2, true);
    const signed = BigInt(unsigned) * (row.value.startsWith("-") ? -BigInt("1") : BigInt("1"));
    const amount = row.kind === "fixed" ? BigInt(baseMinor) + signed : (BigInt(baseMinor) * (BigInt("10000") + signed) + BigInt("5000")) / BigInt("10000");
    if (amount <= BigInt("0") || amount > BigInt("999999999999999999")) throw new Error("Every adjusted room price must be positive and within the supported amount range.");
    if (row.kind === "percentage" && (signed < -BigInt("10000") || signed > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("This percentage is outside the supported range.");
    return row.kind === "fixed" ? { kind: "fixed" as const, deltaMinor: signed.toString() } : { kind: "percentage" as const, basisPoints: Number(signed) };
  });
  return { mode: "included_guests" as const, baseGuests, baseMinor, adjustments };
}
export function IncludedPricing({ value, capacity, disabled, onChange }: { value: IncludedInput; capacity: number; disabled: boolean; onChange: (value: IncludedInput) => void }) {
  const inputClass = "mt-1 block w-full rounded-lg border px-3 py-2";
  return <div className="space-y-3 sm:col-span-2">
    <label className="block text-sm">Adults included in the base price<select aria-label="Adults included in the base price" className={inputClass} disabled={disabled} value={value.adults}
      onChange={(event) => onChange({ adults: event.target.value, adjustments: [] })}><option value="">Choose…</option>
      {Array.from({ length: capacity }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
    </select></label>
    <p className="text-sm text-gray-600">Each adjustment applies once to the same base price. For a base of 130 including two adults, enter -30 for one adult and +25 for three adults to charge 100, 130 and 155. Use a minus sign for a reduction; 0 means the same price. Child charges are added separately.</p>
    {value.adults && Array.from({ length: capacity }, (_, index) => {
      if (index + 1 === Number(value.adults)) return <p key={index} className="text-sm">{index + 1} adult{index ? "s" : ""}: base price, no adjustment.</p>;
      const row = value.adjustments[index] ?? { kind: "", value: "" };
      const update = (patch: Partial<typeof row>) => onChange({ ...value, adjustments: Array.from({ length: capacity }, (_, i) => i === index ? { ...row, ...patch } : value.adjustments[i] ?? { kind: "", value: "" }) });
      return <div key={index} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Adjustment type for {index + 1} adult{index ? "s" : ""}<select aria-label={`Adjustment type for ${index + 1} adult${index ? "s" : ""}`} className={inputClass} disabled={disabled} value={row.kind} onChange={(event) => update({ kind: event.target.value, value: "" })}>
          <option value="">Choose…</option><option value="fixed">Amount in the selected currency</option><option value="percentage">Percentage of the base price</option></select></label>
        <label className="text-sm">Adjustment for {index + 1} adult{index ? "s" : ""}{row.kind === "percentage" ? " (%)" : ""}<input aria-label={`Adjustment for ${index + 1} adult${index ? "s" : ""}`} className={inputClass} disabled={disabled} value={row.value} onChange={(event) => update({ value: event.target.value })} /></label>
      </div>;
    })}
  </div>;
}
