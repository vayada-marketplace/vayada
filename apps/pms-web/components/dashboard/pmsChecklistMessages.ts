import type { HotelSetupChecklistMessages } from "@vayada/product-onboarding/hotelSetupChecklistMessages";
import { HOTEL_SETUP_CHECKLIST_MESSAGES } from "@vayada/product-onboarding/hotelSetupChecklistMessages";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** VAY-2247 wave 2: the setup checklist card's words from the PMS catalogs (en, de; others fall back to en). */
export function pmsChecklistMessages(t: Translate): HotelSetupChecklistMessages {
  const item = (name: string, title = name, description = "") => ({
    name,
    title,
    description: () => description,
  });
  return {
    setupTitle: t("dashboard.checklist.setupTitle"),
    setupSubtitle: (done, total) => t("dashboard.checklist.setupSubtitle", { done, total }),
    continueSetup: t("dashboard.checklist.continueSetup"),
    next: t("dashboard.checklist.next"),
    setupSteps: {
      about_you: t("dashboard.checklist.step.aboutYou"),
      hotel: t("dashboard.checklist.step.hotel"),
      first_room: t("dashboard.checklist.step.firstRoom"),
      guest_payment: t("dashboard.checklist.step.guestPayment"),
      go_live: t("dashboard.checklist.step.goLive"),
    },
    liveTitle: (hotel) => t("dashboard.checklist.liveTitle", { hotel }),
    // The PMS shows only its own line; Booking Admin keeps the shared default.
    liveSubtitle: {
      pms: t("dashboard.checklist.liveSubtitle"),
      booking_admin: HOTEL_SETUP_CHECKLIST_MESSAGES.liveSubtitle.booking_admin,
    },
    doneCount: (done, total) => t("dashboard.checklist.doneCount", { done, total }),
    hideForNow: t("dashboard.checklist.hideForNow"),
    chip: (done, total) => t("dashboard.checklist.chip", { done, total }),
    completeTitle: t("dashboard.checklist.completeTitle"),
    completeSubtitle: t("dashboard.checklist.completeSubtitle"),
    dismiss: t("dashboard.checklist.dismiss"),
    states: {
      todo: t("dashboard.checklist.state.todo"),
      default_in_use: t("dashboard.checklist.state.defaultInUse"),
      later: t("dashboard.checklist.state.later"),
    },
    items: {
      hotel_basics: item(t("dashboard.checklist.item.hotelBasics")),
      first_room: item(t("dashboard.checklist.item.firstRoom")),
      guest_payment: item(t("dashboard.checklist.item.guestPayment")),
      booking_published: item(t("dashboard.checklist.item.bookingPublished")),
      photos: item(
        t("dashboard.checklist.item.photos"),
        t("dashboard.checklist.item.photosTitle"),
        t("dashboard.checklist.item.photosDescription"),
      ),
      style: item(
        t("dashboard.checklist.item.style"),
        t("dashboard.checklist.item.styleTitle"),
        t("dashboard.checklist.item.styleDescription"),
      ),
      calendar: {
        name: t("dashboard.checklist.item.calendar"),
        title: t("dashboard.checklist.item.calendar"),
        description: ({ roomCount }) =>
          t("dashboard.checklist.item.calendarDescription", {
            rooms: roomCount
              ? t("dashboard.checklist.item.calendarRooms", { count: roomCount })
              : t("dashboard.checklist.item.calendarAllRooms"),
          }),
      },
      guest_terms: item(
        t("dashboard.checklist.item.guestTerms"),
        t("dashboard.checklist.item.guestTerms"),
        t("dashboard.checklist.item.guestTermsDescription"),
      ),
      online_cards: item(
        t("dashboard.checklist.item.onlineCards"),
        t("dashboard.checklist.item.onlineCards"),
        t("dashboard.checklist.item.onlineCardsDescription"),
      ),
    },
    actions: {
      photos: t("dashboard.checklist.action.photos"),
      style: t("dashboard.checklist.action.style"),
      online_cards: t("dashboard.checklist.action.onlineCards"),
    },
    looksGood: t("dashboard.checklist.looksGood"),
    review: t("dashboard.checklist.review"),
    confirmed: {
      calendar: t("dashboard.checklist.confirmed.calendar"),
      guest_terms: t("dashboard.checklist.confirmed.guestTerms"),
    },
    failed: t("dashboard.checklist.failed"),
  };
}
