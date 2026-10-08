import { redirectToBookPage } from "@/lib/server/retiredBookingPages";

export default function AddonsPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return redirectToBookPage(props.params, props.searchParams);
}
