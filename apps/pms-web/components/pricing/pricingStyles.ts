/** The Room Details tab's look (RoomTypeForm), so the room page's Prices tab matches the tab next to it. */
export const card =
  "bg-white rounded-xl border border-gray-200 px-4 py-5 md:px-6 md:py-6 space-y-5";
/** A dashed card for something being added, like Room Details' location card. */
export const draftCard = "rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-4";
export const cardHeading = "text-[11px] font-bold text-gray-900 uppercase tracking-widest";
export const label = "block text-[12px] font-semibold text-gray-900 mb-1.5";
/** A grey filled field without a width; each use sets one. It resets the weight of a label it sits in. */
export const field =
  "px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] font-normal focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 disabled:cursor-not-allowed disabled:text-gray-500";
export const input = `w-full ${field}`;
/** A label that wraps its field. */
export const fieldLabel = "block text-[12px] font-semibold text-gray-900";
export const hint = "text-[10px] text-gray-400";
export const help = "text-[11px] text-gray-500";
export const errorText = "text-[11px] font-medium text-red-600";
/** One saved rule in a section's list, with its Edit/Clear buttons. */
export const entry = "flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 px-3 py-2";
/** A fixed fact shown in place of a section, e.g. stay rules inherited from the parent offer. */
export const note =
  "rounded-lg border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-700";
export const text = "text-[12px] text-gray-700";
/** Outlined secondary button, like "+ Add Bed". */
export const secondaryButton =
  "inline-flex items-center gap-1.5 text-[12px] text-gray-700 font-medium px-3 py-1.5 border border-gray-300 rounded-lg bg-white hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const primaryButton =
  "inline-flex items-center gap-1.5 px-4 py-1.5 bg-primary-600 text-white text-[12px] font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const errorBanner =
  "p-3 bg-red-50 border border-red-200 rounded-lg text-[11px] text-red-700 font-medium";
export const successBanner =
  "p-3 bg-green-50 border border-green-200 rounded-lg text-[11px] text-green-700 font-medium";
export const warningBanner =
  "p-3 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-800 font-medium";
/** The Save/Cancel bar at the bottom of the room tabs: sticky, with its own background so the page scrolls under it
 * rather than through it (VAY-2184). */
export const actionBar =
  "mt-6 flex items-center justify-end gap-3 sticky bottom-0 -mx-4 md:mx-0 px-4 md:px-0 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-gray-50/95 backdrop-blur border-t border-gray-200 z-10";
export const actionBarButton =
  "flex-1 md:flex-initial text-center px-4 py-2.5 md:py-2 text-[13px] md:text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const actionBarPrimary =
  "flex-1 md:flex-initial px-6 py-2.5 md:py-2 bg-primary-600 text-white text-[13px] md:text-[12px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";
/** The shared pricing forms (first price, included adults, payment methods) in this look. */
export const formLook = {
  heading: cardHeading,
  text,
  hint: help,
  smallHint: hint,
  label: fieldLabel,
  legend: fieldLabel,
  check: "flex items-center gap-2 text-[12px] text-gray-700",
  input: `mt-1.5 block w-full ${field}`,
  error: errorText,
  button: primaryButton,
};
/** The step-by-step tab (Paper design "Prices tab – step by step"): numbered question cards, their chips and buttons. */
export const stepCard =
  "flex gap-4 rounded-2xl border border-gray-200 bg-white p-5 md:gap-[18px] md:p-7";
/** The simple Prices card (VAY-2188): one white card whose sections are split by lines. */
export const pricesCard = "rounded-2xl border border-gray-200 bg-white px-5 md:px-7";
export const pricesSection = "space-y-4 border-gray-100 py-6 [&:not(:first-child)]:border-t";
/** A blue line saying the room keeps settings the card's top doesn't show. */
export const infoBanner =
  "rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-[14px] leading-5 text-blue-800";
/** An on/off switch's track; the knob sits right when on. */
export const switchTrack = (on: boolean) =>
  `inline-flex h-6 w-10 shrink-0 items-center rounded-full px-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    on ? "justify-end bg-primary-600" : "justify-start bg-gray-300"
  }`;
export const stepNumber =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-600 text-[14px] font-bold text-white";
export const stepTitle = "text-[17px] font-semibold leading-6 text-gray-900";
/** A "Price rules" step's number (VAY-2280). */
export const sectionNumber =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[12px] font-semibold text-white";
export const stepHint = "text-[14px] leading-5 text-gray-500";
export const stepButton =
  "inline-flex h-10 items-center gap-2 rounded-[10px] border border-gray-300 bg-white px-4 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";
export const stepLink =
  "text-[14px] font-medium text-primary-600 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
export const chip = (selected: boolean) =>
  `inline-flex h-10 items-center rounded-full border px-[18px] text-[14px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    selected
      ? "border-primary-600 bg-primary-600 font-semibold text-white"
      : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
  }`;
