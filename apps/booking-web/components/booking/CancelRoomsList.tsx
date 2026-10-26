"use client";

import { useTranslations } from "next-intl";
import type { CancelPreview, CancelPreviewRoom } from "@/services/api/booking";

/** VAY-2320: before a booking with several rooms is cancelled, each room under its own terms:
 * the fee the hotel may charge for it when nothing was paid, or what goes back and what the
 * hotel keeps when it was paid. */
export default function CancelRoomsList({
  preview,
  rooms,
  formatPrice,
}: {
  preview: CancelPreview;
  rooms: CancelPreviewRoom[];
  formatPrice: (amount: number, currency: string) => string;
}) {
  const t = useTranslations("myBooking");
  const money = (amount: number) => formatPrice(amount, preview.currency);
  const paid = (preview.amountPaid ?? 0) > 0;
  // Each room's own share goes back only when the whole stay was paid; a deposit's refund is
  // the booking's alone.
  const stayTotal = rooms.reduce((sum, room) => sum + room.refundAmount + room.keptAmount, 0);
  const paidInFull = paid && (preview.amountPaid ?? 0) >= stayTotal - 0.005;
  const fee = preview.cancellationFeeAmount ?? 0;
  const terms = (room: CancelPreviewRoom) =>
    room.rule === "non_refundable"
      ? t("roomNonRefundable")
      : room.rule === "partial_refund"
        ? t("roomPartialRefund", { percent: room.refundPercent })
        : room.refundPercent === 100
          ? t("freeCancellation")
          : t("roomFreeCancellationEnded");
  return (
    <div
      data-testid="cancel-rooms"
      className="flex flex-col overflow-hidden rounded-xl border border-gray-200"
    >
      {rooms.map((room, index) => {
        const kept = room.keptAmount > 0;
        return (
          <div
            key={index}
            className={`flex items-start justify-between gap-4 px-4 py-3 ${index ? "border-t border-gray-100" : ""}`}
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900">
                {room.roomName
                  ? t("cancelRoomLine", { number: index + 1, room: room.roomName })
                  : t("cancelRoomLabel", { number: index + 1 })}
              </p>
              <p className="text-xs text-gray-600">{terms(room)}</p>
            </div>
            <div className="flex-shrink-0 text-right">
              {!paid ? (
                <p className={`text-sm font-semibold ${kept ? "text-red-700" : "text-green-700"}`}>
                  {kept ? t("roomFee", { amount: money(room.keptAmount) }) : t("roomNoFee")}
                </p>
              ) : (
                <>
                  {paidInFull && (
                    <p
                      className={`text-sm font-semibold ${room.refundAmount > 0 ? "text-green-700" : "text-red-700"}`}
                    >
                      {t("roomBack", { amount: money(room.refundAmount) })}
                    </p>
                  )}
                  <p
                    className={
                      paidInFull ? "text-xs text-gray-500" : "text-sm font-semibold text-gray-900"
                    }
                  >
                    {t("roomKept", { amount: money(room.keptAmount) })}
                  </p>
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3">
        <p className="text-sm font-semibold text-gray-700">
          {paid ? t("backToCard") : t("hotelMayCharge")}
        </p>
        <p className={`text-sm font-bold ${!paid && fee > 0 ? "text-red-700" : "text-gray-900"}`}>
          {paid ? money(preview.refundAmount) : fee > 0 ? money(fee) : t("roomNoFee")}
        </p>
      </div>
    </div>
  );
}
