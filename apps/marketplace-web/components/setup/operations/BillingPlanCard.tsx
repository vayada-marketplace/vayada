"use client";

/** One plan option, shared by the old setup task and the Payments step (VAY-2171). */
export function PlanCard({
  badge,
  checked,
  description,
  disabled = false,
  label,
  onChange,
  price,
  secondary,
}: {
  badge?: string;
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: () => void;
  price: string;
  secondary?: string;
}) {
  return (
    <label
      className={`relative rounded-2xl border-2 p-5 transition ${
        checked ? "border-primary-600 bg-primary-50/60" : "border-gray-200 bg-white"
      } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-primary-300"}`}
    >
      <span className="flex items-start justify-between gap-3">
        <span>
          <span className="block text-base font-semibold text-gray-950">{label}</span>
          <span className="mt-3 block text-xl font-bold text-gray-950">{price}</span>
          {secondary ? <span className="mt-1 block text-xs text-gray-500">{secondary}</span> : null}
          <span className="mt-3 block text-sm leading-6 text-gray-600">{description}</span>
        </span>
        <input
          checked={checked}
          className="mt-1 h-5 w-5 accent-primary-600"
          disabled={disabled}
          name="billing-plan"
          onChange={onChange}
          type="radio"
        />
      </span>
      {badge ? (
        <span className="mt-4 inline-flex rounded-full bg-primary-100 px-2.5 py-1 text-xs font-semibold text-primary-800">
          {badge}
        </span>
      ) : null}
    </label>
  );
}
