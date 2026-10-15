import { formatStayDate } from "@/lib/utils";

/** "Fri, 20 Nov 2026 → Tue, 24 Nov 2026". Each date stays whole, so a narrow row breaks only at
 *  the arrow; a date the guest hasn't chosen yet reads "—". */
export default function StayRange({
  checkIn,
  checkOut,
  locale,
}: {
  checkIn: string;
  checkOut: string;
  locale?: string;
}) {
  const side = (date: string) => (
    <span className="whitespace-nowrap">{date ? formatStayDate(date, locale) : "—"}</span>
  );
  return (
    <>
      {side(checkIn)} → {side(checkOut)}
    </>
  );
}
