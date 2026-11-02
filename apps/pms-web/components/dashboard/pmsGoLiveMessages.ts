import type { GoLiveChecklistMessages } from "@vayada/product-onboarding/GoLiveChecklistCard";
import { GO_LIVE_CHECKLIST_MESSAGES } from "@vayada/product-onboarding/GoLiveChecklistCard";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * VAY-2451: the go-live dashboard cards' words from the PMS catalogs. No plural rules there:
 * a counted word has a ".one" and an ".other" text, picked here as the English default does.
 */
export function pmsGoLiveMessages(t: Translate): GoLiveChecklistMessages {
  const { steps } = GO_LIVE_CHECKLIST_MESSAGES;
  return {
    // Before the hotel's name answers there is none to show.
    setupTitle: (hotel) =>
      hotel.trim()
        ? t("dashboard.goLive.setupTitle", { hotel })
        : t("dashboard.goLive.setupTitleUnnamed"),
    setupNext: (step, minutes) =>
      minutes === 1
        ? t("dashboard.goLive.setupNext.one", { minutes, step })
        : t("dashboard.goLive.setupNext.other", { minutes, step }),
    continueSetup: t("dashboard.goLive.continueSetup"),
    steps: {
      property: { ...steps.property, label: t("dashboard.goLive.step.property") },
      location: { ...steps.location, label: t("dashboard.goLive.step.location") },
      room: { ...steps.room, label: t("dashboard.goLive.step.room") },
      payments: { ...steps.payments, label: t("dashboard.goLive.step.payments") },
    },
    stepDone: t("dashboard.goLive.stepDone"),
    stepNext: (minutes) => t("dashboard.goLive.stepNext", { minutes }),
    stepTime: (minutes) => t("dashboard.goLive.stepTime", { minutes }),
    goLiveTitle: t("dashboard.goLive.goLiveTitle"),
    liveTitle: t("dashboard.goLive.liveTitle"),
    goLiveSubtitle: t("dashboard.goLive.goLiveSubtitle"),
    liveSubtitle: t("dashboard.goLive.liveSubtitle"),
    doneCount: (done, total) => t("dashboard.goLive.doneCount", { done, total }),
    required: t("dashboard.goLive.required"),
    recommended: t("dashboard.goLive.recommended"),
    edit: t("dashboard.goLive.edit"),
    items: {
      property_details: {
        title: t("dashboard.goLive.item.propertyDetails.title"),
        description: t("dashboard.goLive.item.propertyDetails.description"),
        action: t("dashboard.goLive.item.propertyDetails.action"),
      },
      room_types: {
        title: t("dashboard.goLive.item.roomTypes.title"),
        doneTitle: t("dashboard.goLive.item.roomTypes.doneTitle"),
        description: t("dashboard.goLive.item.roomTypes.description"),
        action: t("dashboard.goLive.item.roomTypes.action"),
      },
      rates: {
        title: t("dashboard.goLive.item.rates.title"),
        description: t("dashboard.goLive.item.rates.description"),
        action: t("dashboard.goLive.item.rates.action"),
      },
      booking_rules: {
        title: t("dashboard.goLive.item.bookingRules.title"),
        description: t("dashboard.goLive.item.bookingRules.description"),
        doneDescription: t("dashboard.goLive.item.bookingRules.doneDescription"),
        action: t("dashboard.goLive.item.bookingRules.action"),
      },
      property_photos: {
        title: t("dashboard.goLive.item.propertyPhotos.title"),
        description: t("dashboard.goLive.item.propertyPhotos.description"),
        action: t("dashboard.goLive.item.propertyPhotos.action"),
      },
    },
    // The room's name goes in last, so a name with braces in it is never filled in.
    roomTypesDone: (room) =>
      t("dashboard.goLive.roomTypesDone", {
        rooms:
          room.rooms === 1
            ? t("dashboard.goLive.rooms.one", { count: room.rooms })
            : t("dashboard.goLive.rooms.other", { count: room.rooms }),
        guests: room.maxGuests,
        photos:
          room.photos === 1
            ? t("dashboard.goLive.photos.one", { count: room.photos })
            : t("dashboard.goLive.photos.other", { count: room.photos }),
        name: room.name,
      }),
    ratesPlaceholder: t("dashboard.goLive.ratesPlaceholder"),
    publishTitle: t("dashboard.goLive.publishTitle"),
    publishLocked: t("dashboard.goLive.publishLocked"),
    publishReady: t("dashboard.goLive.publishReady"),
    publishLive: t("dashboard.goLive.publishLive"),
    publish: t("dashboard.goLive.publish"),
    live: t("dashboard.goLive.live"),
    laterTitle: t("dashboard.goLive.laterTitle"),
    onlineCardsTitle: t("dashboard.goLive.onlineCardsTitle"),
    onlineCardsDescription: t("dashboard.goLive.onlineCardsDescription"),
    connect: t("dashboard.goLive.connect"),
    channelManagerTitle: t("dashboard.goLive.channelManagerTitle"),
    channelManagerDescription: t("dashboard.goLive.channelManagerDescription"),
    soon: t("dashboard.goLive.soon"),
    toast: t("dashboard.goLive.toast"),
    dismiss: t("dashboard.goLive.dismiss"),
  };
}
