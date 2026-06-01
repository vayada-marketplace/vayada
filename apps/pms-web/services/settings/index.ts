import { apiClient } from "../api/client";
import { pmsClient } from "../api/pmsClient";

export interface PmsSetupStatus {
  registered: boolean;
  setupComplete: boolean;
  roomCount: number;
}

export interface HotelSummary {
  id: string;
  name: string;
  slug: string;
  location: string;
  country: string;
}

export interface HotelDetails extends HotelSummary {
  timezone: string;
}

// Slice of the booking-engine PropertySettings the PMS reads/writes —
// shared with BE Admin so the currency selector hits the same field.
export interface PropertySettings {
  default_currency: string;
}

export type PropertySettingsUpdate = Partial<PropertySettings>;

export type CheckinStepType = "checkbox" | "text" | "amount";
export type CheckinChecklistStepType = CheckinStepType;

export interface CheckinChecklistStep {
  id: string;
  label: string;
  prompt?: string;
  type: CheckinChecklistStepType;
  required: boolean;
  system?: boolean;
  position: number;
}

export interface CheckinChecklistTemplate {
  steps: CheckinChecklistStep[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CheckoutInspectionStep {
  id: string;
  label: string;
  okLabel: string;
  negativeLabel: string;
  notePrompt: string;
  required: boolean;
  position: number;
}

export interface CheckoutInspectionTemplate {
  steps: CheckoutInspectionStep[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export const pmsSettingsService = {
  getSetupStatus: () => pmsClient.get<PmsSetupStatus>("/admin/setup-status"),

  listHotels: () => apiClient.get<HotelSummary[]>("/admin/hotels"),

  getHotelDetails: () => pmsClient.get<HotelDetails>("/admin/hotel"),
};

export const settingsService = {
  getPropertySettings: () => apiClient.get<PropertySettings>("/admin/settings/property"),

  updatePropertySettings: (data: PropertySettingsUpdate) =>
    apiClient.patch<PropertySettings>("/admin/settings/property", data),

  getCheckinChecklist: () => pmsClient.get<CheckinChecklistTemplate>("/admin/check-in-checklist"),

  updateCheckinChecklist: (steps: CheckinChecklistStep[]) =>
    pmsClient.put<CheckinChecklistTemplate>("/admin/check-in-checklist", { steps }),

  getCheckoutInspection: () =>
    pmsClient.get<CheckoutInspectionTemplate>("/admin/check-out-inspection"),

  updateCheckoutInspection: (steps: CheckoutInspectionStep[]) =>
    pmsClient.put<CheckoutInspectionTemplate>("/admin/check-out-inspection", { steps }),
};
