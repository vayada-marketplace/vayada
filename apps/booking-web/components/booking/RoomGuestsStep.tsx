"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { Link } from "@/i18n/navigation";
import { choiceKeys, choiceText } from "@/lib/roomChoices";
import { serverNow } from "@/lib/serverClock";
import { resolveLocale } from "@/lib/utils";
import { roomGuestProblem } from "@/lib/roomPicker";
import type { PricingRoom, RoomChoice } from "@/services/api/replacementOffers";

/** VAY-2320: the first /book step for rooms chosen on the hotel page (a group's, or since
 * VAY-2446 a room card's), while children's ages are still to give. Who sleeps where is set on
 * the hotel page (VAY-2393); here each room shows its guests and asks its children's ages, and
 * the quote prices every room for its own guests. */
export default function RoomGuestsStep({
  choices,
  rooms,
  quote,
  checkIn,
  timezone,
  childMaxAge,
  changeRoomsHref,
  formatMoney,
  onChange,
}: {
  choices: RoomChoice[];
  rooms: PricingRoom[];
  /** The current price, once every room's guests are complete; per-room amounts come from it. */
  quote: PublicBookingQuote | null;
  checkIn: string;
  timezone?: string;
  childMaxAge: number;
  changeRoomsHref: string;
  formatMoney: (minor: string, currency: string) => string;
  onChange: (selectionId: string, patch: Partial<RoomChoice>) => void;
}) {
  const t = useTranslations("groupRooms");
  const th = useTranslations("home");
  const tc = useTranslations("common");
  const locale = useLocale();
  // The server's clock, as the rest of checkout judges free cancellation's deadline (VAY-2392).
  const now = new Date(serverNow());
  return (
    <div className="space-y-4" data-testid="room-guests-step">
      <p className="text-gray-600">{t("intro")}</p>
      {choices.map((choice, index) => {
        const room = rooms.find((r) =>
          r.offers.some((o) => o.publicOfferKey === choice.publicOfferKey),
        );
        const offerIndex =
          room?.offers.findIndex((o) => o.publicOfferKey === choice.publicOfferKey) ?? -1;
        const rate =
          room && offerIndex >= 0
            ? choiceText(
                choiceKeys(room.offers, { checkIn, timezone }, now)[offerIndex]!,
                {
                  checkIn,
                  timezone,
                  formatDate: (date) =>
                    new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
                      day: "numeric",
                      month: "short",
                      timeZone: "UTC",
                    }),
                },
                th,
                now,
              )
            : null;
        const problem = roomGuestProblem(room, choice);
        const name = room?.name ?? t("roomLabel", { number: index + 1 });
        const limits = room?.occupancy;
        const amount = quote
          ? quote.lines
              .filter(
                (line) =>
                  line.selectionId === choice.selectionId &&
                  (line.kind === "room" || line.kind === "meal"),
              )
              .reduce((sum, line) => sum + BigInt(line.amountMinor), BigInt(0))
          : null;
        const adults = Number(choice.adults) || 0;
        return (
          <section
            key={choice.selectionId}
            aria-label={t("roomLabel", { number: index + 1 })}
            data-testid={`room-guests-${index + 1}`}
            className={`space-y-4 rounded-2xl bg-white p-5 ${problem ? "border-[1.5px] border-red-600" : "border border-gray-200"}`}
          >
            <div className="flex items-start gap-4">
              <div className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-xl bg-gray-100">
                {room?.images?.[0] && (
                  <Image
                    src={room.images[0].url}
                    alt=""
                    fill
                    className="object-cover"
                    sizes="56px"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary-600">
                  {t("roomLabel", { number: index + 1 })}
                </p>
                <p className="font-bold text-gray-900">{name}</p>
                {rate && (
                  <p className="text-sm text-gray-500">
                    {[rate.meal, rate.cancellationTerms].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              <div className="flex-shrink-0 text-right">
                <p className="font-bold text-gray-900">
                  {amount === null || !quote ? "—" : formatMoney(String(amount), quote.currency)}
                </p>
                {quote && (
                  <p className="text-xs text-gray-500">
                    {tc("nights", {
                      count: Math.round(
                        (Date.parse(quote.checkOut) - Date.parse(quote.checkIn)) / 86_400_000,
                      ),
                    })}
                  </p>
                )}
              </div>
            </div>
            <p className="border-t border-gray-100 pt-4 text-sm font-medium text-gray-800">
              {[
                tc("adults", { count: adults }),
                ...(choice.childAges.length
                  ? [tc("children", { count: choice.childAges.length })]
                  : []),
              ].join(", ")}
            </p>
            {choice.childAges.map((age, child) => (
              <label key={child} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-gray-700">{t("childAge", { number: child + 1 })}</span>
                <select
                  required
                  value={age}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900"
                  onChange={(event) =>
                    onChange(choice.selectionId, {
                      childAges: choice.childAges.map((value, position) =>
                        position === child ? event.target.value : value,
                      ),
                    })
                  }
                >
                  <option value="">{t("chooseAge")}</option>
                  {Array.from({ length: childMaxAge + 1 }, (_, value) => (
                    <option key={value} value={value}>
                      {value === 0 ? t("underOne") : value}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {limits && (
              <p className="text-sm text-gray-500">
                {t("sleepsUpTo", { count: limits.maxGuests })}
              </p>
            )}
            {problem && (
              <p role="alert" className="text-sm font-medium text-red-700">
                {problem === "no_adult"
                  ? t("needsAdult")
                  : problem === "too_many"
                    ? t("tooMany", { room: name, count: limits!.maxGuests })
                    : problem === "too_many_adults"
                      ? t("tooManyAdults", { room: name, count: limits!.maxAdults })
                      : problem === "no_children"
                        ? t("noChildren", { room: name })
                        : t("tooManyChildren", { room: name, count: limits!.maxChildren })}
              </p>
            )}
          </section>
        );
      })}
      <Link href={changeRoomsHref} className="inline-flex font-semibold text-primary-600">
        ‹ {t("changeRooms")}
      </Link>
    </div>
  );
}
