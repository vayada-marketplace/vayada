import type {
  CheckinGuestField,
  CheckinSettings,
  CheckinSettlementOption,
} from "@/services/settings";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Guest-form order, after first and last name (always shown and required). */
export const CHECKIN_GUEST_FIELDS: CheckinGuestField[] = [
  "email",
  "phone",
  "documentType",
  "documentNumber",
  "nationality",
  "dateOfBirth",
  "gender",
];

/** The approved defaults (VAY-2374), the same as the API's; used when the settings can't be read. */
export const DEFAULT_CHECKIN_SETTINGS: CheckinSettings = {
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
  addonIds: null,
  settlementOptions: ["card", "cash", "bank_transfer", "at_checkout", "already_paid"],
  paymentChoiceRequired: true,
  keyHandover: "physical",
};

export const CHECKIN_SETTLEMENT_OPTIONS: CheckinSettlementOption[] = [
  "card",
  "cash",
  "bank_transfer",
  "at_checkout",
  "already_paid",
];

export function guestFieldLabel(field: CheckinGuestField, t: Translate): string {
  return t(`settings.checkIn.field.${field}`);
}

export function settlementOptionLabel(option: CheckinSettlementOption, t: Translate): string {
  return t(`settings.checkIn.settlement.${option}`);
}

/** Turning "Show" off also turns "Required" off; "Required" on also shows the field. */
export function setGuestField(
  settings: CheckinSettings,
  field: CheckinGuestField,
  patch: { show?: boolean; required?: boolean },
): CheckinSettings {
  return {
    ...settings,
    guestFields: settings.guestFields.map((entry) => {
      if (entry.field !== field) return entry;
      const show = patch.required ? true : (patch.show ?? entry.show);
      const required = show ? (patch.required ?? entry.required) : false;
      return { field, show, required };
    }),
  };
}

/** Required / optional / hidden counts, first and last name included as required. */
export function guestFieldCounts(settings: CheckinSettings) {
  const required = settings.guestFields.filter((entry) => entry.required).length + 2;
  const hidden = settings.guestFields.filter((entry) => !entry.show).length;
  return { required, optional: settings.guestFields.length + 2 - required - hidden, hidden };
}

/** The one-line summaries in the flow overview, one per step. */
export function checkinStepSummaries(
  settings: CheckinSettings,
  addonCount: number,
  extraCheckCount: number,
  t: Translate,
): [string, string, string, string] {
  const arrival = !settings.showSpecialRequest
    ? t("settings.checkIn.summary.noRequest")
    : settings.confirmSpecialRequest
      ? t("settings.checkIn.summary.requestConfirmed")
      : t("settings.checkIn.summary.requestShown");
  const rooms = t("settings.checkIn.summary.requiredFields", {
    count: guestFieldCounts(settings).required,
  });
  const addons = settings.offerAddons
    ? t("settings.checkIn.summary.addonsOffered", { count: addonCount })
    : t("settings.checkIn.summary.addonsOff");
  const keys = t(
    settings.keyHandover === "physical"
      ? "settings.checkIn.summary.physicalKeys"
      : "settings.checkIn.summary.noKeys",
    { count: extraCheckCount },
  );
  return [arrival, rooms, addons, keys];
}
