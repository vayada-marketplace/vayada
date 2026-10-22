import type { ReactNode } from "react";

/** VAY-2231: the add-on card guests see on the booking page's extras step. Booking Admin's editor
 * renders this same card as its preview, so what the host sees is what guests get. */

/** "€25", the way the booking page shows a price (booking-web's CurrencyContext.formatPrice). */
export function formatGuestPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

/** "/ person / night" after the price, from the add-on's pricing model. */
export function guestAddonUnit(perPerson: boolean, perNight: boolean): string {
  return perPerson ? (perNight ? "/ person / night" : "/ person") : perNight ? "/ night" : "/ stay";
}

export const guestAddonAddClass =
  "px-5 py-1.5 rounded-full text-sm font-semibold border-2 transition-colors bg-white text-gray-700 border-gray-300 hover:border-gray-400 disabled:opacity-40";

const tones = {
  idle: "border-gray-200",
  chosen: "border-primary-500 shadow-md",
  attention: "border-amber-400 shadow-md",
};

const plainPhoto = (src: string) => (
  <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />
);

export function GuestAddonCard({
  name,
  description,
  photo,
  price,
  unit,
  tone = "idle",
  action,
  children,
  renderPhoto = plainPhoto,
}: {
  name: string;
  description: string;
  photo: string | null;
  /** The formatted price, or null when the hotel shows none. */
  price: string | null;
  unit: string;
  /** "chosen" once added; "attention" while an added extra still needs its day. */
  tone?: keyof typeof tones;
  /** The Add button, or the counter once added. */
  action: ReactNode;
  /** Notices and the night or day choice under the price. */
  children?: ReactNode;
  /** booking-web draws photos with next/image; a plain img elsewhere. */
  renderPhoto?: (src: string) => ReactNode;
}) {
  return (
    <article
      aria-label={name}
      className={`bg-white border rounded-2xl overflow-hidden transition-shadow ${tones[tone]}`}
    >
      <div className="relative h-48 bg-gray-100 flex items-center justify-center">
        {photo ? (
          renderPhoto(photo)
        ) : (
          <svg
            className="w-10 h-10 text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"
            />
          </svg>
        )}
      </div>
      <div className="p-4">
        <h3 className="text-base font-bold text-gray-900 mb-1">{name}</h3>
        {description && <p className="text-sm text-gray-500 mb-4 line-clamp-2">{description}</p>}
        <div className="flex items-center justify-between gap-3">
          <p className="text-lg font-bold text-gray-900">
            {price !== null && (
              <>
                {price}
                <span className="text-xs font-normal text-gray-500"> {unit}</span>
              </>
            )}
          </p>
          {action}
        </div>
        {children}
      </div>
    </article>
  );
}
