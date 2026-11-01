import { MapPinIcon } from "@heroicons/react/24/outline";

/** "Guests will see" (VAY-2321), shared by the PMS room editor and onboarding (VAY-2444): the place's name, its
 * address as guests read it, and an optional line such as the distance to the main property. */
export default function GuestsWillSeeCard({
  label,
  name,
  address,
  note = null,
}: {
  label: string;
  name: string;
  address: string;
  /** Shown with a pin icon under the address. */
  note?: string | null;
}) {
  return (
    <div className="space-y-1 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</p>
      <p className="text-[13px] font-semibold text-gray-900">{name}</p>
      <p className="text-[12px] text-gray-600">{address}</p>
      {note && (
        <p className="inline-flex items-center gap-1 text-[12px] text-gray-500">
          <MapPinIcon className="h-3.5 w-3.5" />
          {note}
        </p>
      )}
    </div>
  );
}
