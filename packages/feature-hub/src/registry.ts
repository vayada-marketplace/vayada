import {
  BanknotesIcon,
  ChatBubbleLeftRightIcon,
  CubeIcon,
  StarIcon,
  TicketIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { CoreNavItem, FeatureModule, FeatureProduct } from "./types";

/** NEW marks a module for this long after it joins Feature Hub (VAY-2200). */
const NEW_FOR_MS = 30 * 24 * 60 * 60 * 1000;

// Grid order. PMS modules keep the sidebar order: Guests, Inbox, Reviews, Financials after
// Reservations.
export const FEATURE_MODULES: FeatureModule[] = [
  {
    id: "guests",
    category: "Guest",
    product: "pms",
    icon: UsersIcon,
    launchedOn: "2026-10-30",
    navItem: { label: "Guests", href: "/guests", icon: UsersIcon },
    points: 3,
    offNote: true,
  },
  {
    id: "inbox",
    category: "Guest",
    product: "pms",
    icon: ChatBubbleLeftRightIcon,
    launchedOn: "2026-10-10",
    navItem: { label: "Inbox", href: "/inbox", icon: ChatBubbleLeftRightIcon },
    points: 4,
  },
  {
    id: "reviews",
    category: "Guest",
    product: "pms",
    icon: StarIcon,
    launchedOn: "2026-10-10",
    navItem: { label: "Reviews", href: "/reviews", icon: StarIcon },
    points: 3,
  },
  {
    id: "financials",
    category: "Revenue",
    product: "pms",
    icon: BanknotesIcon,
    navItem: { label: "Financials", href: "/financials", icon: BanknotesIcon },
    points: 3,
  },
  {
    id: "add-ons",
    category: "Revenue",
    product: "booking_engine",
    icon: CubeIcon,
    navItem: { label: "Add-ons", href: "/add-ons", icon: CubeIcon },
    points: 3,
  },
  {
    id: "promos",
    category: "Revenue",
    product: "booking_engine",
    icon: TicketIcon,
    navItem: { label: "Promos", href: "/promo-codes", icon: TicketIcon },
    points: 3,
    offNote: true,
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
    { label: "Settings", href: "/settings" },
  ],
};

// Module items sit after Reservations in the PMS and after Design Studio in the Booking Engine.
export const FEATURE_MODULE_NAV_INDEX: Record<FeatureProduct, number> = {
  pms: 3,
  booking_engine: 2,
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

/** A sidebar keeps a module's item unless its store says it is off, so a slow or failed read
 * never hides a page. */
export function visibleNavModules(
  product: FeatureProduct,
  activeModuleIds: readonly string[],
  supportedModuleIds: readonly string[],
) {
  const active = new Set(activeModuleIds);
  const supported = new Set(supportedModuleIds);
  return FEATURE_MODULES.filter(
    (module) =>
      module.product === product &&
      module.navItem &&
      (!supported.has(module.id) || active.has(module.id)),
  );
}

export function isModuleNew(module: FeatureModule, now: Date = new Date()): boolean {
  if (!module.launchedOn) return false;
  const launched = Date.parse(`${module.launchedOn}T00:00:00Z`);
  return now.getTime() >= launched && now.getTime() < launched + NEW_FOR_MS;
}
