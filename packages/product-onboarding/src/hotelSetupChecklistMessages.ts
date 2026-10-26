import type {
  HotelSetupChecklistItemId,
  HotelSetupChecklistItemState,
  HotelSetupChecklistSetupStep,
} from "@vayada/domain-hotels";

/**
 * VAY-2247 wave 2: the checklist card's words (Paper rev 4 c01, c02). English by default; the dashboards
 * pass their own catalogs (PMS en/de, Booking Admin's ten languages).
 */
export type HotelSetupChecklistMessages = {
  setupTitle: string;
  setupSubtitle: (done: number, total: number) => string;
  continueSetup: string;
  next: string;
  setupSteps: Record<HotelSetupChecklistSetupStep, string>;
  liveTitle: (hotelName: string) => string;
  /** Under the title: the PMS says nothing stops bookings; Booking Admin that progress is shared. */
  liveSubtitle: Record<"pms" | "booking_admin", string>;
  doneCount: (done: number, total: number) => string;
  hideForNow: string;
  chip: (done: number, total: number) => string;
  completeTitle: string;
  completeSubtitle: string;
  dismiss: string;
  states: Record<Exclude<HotelSetupChecklistItemState, "done">, string>;
  /** Each item: its short name (the done chips) and its row. */
  items: Record<
    HotelSetupChecklistItemId,
    { name: string; title: string; description: (context: { roomCount: number | null }) => string }
  >;
  actions: Partial<Record<HotelSetupChecklistItemId, string>>;
  looksGood: string;
  review: string;
  confirmed: Partial<Record<HotelSetupChecklistItemId, string>>;
  failed: string;
};

export const HOTEL_SETUP_CHECKLIST_MESSAGES: HotelSetupChecklistMessages = {
  setupTitle: "Your booking page isn't live yet",
  setupSubtitle: (done, total) =>
    `You're ${done} of ${total} steps in. Everything you entered is saved.`,
  continueSetup: "Continue setup",
  next: "Next",
  setupSteps: {
    about_you: "Welcome",
    hotel: "Your hotel",
    first_room: "First room and price",
    guest_payment: "How guests pay",
    go_live: "Go live",
  },
  liveTitle: (hotelName) => `Finish setting up ${hotelName}`,
  liveSubtitle: {
    pms: "Your booking page is live. These make it better — none of them stop bookings.",
    booking_admin: "Same checklist in the PMS and Booking Admin. Progress is shared.",
  },
  doneCount: (done, total) => `${done} of ${total} done`,
  hideForNow: "Hide for now",
  chip: (done, total) => `Setup ${done} of ${total}`,
  completeTitle: "Setup complete — nice work",
  completeSubtitle: "Everything from setup now lives in Settings and Rooms & Rates.",
  dismiss: "Dismiss",
  states: { todo: "To do", default_in_use: "Default in use", later: "Later" },
  items: {
    hotel_basics: { name: "Hotel basics", title: "Hotel basics", description: () => "" },
    first_room: {
      name: "First room and price",
      title: "First room and price",
      description: () => "",
    },
    guest_payment: { name: "How guests pay", title: "How guests pay", description: () => "" },
    booking_published: {
      name: "Booking page published",
      title: "Booking page published",
      description: () => "",
    },
    photos: {
      name: "Photos",
      title: "Hotel and room photos",
      description: () =>
        "Guests see these first. Add beds and amenities while you're there. · opens PMS → Rooms & Rates (room photos) · Design Studio → Content (hotel photos)",
    },
    style: {
      name: "Logo and style",
      title: "Logo and booking page style",
      description: () =>
        "Classic blue is live now. Add your logo and pick colours. · opens Booking Admin → Design Studio",
    },
    calendar: {
      name: "Calendar",
      title: "Calendar",
      description: ({ roomCount }) =>
        `Open all year · ${roomCount ? `all ${roomCount} rooms` : "all rooms"} bookable · minimum 1 night · opens PMS → Settings → Auto-open future calendar (minimum stay in Rooms & Rates)`,
    },
    guest_terms: {
      name: "Guest terms",
      title: "Guest terms",
      description: () =>
        "Check-in 15:00 · check-out 11:00 · vayada standard terms · opens Booking Admin → Settings → Policies",
    },
    online_cards: {
      name: "Online card payments",
      title: "Online card payments",
      description: () =>
        "Connect Stripe so guests can pay when they book. · opens Booking Admin → Settings → Payments",
    },
  },
  actions: { photos: "Add photos", style: "Style", online_cards: "Connect" },
  looksGood: "Looks good",
  review: "Review",
  confirmed: {
    calendar: "Calendar confirmed — your defaults stay.",
    guest_terms: "Guest terms confirmed — your defaults stay.",
  },
  failed: "That didn't save. Try again in a moment.",
};
