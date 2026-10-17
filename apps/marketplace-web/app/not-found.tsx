import { redirect } from "next/navigation";

import { marketingUrl } from "@/redirectTargets";

// Every old Marketplace route that next.config.js does not name ends up here and forwards.
export default function NotFound() {
  redirect(marketingUrl);
}
