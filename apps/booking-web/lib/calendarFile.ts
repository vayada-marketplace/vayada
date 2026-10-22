const escapeText = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const compactDate = (date: string) => date.replaceAll("-", "");

/** The day after a YYYY-MM-DD date: an all-day event's end is exclusive. */
function nextDay(date: string) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** RFC 5545 lines are at most 75 octets; longer ones continue on lines that start with a space. */
function fold(line: string) {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    const limit = parts.length === 0 ? 75 : 74;
    if (encoder.encode(current + char).length > limit) {
      parts.push(current);
      current = "";
    }
    current += char;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/**
 * The stay as one all-day calendar event from the check-in day through the check-out day
 * (VAY-2307 "Add to calendar"). All-day dates need no time zone; the times go in the notes.
 * The reference makes the event's UID, so importing it again updates the same event.
 */
export function stayCalendarFile({
  reference,
  title,
  location,
  checkIn,
  checkOut,
  notes,
  now = new Date(),
}: {
  reference: string;
  title: string;
  location?: string;
  checkIn: string;
  checkOut: string;
  notes: string;
  now?: Date;
}): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vayada//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeText(reference)}@booking.vayada.com`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compactDate(checkIn)}`,
    `DTEND;VALUE=DATE:${compactDate(nextDay(checkOut))}`,
    `SUMMARY:${escapeText(title)}`,
    ...(location ? [`LOCATION:${escapeText(location)}`] : []),
    `DESCRIPTION:${escapeText(notes)}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .map(fold)
    .join("\r\n")
    .concat("\r\n");
}
