/** VAY-2451 setup steps' shared look (Timo's mockup): field label, 48 px inputs, the step's heading. */
export const SETUP_LABEL = "block text-sm font-semibold text-gray-700";
export const SETUP_INPUT =
  "mt-1.5 block h-12 w-full rounded-[10px] border border-gray-300 bg-white px-3.5 text-[15px] text-gray-950 outline-none placeholder:text-gray-400 focus:border-primary-600 focus:ring-2 focus:ring-primary-100 disabled:bg-gray-100 disabled:text-gray-600";

export function SetupStepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h1
        id="setup-step-heading"
        tabIndex={-1}
        className="text-[26px] font-bold leading-tight tracking-tight text-gray-950 outline-none min-[720px]:text-[30px]"
      >
        {title}
      </h1>
      <p className="mt-2 text-[15px] leading-6 text-gray-600 min-[720px]:text-base">{subtitle}</p>
    </header>
  );
}
