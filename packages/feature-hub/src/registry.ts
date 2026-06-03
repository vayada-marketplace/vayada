import {
  ArrowPathIcon,
  BanknotesIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentCheckIcon,
  CreditCardIcon,
  EnvelopeIcon,
  LinkIcon,
  MegaphoneIcon,
  PresentationChartLineIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";

import type { CoreNavItem, FeatureCategory, FeatureModule, FeatureProduct } from "./types";

export const FEATURE_CATEGORIES: Array<"All" | FeatureCategory> = [
  "All",
  "Distribution",
  "Guest Experience",
  "Operations",
  "Payments",
  "PMS Integrations",
];

export const FEATURE_MODULES: FeatureModule[] = [
  {
    id: "inbox",
    name: "Inbox",
    description:
      "Centralised inbox for all channels with automated pre-arrival and post-stay emails.",
    category: "Guest Experience",
    type: "internal",
    product: "pms",
    icon: "chat",
    isNew: true,
    navItem: { label: "Inbox", href: "/inbox" },
    detail: {
      headline: "Keep every guest conversation in one calm, searchable queue.",
      visualType: "inbox",
      features: [
        { icon: ChatBubbleLeftRightIcon, text: "Unify Booking.com, Airbnb, and email threads." },
        { icon: SparklesIcon, text: "Automate arrival and post-stay messages." },
        { icon: ShieldCheckIcon, text: "Protect response quality with unread indicators." },
        { icon: EnvelopeIcon, text: "Reply with property context already attached." },
      ],
    },
  },
  {
    id: "financials",
    name: "Financials",
    description: "Revenue, occupancy, ADR, and RevPAR reports, export-ready for accounting.",
    category: "Operations",
    type: "internal",
    product: "pms",
    icon: "chart",
    navItem: { label: "Financials", href: "/financials" },
    detail: {
      headline: "Turn bookings into a clean operating picture your accountant can trust.",
      visualType: "financials",
      features: [
        { icon: ChartBarIcon, text: "Track RevPAR, ADR, occupancy, and revenue deltas." },
        { icon: PresentationChartLineIcon, text: "Compare month-by-month performance trends." },
        { icon: ClipboardDocumentCheckIcon, text: "Export reports for accounting workflows." },
        { icon: BanknotesIcon, text: "Keep payment and invoice context together." },
      ],
    },
  },
  {
    id: "affiliates",
    name: "Affiliates",
    description: "Let partners earn commission on the bookings they refer to you.",
    category: "Distribution",
    type: "internal",
    product: "booking_engine",
    icon: "users",
    isNew: true,
    navItem: { label: "Affiliates", href: "/affiliates" },
    detail: {
      headline: "Open a partner channel without adding manual commission tracking.",
      visualType: "affiliates",
      features: [
        { icon: UserGroupIcon, text: "Invite partners and track their referral activity." },
        { icon: MegaphoneIcon, text: "See clicks, bookings, revenue, and commission earned." },
        { icon: LinkIcon, text: "Issue partner links tied to your booking engine." },
        { icon: BanknotesIcon, text: "Prepare payout-ready commission records." },
      ],
    },
  },
  {
    id: "lodgify",
    name: "Lodgify",
    description: "Sync your property with Lodgify PMS.",
    category: "PMS Integrations",
    type: "external",
    product: "booking_engine",
    icon: "lodgify",
    settingsNote: "Configured in Settings -> PMS integrations.",
    detail: {
      headline: "Connect Lodgify inventory so Vayada can stay aligned with your PMS.",
      visualType: "lodgify",
      features: [
        { icon: ArrowPathIcon, text: "Prepare sync between Lodgify property data and Vayada." },
        { icon: ClipboardDocumentCheckIcon, text: "Keep room and rate setup ready for mapping." },
        { icon: ShieldCheckIcon, text: "Control when the integration becomes available." },
        { icon: LinkIcon, text: "Expose configuration only after activation." },
      ],
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Accept card payments online with automatic payouts.",
    category: "Payments",
    type: "external",
    product: "booking_engine",
    icon: "stripe",
    settingsNote: "Configured in Settings -> Payments.",
    detail: {
      headline: "Give guests a polished card checkout while payouts stay organized.",
      visualType: "stripe",
      features: [
        { icon: CreditCardIcon, text: "Enable card payment setup for direct bookings." },
        { icon: ShieldCheckIcon, text: "Keep onboarding and compliance in Stripe Connect." },
        { icon: BanknotesIcon, text: "Use automatic payout tracking after configuration." },
        { icon: ClipboardDocumentCheckIcon, text: "Expose card payment controls in Settings." },
      ],
    },
  },
  {
    id: "paypal",
    name: "PayPal",
    description: "Accept PayPal payments from guests.",
    category: "Payments",
    type: "external",
    product: "booking_engine",
    icon: "paypal",
    settingsNote: "Configured in Settings -> Payments.",
    detail: {
      headline: "Add a familiar guest payment option for markets that prefer PayPal.",
      visualType: "paypal",
      features: [
        { icon: CreditCardIcon, text: "Make PayPal available as a guest payment method." },
        { icon: EnvelopeIcon, text: "Capture the receiving PayPal account in Settings." },
        { icon: ShieldCheckIcon, text: "Keep existing bookings unaffected if disabled." },
        { icon: BanknotesIcon, text: "Support manual payment confirmation workflows." },
      ],
    },
  },
  {
    id: "xendit",
    name: "Xendit",
    description: "Accept Indonesian bank transfers and e-wallets.",
    category: "Payments",
    type: "external",
    product: "booking_engine",
    icon: "xendit",
    settingsNote: "Configured in Settings -> Payments.",
    detail: {
      headline: "Serve Indonesian guests with localized payment rails.",
      visualType: "xendit",
      features: [
        { icon: BanknotesIcon, text: "Prepare Indonesian bank and wallet payment setup." },
        { icon: ShieldCheckIcon, text: "Keep provider credentials behind Settings." },
        { icon: ArrowPathIcon, text: "Support settlement-aware booking payment states." },
        { icon: CreditCardIcon, text: "Enable Xendit controls only when the module is active." },
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
    { label: "Settings", href: "/settings" },
  ],
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
