import type { ReactNode } from "react";

export const QUICK_SETUP_PREVIEW_CAPTION = "Your booking page, as guests will see it";

/**
 * VAY-2247 preview card (Paper rev 3): a plain white card with a caption (green dot) above the
 * preview, centred. No tinted area inside the card.
 */
export function QuickSetupPreviewCard({
  caption = QUICK_SETUP_PREVIEW_CAPTION,
  children,
}: {
  caption?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={caption}
      className="flex flex-col items-center gap-3.5 rounded-2xl border border-gray-200 bg-white px-[15px] pb-5 pt-4 lg:gap-5 lg:px-6 lg:pb-9 lg:pt-7"
    >
      <p className="flex items-center gap-2 text-[13px] font-semibold text-primary-800">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-green-600" />
        {caption}
      </p>
      <div className="flex w-full max-w-[520px] flex-col items-center">{children}</div>
    </section>
  );
}
