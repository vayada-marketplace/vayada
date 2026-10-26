import { PMS_WEB_PROPERTY_ID } from "./pmsWebMocks";

/** Settings → Check-in defaults, as the API answers before a property saves (VAY-2374). */
export const defaultCheckinSettings = {
  showSpecialRequest: true,
  confirmSpecialRequest: true,
  allowRoomChanges: true,
  allowIncompleteGuests: true,
  guestNotes: true,
  registrationScope: "adults",
  guestFields: [
    { field: "email", show: true, required: false },
    { field: "phone", show: true, required: false },
    { field: "documentType", show: true, required: true },
    { field: "documentNumber", show: true, required: true },
    { field: "nationality", show: true, required: true },
    { field: "dateOfBirth", show: true, required: true },
    { field: "gender", show: false, required: false },
  ],
  offerAddons: true,
  addonIds: null as string[] | null,
  settlementOptions: ["card", "cash", "bank_transfer", "at_checkout", "already_paid"],
  paymentChoiceRequired: true,
  keyHandover: "physical",
};

export function checkinSettingsResponse(
  settings: Partial<typeof defaultCheckinSettings> = {},
  { canManage = true, updatedAt = null as string | null } = {},
) {
  return {
    propertyId: PMS_WEB_PROPERTY_ID,
    canManage,
    settings: { ...defaultCheckinSettings, ...settings },
    updatedAt,
  };
}
