export function getBookingWebSessionId(): string {
  if (typeof window === "undefined") return "";
  let sid = sessionStorage.getItem("vayada_sid");
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem("vayada_sid", sid);
  }
  return sid;
}
