import { notFound } from "next/navigation";
import { AirbnbImportReturn } from "@/components/setup/AirbnbImportReturn";

export const dynamic = "force-dynamic";
export const metadata = { title: "Airbnb connection | Vayada", referrer: "no-referrer" as const };

export default async function AirbnbReturnPage({
  params,
}: {
  params: Promise<{ propertyId: string; sourceId: string }>;
}) {
  const ids = await params;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    process.env.AIRBNB_IMPORT_CALLBACK_ENABLED !== "true" ||
    !uuid.test(ids.propertyId) ||
    !uuid.test(ids.sourceId)
  )
    notFound();
  return <AirbnbImportReturn key={`${ids.propertyId}:${ids.sourceId}`} {...ids} />;
}
