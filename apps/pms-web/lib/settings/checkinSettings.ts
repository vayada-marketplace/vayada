import type {
  CheckinGuestField,
  CheckinSettings,
  CheckinSettlementOption,
} from "@/services/settings";
import type { GuestDataSettings } from "@/services/guests";

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

/** Settings › Guest data as an account has it until the owner changes it (the API's defaults). */
export const DEFAULT_GUEST_DATA_FIELDS: GuestDataSettings["fields"] = {
  email: "optional",
  phone: "optional",
  nationality: "required",
  dateOfBirth: "required",
  documentType: "required",
  documentNumber: "required",
};

/**
 * Settings › Guest data over the check-in's own fields (VAY-2420): a field set to Off isn't asked,
 * and Required or Optional takes the place of the check-in's Required switch. The check-in's Show
 * switch still decides whether the form asks at all; gender is the check-in's own.
 */
export function withGuestDataFields(
  settings: CheckinSettings,
  fields: GuestDataSettings["fields"] = DEFAULT_GUEST_DATA_FIELDS,
): CheckinSettings {
  return {
    ...settings,
    guestFields: settings.guestFields.map((entry) => {
      if (entry.field === "gender") return entry;
      const status = fields[entry.field];
      const show = entry.show && status !== "off";
      return { ...entry, show, required: show && status === "required" };
    }),
  };
}

/** Email and phone apply to the lead guest: the other guests may give them, but never must. */
export function forAdditionalGuests<Settings extends Pick<CheckinSettings, "guestFields">>(
  settings: Settings,
): Settings {
  return {
    ...settings,
    guestFields: settings.guestFields.map((entry) =>
      entry.field === "email" || entry.field === "phone" ? { ...entry, required: false } : entry,
    ),
  };
}

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
