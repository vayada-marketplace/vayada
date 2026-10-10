import { redirect } from "next/navigation";

/** Prices moved into each room's Prices tab on Rooms & Rates (VAY-2093); old links land on the room list. */
export default function PricingPage() {
  redirect("/rooms");
}
