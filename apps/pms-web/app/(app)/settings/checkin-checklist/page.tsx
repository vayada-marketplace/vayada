import { redirect } from "next/navigation";

// The checklist is a section of Guest flows now (VAY-2275); old links keep working.
export default function CheckinChecklistPage() {
  redirect("/settings/guest-flows#check-in");
}
