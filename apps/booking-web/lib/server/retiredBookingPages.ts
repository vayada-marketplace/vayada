import { redirect } from "@/i18n/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The legacy room, add-on and payment pages belong to the retired booking flow
 * (VAY-1543 C.2). Guests who still land on them continue on the room-and-price
 * page in the same locale, keeping any stay dates they had already chosen.
 */
export async function redirectToBookPage(
  params: Promise<{ locale: string }>,
  searchParams: Promise<SearchParams>,
): Promise<never> {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  const query: Record<string, string> = {};
  for (const key of ["checkIn", "checkOut"]) {
    const value = search[key];
    if (typeof value === "string" && value) query[key] = value;
  }
  redirect({ href: { pathname: "/book", query }, locale });
}
