/** Dates of birth are typed as "DD / MM / YYYY" in every language, not the browser's date picker
 * (VAY-2418); the registration stores YYYY-MM-DD. */
export const BIRTH_DATE_PLACEHOLDER = "DD / MM / YYYY";

/** What the field shows while typing: digits only, " / " after the day and the month. */
export function birthDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join(" / ");
}

/** "1912-06-23" → "23 / 06 / 1912". */
export function birthDateText(iso: string): string {
  const [year, month, day] = iso.split("-");
  return iso ? `${day} / ${month} / ${year}` : "";
}

/** The typed date as YYYY-MM-DD, "" when the field is empty, or null when it isn't a real date
 * between 1900 and `today` (the API's rule). */
export function parseBirthDate(text: string, today: string): string | null {
  const digits = text.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length !== 8) return null;
  const iso = `${digits.slice(4)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return iso >= "1900-01-01" && iso <= today ? iso : null;
}
