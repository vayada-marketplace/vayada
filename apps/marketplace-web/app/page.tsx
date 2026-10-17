import { redirect } from "next/navigation";

import { marketingUrl } from "@/redirectTargets";

// VAY-2270: the Marketplace app is a redirect stub (see next.config.js); the home page forwards too.
export default function Home() {
  redirect(marketingUrl);
}
