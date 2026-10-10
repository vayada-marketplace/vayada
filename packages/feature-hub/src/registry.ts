import {
  BanknotesIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentCheckIcon,
  EnvelopeIcon,
  SparklesIcon,
  StarIcon,
} from "@heroicons/react/24/outline";
import type { CoreNavItem, FeatureCategory, FeatureModule, FeatureProduct } from "./types";

export const FEATURE_CATEGORIES: Array<"All" | FeatureCategory> = [
  "All",
  "Distribution",
  "Operations",
];

// Order matches the PMS sidebar: Inbox, Reviews, Financials after Reservations.
export const FEATURE_MODULES: FeatureModule[] = [
  {
    id: "inbox",
    name: "Inbox",
    description:
      "Guest messaging, automations, and templates. Chat with guests and automate pre-arrival and post-stay messages.",
    category: "Operations",
    type: "internal",
    product: "pms",
    icon: "chat",
    navItem: { label: "Inbox", href: "/inbox", icon: ChatBubbleLeftRightIcon },
    detail: {
      headline: "Keep every guest conversation in one place.",
      visualType: "inbox",
      features: [
        {
          icon: ChatBubbleLeftRightIcon,
          text: "Reply to guests from connected channels and email.",
        },
        { icon: EnvelopeIcon, text: "Save quick replies for common questions." },
        { icon: SparklesIcon, text: "See unread conversations at a glance." },
      ],
    },
  },
  {
    id: "reviews",
    name: "Reviews",
    description: "View and manage guest reviews from connected channels.",
    category: "Distribution",
    type: "internal",
    product: "pms",
    icon: "star",
    navItem: { label: "Reviews", href: "/reviews", icon: StarIcon },
    detail: {
      headline: "See what guests say about your stay.",
      visualType: "reviews",
      features: [
        { icon: StarIcon, text: "Read reviews from your connected channels in one list." },
        { icon: ChatBubbleLeftRightIcon, text: "Reply to reviews where the channel allows it." },
        { icon: EnvelopeIcon, text: "Collect reviews from direct guests after their stay." },
      ],
    },
  },
  {
    id: "financials",
    name: "Financials",
    description: "Revenue, expenses, profit and loss, and operational folios for your property.",
    category: "Operations",
    type: "internal",
    product: "pms",
    icon: "chart",
    navItem: { label: "Financials", href: "/financials", icon: ChartBarIcon },
    detail: {
      headline: "Review your property's finances in one place.",
      visualType: "financials",
      features: [
        { icon: ChartBarIcon, text: "Reconcile stay revenue and channel attribution." },
        { icon: BanknotesIcon, text: "Track manual and generated expenses." },
        { icon: ClipboardDocumentCheckIcon, text: "Export reports and operational folios." },
      ],
    },
  },
];

export const CORE_NAV_ITEMS: Record<FeatureProduct, CoreNavItem[]> = {
  pms: [
    { label: "Dashboard", href: "/dashboard" },
    { label: "Calendar", href: "/calendar" },
    { label: "Reservations", href: "/bookings" },
    { label: "Rooms & Rates", href: "/rooms" },
    { label: "Channel Manager", href: "/channel-manager" },
    { label: "Settings", href: "/settings" },
  ],
  booking_engine: [
    { label: "Dashboard", href: "/" },
    { label: "Design Studio", href: "/design-studio" },
    { label: "Booking Flow", href: "/booking-flow" },
    { label: "Promo Codes", href: "/promo-codes" },
    { label: "Settings", href: "/settings" },
  ],
};

// PMS modules (Inbox, Reviews, Financials) sit right after Reservations, as in the sidebar.
export const FEATURE_MODULE_NAV_INDEX: Record<FeatureProduct, number> = {
  pms: 3,
  booking_engine: 3,
};

export function modulesForProduct(product: FeatureProduct): FeatureModule[] {
  return FEATURE_MODULES.filter((module) => module.product === product);
}

export function activeNavModules(product: FeatureProduct, activeModuleIds: string[]) {
  const active = new Set(activeModuleIds);
  return FEATURE_MODULES.filter(
    (module) => module.product === product && module.navItem && active.has(module.id),
  );
}

export function activeModuleCount(product: FeatureProduct, activeModuleIds: string[]): number {
  const active = new Set(activeModuleIds);
  return FEATURE_MODULES.filter((module) => module.product === product && active.has(module.id))
    .length;
}
