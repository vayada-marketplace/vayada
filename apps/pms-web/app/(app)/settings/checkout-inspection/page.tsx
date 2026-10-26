import { redirect } from "next/navigation";

// The inspection is a section of Guest flows now (VAY-2275); old links keep working.
export default function CheckoutInspectionSettingsPage() {
  redirect("/settings/guest-flows#check-out");
}
