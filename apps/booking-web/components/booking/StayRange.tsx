import { formatStayDate } from "@/lib/utils";

/** "Fri, 20 Nov 2026 → Tue, 24 Nov 2026". Each date stays whole and the arrow stays with the first,
 *  so a narrow row breaks only after the arrow; a date the guest hasn't chosen yet reads "—". */
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
      <span className="whitespace-nowrap">{label(checkIn)} →</span>{" "}
      <span className="whitespace-nowrap">{label(checkOut)}</span>
    </>
  );
}
