import type { ComponentType } from "react";

export type FeatureProduct = "pms" | "booking_engine";

export type FeatureCategory = "Guest" | "Revenue";

export interface FeatureNavItem {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
}

/** Copy lives under `featureHub.modules.<id>.*`: name, description, detail and point.<n>. */
export interface FeatureModule {
  id: string;
  category: FeatureCategory;
  product: FeatureProduct;
  icon: ComponentType<{ className?: string }>;
  /** ISO date the module joined Feature Hub; it is marked NEW for 30 days after. */
  launchedOn?: string;
  /** Listed as currently unavailable: no switch, not counted as active. */
  unavailable?: boolean;
  navItem?: FeatureNavItem;
  /** Number of feature points in the detail window. */
  points: number;
  /** The detail window says what keeps running when the module is off (`offNote`). */
  offNote?: boolean;
}

export interface ModuleActivation {
  moduleId: string;
  isActive: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  updatedAt: string;
}

export interface ModuleActivationsResponse {
  hotelId: string;
  canManage: boolean;
  supportedModules: string[];
  activeModules: string[];
  activations: ModuleActivation[];
  /** Modules this caller may switch when it differs per module; canManage covers all otherwise. */
  manageableModules?: string[];
}

export interface FeatureActivationClient {
  list: () => Promise<ModuleActivationsResponse>;
  update: (moduleId: string, isActive: boolean) => Promise<ModuleActivation>;
}

export interface CoreNavItem {
  label: string;
  href: string;
}
