import { redirect } from "next/navigation";

// The checklist is the "Extra checks" of Settings → Check-in now (VAY-2374); old links keep working.
export default function CheckinChecklistPage() {
  redirect("/settings/check-in#extra-checks");
}
