import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
export type RuleInput = { minimum: string; maximum: string; closedToArrival: boolean; closedToDeparture: boolean; stopSell: boolean };
type Rules = Extract<PricingConfiguration["offers"][number]["restrictions"], { kind: "own" }>["rules"];
export const stayRuleInput = (rules: Rules): RuleInput => ({ minimum: String(rules.minArrivalNights), maximum: rules.maxStayNights === null ? "" : String(rules.maxStayNights), closedToArrival: rules.closedToArrival, closedToDeparture: rules.closedToDeparture, stopSell: rules.stopSell });
export function stayRules(input: RuleInput) {
  const integer = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
  return { minArrivalNights: integer(input.minimum), maxStayNights: input.maximum === "" ? null : integer(input.maximum), closedToArrival: input.closedToArrival, closedToDeparture: input.closedToDeparture, stopSell: input.stopSell };
}
export function StayRuleFields({ entry, label, disabled, onChange }: { entry: RuleInput; label: string; disabled: boolean; onChange: (entry: RuleInput) => void }) {
  return (
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {([["minimum", "Minimum nights"], ["maximum", "Maximum nights (blank means unlimited)"]] as const).map(([key, name]) => <label key={key}>{name}<input aria-label={`${name} for ${label}`} className="mt-1 block w-40 rounded border px-3 py-2" disabled={disabled} value={entry[key]} onChange={(event) => { onChange({ ...entry, [key]: event.target.value }); }} /></label>)}
        {([["closedToArrival", "Close arrivals"], ["closedToDeparture", "Close departures"], ["stopSell", "Stop sales"]] as const).map(([key, name]) => <label key={key} className="flex items-center gap-2 py-2"><input type="checkbox" aria-label={`${name} for ${label}`} disabled={disabled} checked={entry[key]} onChange={(event) => { onChange({ ...entry, [key]: event.target.checked }); }} />{name}</label>)}
      </div>
  );
}
