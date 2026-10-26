import { notFound } from "next/navigation";
import { AirbnbImportStart } from "@/components/setup/AirbnbImportStart";
export const dynamic = "force-dynamic";
export const metadata = { title: "Connect Airbnb | Vayada", referrer: "no-referrer" as const };
export default async function AirbnbConnectPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  if (
    process.env.AIRBNB_IMPORT_CALLBACK_ENABLED !== "true" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(propertyId)
  )
    notFound();
  return <AirbnbImportStart key={propertyId} propertyId={propertyId} />;
}
