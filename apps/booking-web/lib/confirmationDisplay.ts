/** "VAY-7C2F 4A9E …": a long booking reference in groups of four, so guests can read it back. */
export function groupReference(reference: string): string {
  const match = /^([A-Za-z]+-)([0-9A-Za-z]{9,})$/.exec(reference);
  return match ? match[1] + match[2].replace(/(.{4})(?=.)/g, "$1 ") : reference;
}

/** How the booking is paid, as the payment line names it: a card, at the hotel, or another named way. */
export type PaymentWay = "card" | "at_hotel" | "named" | null;

export type PaymentLine = {
  /** "method" shows the way alone; "status" shows the payment status label; null shows no title. */
  title:
    | "paidWith"
    | "paidAtHotel"
    | "partlyPaidWith"
    | "heldOn"
    | "refundedTo"
    | "nothingCharged"
    | "payAtHotel"
    | "method"
    | "status"
    | null;
  /** "status" shows the payment status label under a method title. */
  detail:
    | "paidHint"
    | "heldHint"
    | "payAtHotelHint"
    | "refundHint"
    | "wasPayAtHotel"
    | "status"
    | null;
  /**
   * Replaces the usual Total / Total Paid / Total Due label. A held card shows the booking's total:
   * the hold itself can be only the part due now (a deposit), which the page doesn't know.
   */
  amountLabel: "dueAtHotel" | "total" | null;
};

/**
 * The confirmation page's one payment line (VAY-2307): what was paid, held, refunded or is still due,
 * and how. `status` is the guest-facing payment status: paid, partially_paid, authorized, unpaid,
 * refunded, failed or waived. An ended booking only says what was paid or refunded, never what is
 * owed; once the guest has arrived, nothing is "due at check-in" any more.
 */
export function paymentLine({
  ended,
  pending,
  arrived,
  way,
  status,
}: {
  ended: boolean;
  pending: boolean;
  arrived: boolean;
  way: PaymentWay;
  status?: string | null;
}): PaymentLine {
  const named = way === "card" || way === "named";
  const line = (
    title: PaymentLine["title"],
    detail: PaymentLine["detail"] = null,
    amountLabel: PaymentLine["amountLabel"] = null,
  ): PaymentLine => ({ title, detail, amountLabel });

  if (status === "refunded") return line(named ? "refundedTo" : "status", "refundHint");
  if (status === "paid") {
    const title = named ? "paidWith" : way === "at_hotel" ? "paidAtHotel" : "status";
    return line(title, ended ? null : "paidHint");
  }
  if (status === "partially_paid") return line(named ? "partlyPaidWith" : "status");
  if (ended) {
    if (!status) return line(named ? "method" : null);
    return line("nothingCharged", way === "at_hotel" ? "wasPayAtHotel" : null);
  }
  if (status === "authorized") {
    return line(named ? "heldOn" : "status", pending ? "heldHint" : null, "total");
  }
  if (way === "at_hotel" && (!status || status === "unpaid")) {
    return arrived
      ? line("payAtHotel", status ? "status" : null)
      : line("payAtHotel", "payAtHotelHint", "dueAtHotel");
  }
  if (named) return line("method", status ? "status" : null);
  return line(status ? "status" : null);
}
