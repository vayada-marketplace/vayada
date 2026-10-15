import { formatStayDate } from "@/lib/utils";

/** "Fri, 20 Nov 2026 → Tue, 24 Nov 2026". Each date stays whole and the arrow stays with the first,
 *  so a narrow row breaks only after the arrow. Inline blocks (not nowrap) still wrap inside a date
 *  when even one no longer fits, e.g. at 200% text zoom. A date not chosen yet reads "—". */
export default function StayRange({
  checkIn,
  checkOut,
  locale,
}: {
  checkIn: string;
  checkOut: string;
  locale?: string;
}) {
  const label = (date: string) => (date ? formatStayDate(date, locale) : "—");
  return (
    <>
      <span className="inline-block">{label(checkIn)} →</span>{" "}
      <span className="inline-block">{label(checkOut)}</span>
    </>
  );
}
