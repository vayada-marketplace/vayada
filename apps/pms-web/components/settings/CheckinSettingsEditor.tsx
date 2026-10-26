"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckIcon, LockClosedIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  type CheckinChecklistStep,
  type CheckinChecklistStepType,
  type CheckinSettings,
  type CheckinSettlementOption,
  settingsService,
} from "@/services/settings";
import { calendarService } from "@/services/calendar";
import type { BookingAddon } from "@/services/bookings";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { usePmsAccess } from "@/lib/settings/PmsAccessContext";
import {
  CHECKIN_SETTLEMENT_OPTIONS,
  checkinStepSummaries,
  guestFieldCounts,
  guestFieldLabel,
  setGuestField,
  settlementOptionLabel,
} from "@/lib/settings/checkinSettings";
import { openBookingAdmin } from "@/lib/utils/bookingAdminLink";
import { SettingsFeedback } from "./SettingsFeedback";
import { SettingsSubPage } from "./SettingsSubPage";
import { humanizeApiError } from "./constants";
import { useScrollToHash } from "./useScrollToHash";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const SECTION_IDS = ["arrival", "rooms-and-guests", "add-ons-and-payment", "keys-and-check-in"];

function newCheck(position: number): CheckinChecklistStep {
  return {
    id: globalThis.crypto.randomUUID(),
    label: "",
    prompt: "",
    type: "checkbox",
    required: false,
    system: false,
    position,
  };
}

function addonUnit(addon: BookingAddon, t: Translate): string {
  if (addon.perPerson && addon.perNight) return t("settings.checkIn.addonUnit.guestNight");
  if (addon.perPerson) return t("settings.checkIn.addonUnit.guest");
  if (addon.perNight) return t("settings.checkIn.addonUnit.night");
  return t("settings.checkIn.addonUnit.stay");
}

/** Settings → Check-in (VAY-2374): how the 4-step check-in runs at this property. */
export function CheckinSettingsEditor() {
  const { t } = useTranslation();
  useScrollToHash();
  const [settings, setSettings] = useState<CheckinSettings | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [catalog, setCatalog] = useState<BookingAddon[]>([]);
  const [checks, setChecks] = useState<CheckinChecklistStep[]>([]);
  const [savedChecks, setSavedChecks] = useState<CheckinChecklistStep[]>([]);
  const { permissions } = usePmsAccess();
  // The extra checks are the check-in checklist, which takes operations access to change.
  const canEditChecks = canManage && permissions.includes("pms.operations.manage");
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      settingsService.getCheckinSettings(),
      settingsService.getCheckinChecklist(),
      calendarService.listAvailableAddons("").catch(() => [] as BookingAddon[]),
    ])
      .then(([response, checklist, addons]) => {
        setSettings(response.settings);
        setCanManage(response.canManage);
        setChecks(checklist.steps || []);
        setSavedChecks(checklist.steps || []);
        setCatalog(addons);
      })
      .catch((err) =>
        setLoadError(
          localizedErrorText(err, humanizeApiError(err, t("settings.checkIn.loadError")), t),
        ),
      );
  }, [t]);

  // Add-ons sold at check-in: null means every active add-on.
  const soldAddons = useMemo(() => {
    if (!settings) return [];
    if (settings.addonIds === null) return catalog;
    return settings.addonIds
      .map((id) => catalog.find((addon) => addon.id === id))
      .filter((addon): addon is BookingAddon => Boolean(addon));
  }, [catalog, settings]);

  const update = (next: CheckinSettings) => {
    setSuccess("");
    setSettings(next);
  };

  const save = async () => {
    if (!settings) return;
    const errors: Record<string, string> = {};
    for (const check of checks)
      if (!check.label.trim()) errors[check.id] = t("settings.checkIn.checkLabelRequired");
    setCheckErrors(errors);
    setError("");
    setSuccess("");
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    const ordered = (list: CheckinChecklistStep[]) =>
      list.map((check, position) => ({ ...check, label: check.label.trim(), position }));
    try {
      // The checks first, and only when they changed: if they are refused, nothing has changed.
      // Both writes replace a whole object, so saving again after a failure is safe.
      if (
        canEditChecks &&
        JSON.stringify(ordered(checks)) !== JSON.stringify(ordered(savedChecks))
      ) {
        const checklist = await settingsService.updateCheckinChecklist(ordered(checks));
        setChecks(checklist.steps || []);
        setSavedChecks(checklist.steps || []);
      }
      const saved = await settingsService.updateCheckinSettings(settings);
      setSettings(saved.settings);
      setSuccess(t("settings.checkIn.saved"));
    } catch (err) {
      setError(localizedErrorText(err, humanizeApiError(err, t("settings.checkIn.saveError")), t));
    } finally {
      setSaving(false);
    }
  };

  const actions = canManage ? (
    <button
      type="button"
      onClick={() => void save()}
      disabled={!settings || saving}
      className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
    >
      {saving ? t("common.saving") : t("settings.checkIn.save")}
    </button>
  ) : undefined;

  return (
    <SettingsSubPage
      title={t("settings.navigation.checkIn")}
      description={t("settings.cards.checkIn.description")}
      actions={actions}
      wide
    >
      <SettingsFeedback error={error || loadError} success={success} />
      {!settings ? (
        !loadError && <p className="text-sm text-gray-500">{t("settings.checkIn.loading")}</p>
      ) : (
        <fieldset disabled={!canManage || saving} className="min-w-0 space-y-5">
          {!canManage && (
            <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
              {t("settings.checkIn.readOnly")}
            </p>
          )}
          <FlowOverview
            summaries={checkinStepSummaries(settings, soldAddons.length, checks.length, t)}
          />
          <ArrivalSection settings={settings} onChange={update} />
          <RoomsAndGuestsSection settings={settings} onChange={update} />
          <AddonsAndPaymentSection
            settings={settings}
            catalog={catalog}
            sold={soldAddons}
            onChange={update}
          />
          <KeysSection
            settings={settings}
            onChange={update}
            checks={checks}
            canEditChecks={canEditChecks}
            checkErrors={checkErrors}
            onChecksChange={(next) => {
              setSuccess("");
              setCheckErrors({});
              setChecks(next);
            }}
          />
        </fieldset>
      )}
    </SettingsSubPage>
  );
}

function FlowOverview({ summaries }: { summaries: string[] }) {
  const { t } = useTranslation();
  const titles = [1, 2, 3, 4].map((step) => t(`settings.checkIn.step${step}.title`));
  return (
    <nav
      aria-label={t("settings.checkIn.overview")}
      className="grid gap-3 rounded-2xl border border-gray-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {titles.map((title, index) => (
        <a
          key={title}
          href={`#${SECTION_IDS[index]}`}
          className="flex min-w-0 items-center gap-3 rounded-xl p-2 hover:bg-gray-50"
        >
          <StepNumber n={index + 1} solid />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-gray-900">{title}</span>
            <span className="block truncate text-xs text-gray-500">{summaries[index]}</span>
          </span>
        </a>
      ))}
    </nav>
  );
}

function StepNumber({ n, solid = false }: { n: number; solid?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
        solid ? "bg-primary-600 text-white" : "bg-primary-50 text-primary-800"
      }`}
    >
      {n}
    </span>
  );
}

function Section({ step, children }: { step: number; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section
      id={SECTION_IDS[step - 1]}
      aria-labelledby={`${SECTION_IDS[step - 1]}-title`}
      className="scroll-mt-6 overflow-hidden rounded-2xl border border-gray-200 bg-white"
    >
      <div className="flex items-start gap-3 p-4 md:p-6">
        <StepNumber n={step} />
        <div className="min-w-0">
          <h2 id={`${SECTION_IDS[step - 1]}-title`} className="text-lg font-bold text-gray-900">
            {t(`settings.checkIn.step${step}.title`)}
          </h2>
          <p className="text-sm text-gray-600">{t(`settings.checkIn.step${step}.description`)}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`border-t border-gray-200 px-4 py-4 md:px-6 ${className}`}>{children}</div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-primary-600" : "bg-gray-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900">{title}</p>
        <p className="text-sm text-gray-600">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </Row>
  );
}

function OptionCards<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: Array<{ value: T; title: string; description: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="mt-3 grid gap-3 sm:grid-cols-3">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={`flex cursor-pointer flex-col rounded-xl p-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary-500 ${
              selected
                ? "bg-primary-50 ring-2 ring-inset ring-primary-600"
                : "border border-gray-200 bg-white"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span className="text-sm font-semibold text-gray-900">{option.title}</span>
            <span className="text-xs text-gray-600">{option.description}</span>
          </label>
        );
      })}
    </div>
  );
}

function ArrivalSection({
  settings,
  onChange,
}: {
  settings: CheckinSettings;
  onChange: (next: CheckinSettings) => void;
}) {
  const { t } = useTranslation();
  return (
    <Section step={1}>
      <SwitchRow
        title={t("settings.checkIn.showSpecialRequest")}
        description={t("settings.checkIn.showSpecialRequestHint")}
        checked={settings.showSpecialRequest}
        onChange={(next) =>
          onChange({
            ...settings,
            showSpecialRequest: next,
            confirmSpecialRequest: next && settings.confirmSpecialRequest,
          })
        }
      />
      <SwitchRow
        title={t("settings.checkIn.confirmSpecialRequest")}
        description={t("settings.checkIn.confirmSpecialRequestHint")}
        checked={settings.confirmSpecialRequest}
        disabled={!settings.showSpecialRequest}
        onChange={(next) => onChange({ ...settings, confirmSpecialRequest: next })}
      />
    </Section>
  );
}

function RoomsAndGuestsSection({
  settings,
  onChange,
}: {
  settings: CheckinSettings;
  onChange: (next: CheckinSettings) => void;
}) {
  const { t } = useTranslation();
  const counts = guestFieldCounts(settings);
  return (
    <Section step={2}>
      <SwitchRow
        title={t("settings.checkIn.allowRoomChanges")}
        description={t("settings.checkIn.allowRoomChangesHint")}
        checked={settings.allowRoomChanges}
        onChange={(next) => onChange({ ...settings, allowRoomChanges: next })}
      />
      <SwitchRow
        title={t("settings.checkIn.allowIncompleteGuests")}
        description={t("settings.checkIn.allowIncompleteGuestsHint")}
        checked={settings.allowIncompleteGuests}
        onChange={(next) => onChange({ ...settings, allowIncompleteGuests: next })}
      />
      <SwitchRow
        title={t("settings.checkIn.guestNotes")}
        description={t("settings.checkIn.guestNotesHint")}
        checked={settings.guestNotes}
        onChange={(next) => onChange({ ...settings, guestNotes: next })}
      />
      <Row>
        <p className="text-sm font-semibold text-gray-900">
          {t("settings.checkIn.registrationScope")}
        </p>
        <p className="text-sm text-gray-600">{t("settings.checkIn.registrationScopeHint")}</p>
        <OptionCards
          name={t("settings.checkIn.registrationScope")}
          value={settings.registrationScope}
          onChange={(registrationScope) => onChange({ ...settings, registrationScope })}
          options={(["booker", "adults", "all"] as const).map((scope) => ({
            value: scope,
            title: t(`settings.checkIn.scope.${scope}`),
            description: t(`settings.checkIn.scope.${scope}Hint`),
          }))}
        />
      </Row>
      <Row className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-[1_1_16rem]">
          <p className="text-sm font-semibold text-gray-900">{t("settings.checkIn.guestFields")}</p>
          <p className="text-sm text-gray-600">{t("settings.checkIn.guestFieldsHint")}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill tone="primary">
            {t("settings.checkIn.requiredCount", { count: counts.required })}
          </Pill>
          <Pill>{t("settings.checkIn.optionalCount", { count: counts.optional })}</Pill>
          <Pill>{t("settings.checkIn.hiddenCount", { count: counts.hidden })}</Pill>
        </div>
      </Row>
      {/* Scrolls sideways inside its own box on a phone; relative keeps sr-only labels inside. */}
      <div className="relative overflow-x-auto border-t border-gray-200">
        <table className="w-full min-w-[20rem] text-left text-sm">
          <thead className="bg-gray-50 text-xs font-bold uppercase tracking-wide text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2.5 md:px-6">
                {t("settings.checkIn.fieldColumn")}
              </th>
              <th scope="col" className="w-16 px-2 py-2.5 md:w-20">
                {t("settings.checkIn.showColumn")}
              </th>
              <th scope="col" className="w-24 px-2 py-2.5 pr-4 md:pr-6">
                {t("settings.checkIn.requiredColumn")}
              </th>
            </tr>
          </thead>
          <tbody>
            {(["firstName", "lastName"] as const).map((locked) => (
              <tr key={locked} className="border-t border-gray-200">
                <th scope="row" className="px-4 py-3 font-normal md:px-6">
                  <span className="flex items-center gap-1.5 font-semibold text-gray-900">
                    {t(`settings.checkIn.field.${locked}`)}
                    <LockClosedIcon className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
                  </span>
                  <span className="hidden text-xs text-gray-500 md:block">
                    {t("settings.checkIn.alwaysCollected")}
                  </span>
                </th>
                <td className="px-2 py-3">
                  <Switch
                    checked
                    onChange={() => undefined}
                    label={t("settings.checkIn.showColumn")}
                    disabled
                  />
                </td>
                <td className="px-2 py-3 pr-4 md:pr-6">
                  <Switch
                    checked
                    onChange={() => undefined}
                    label={t("settings.checkIn.requiredColumn")}
                    disabled
                  />
                </td>
              </tr>
            ))}
            {settings.guestFields.map((entry) => {
              const label = guestFieldLabel(entry.field, t);
              return (
                <tr key={entry.field} className="border-t border-gray-200">
                  <th scope="row" className="px-4 py-3 font-normal md:px-6">
                    <span className="font-semibold text-gray-900">{label}</span>
                    {(entry.field === "email" || entry.field === "phone") && (
                      <span className="hidden text-xs text-gray-500 md:block">
                        {t("settings.checkIn.prefilledFromBooking")}
                      </span>
                    )}
                  </th>
                  <td className="px-2 py-3">
                    <Switch
                      checked={entry.show}
                      label={t("settings.checkIn.showField", { field: label })}
                      onChange={(show) => onChange(setGuestField(settings, entry.field, { show }))}
                    />
                  </td>
                  <td className="px-2 py-3 pr-4 md:pr-6">
                    <Switch
                      checked={entry.required}
                      label={t("settings.checkIn.requireField", { field: label })}
                      onChange={(required) =>
                        onChange(setGuestField(settings, entry.field, { required }))
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Pill({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "primary" }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
        tone === "primary" ? "bg-primary-50 text-primary-800" : "bg-gray-100 text-gray-700"
      }`}
    >
      {children}
    </span>
  );
}

function AddonsAndPaymentSection({
  settings,
  catalog,
  sold,
  onChange,
}: {
  settings: CheckinSettings;
  catalog: BookingAddon[];
  sold: BookingAddon[];
  onChange: (next: CheckinSettings) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const notSold = catalog.filter((addon) => !sold.some((item) => item.id === addon.id));
  const setSold = (ids: string[]) => onChange({ ...settings, addonIds: ids });
  const toggleOption = (option: CheckinSettlementOption) => {
    const on = settings.settlementOptions.includes(option);
    const next = CHECKIN_SETTLEMENT_OPTIONS.filter((candidate) =>
      candidate === option ? !on : settings.settlementOptions.includes(candidate),
    );
    if (next.length > 0) onChange({ ...settings, settlementOptions: next });
  };
  return (
    <Section step={3}>
      <SwitchRow
        title={t("settings.checkIn.offerAddons")}
        description={t("settings.checkIn.offerAddonsHint")}
        checked={settings.offerAddons}
        onChange={(next) => onChange({ ...settings, offerAddons: next })}
      />
      {settings.offerAddons && (
        <Row>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
              {t("settings.checkIn.soldAtCheckin")}
            </p>
            <button
              type="button"
              onClick={() => void openBookingAdmin("/add-ons")}
              className="text-sm font-semibold text-primary-600 underline hover:text-primary-700"
            >
              {t("settings.checkIn.manageAddons")}
            </button>
          </div>
          <p className="mt-1 text-sm text-gray-600">{t("settings.checkIn.soldAtCheckinHint")}</p>
          <ul className="mt-3 space-y-2">
            {sold.map((addon) => (
              <li
                key={addon.id}
                className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900">{addon.name}</span>
                  <span className="block text-xs text-gray-600">
                    {formatCurrency(addon.price, addon.currency)} · {addonUnit(addon, t)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSold(sold.filter((item) => item.id !== addon.id).map((item) => item.id))
                  }
                  className="text-sm font-semibold text-red-700 hover:text-red-800"
                >
                  {t("settings.checkIn.remove")}
                  <span className="sr-only"> {addon.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {sold.length === 0 && (
            <p className="mt-3 rounded-xl border border-dashed border-gray-300 p-3 text-sm text-gray-500">
              {t("settings.checkIn.noAddonsSold")}
            </p>
          )}
          {notSold.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                aria-expanded={picking}
                onClick={() => setPicking((open) => !open)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400"
              >
                <PlusIcon className="h-4 w-4" aria-hidden="true" />
                {t("settings.checkIn.addAddon")}
              </button>
              {picking && (
                <ul className="mt-2 max-w-md divide-y divide-gray-100 rounded-xl border border-gray-200">
                  {notSold.map((addon) => (
                    <li key={addon.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSold([...sold.map((item) => item.id), addon.id]);
                          setPicking(false);
                        }}
                        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50"
                      >
                        <span className="font-semibold text-gray-900">{addon.name}</span>
                        <span className="text-gray-600">
                          {formatCurrency(addon.price, addon.currency)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Row>
      )}
      <Row>
        <p className="text-sm font-semibold text-gray-900">
          {t("settings.checkIn.settlementOptions")}
        </p>
        <p className="text-sm text-gray-600">{t("settings.checkIn.settlementOptionsHint")}</p>
        <div
          role="group"
          aria-label={t("settings.checkIn.settlementOptions")}
          className="mt-3 flex flex-wrap gap-2"
        >
          {CHECKIN_SETTLEMENT_OPTIONS.map((option) => {
            const on = settings.settlementOptions.includes(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={on}
                onClick={() => toggleOption(option)}
                className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold ${
                  on
                    ? "bg-primary-50 text-primary-800 ring-2 ring-inset ring-primary-600"
                    : "border border-gray-300 bg-white text-gray-700"
                }`}
              >
                {on && <CheckIcon className="h-4 w-4" aria-hidden="true" />}
                {settlementOptionLabel(option, t)}
              </button>
            );
          })}
        </div>
      </Row>
      <SwitchRow
        title={t("settings.checkIn.paymentChoiceRequired")}
        description={t("settings.checkIn.paymentChoiceRequiredHint")}
        checked={settings.paymentChoiceRequired}
        onChange={(next) => onChange({ ...settings, paymentChoiceRequired: next })}
      />
      <Row className="flex items-start gap-2 bg-gray-50">
        <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
        <p className="text-sm text-gray-700">{t("settings.checkIn.nothingDueNote")}</p>
      </Row>
    </Section>
  );
}

function KeysSection({
  settings,
  onChange,
  checks,
  canEditChecks,
  checkErrors,
  onChecksChange,
}: {
  settings: CheckinSettings;
  onChange: (next: CheckinSettings) => void;
  checks: CheckinChecklistStep[];
  canEditChecks: boolean;
  checkErrors: Record<string, string>;
  onChecksChange: (next: CheckinChecklistStep[]) => void;
}) {
  const { t } = useTranslation();
  const updateCheck = (id: string, patch: Partial<CheckinChecklistStep>) =>
    onChecksChange(checks.map((check) => (check.id === id ? { ...check, ...patch } : check)));
  return (
    <Section step={4}>
      <Row>
        <p className="text-sm font-semibold text-gray-900">{t("settings.checkIn.keyHandover")}</p>
        <p className="text-sm text-gray-600">{t("settings.checkIn.keyHandoverHint")}</p>
        <OptionCards
          name={t("settings.checkIn.keyHandover")}
          value={settings.keyHandover}
          onChange={(keyHandover) => onChange({ ...settings, keyHandover })}
          options={(["physical", "none"] as const).map((mode) => ({
            value: mode,
            title: t(`settings.checkIn.keys.${mode}`),
            description: t(`settings.checkIn.keys.${mode}Hint`),
          }))}
        />
      </Row>
      <Row>
        <h3 id="extra-checks" className="scroll-mt-6 text-sm font-semibold text-gray-900">
          {t("settings.checkIn.extraChecks")}
        </h3>
        <p className="text-sm text-gray-600">{t("settings.checkIn.extraChecksHint")}</p>
        <fieldset disabled={!canEditChecks} className="min-w-0">
          {!canEditChecks && (
            <p className="mt-2 text-sm text-gray-600">{t("settings.checkIn.checksReadOnly")}</p>
          )}
          <ul className="mt-3 space-y-2">
            {checks.map((check) => (
              <li key={check.id} className="rounded-xl border border-gray-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="min-w-0 flex-[1_1_14rem]">
                    <span className="sr-only">{t("settings.checkIn.checkLabel")}</span>
                    <input
                      value={check.label}
                      onChange={(event) => updateCheck(check.id, { label: event.target.value })}
                      placeholder={t("settings.checkIn.checkLabelPlaceholder")}
                      aria-invalid={Boolean(checkErrors[check.id])}
                      className="h-10 w-full rounded-lg border border-gray-300 px-3 text-sm text-gray-900 placeholder:text-gray-400"
                    />
                  </label>
                  <label>
                    <span className="sr-only">{t("settings.checkIn.checkType")}</span>
                    <select
                      value={check.type}
                      onChange={(event) =>
                        updateCheck(check.id, {
                          type: event.target.value as CheckinChecklistStepType,
                        })
                      }
                      className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm text-gray-900"
                    >
                      {(["checkbox", "text", "amount"] as const).map((type) => (
                        <option key={type} value={type}>
                          {t(`settings.checkIn.checkTypes.${type}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={check.required}
                      onChange={(event) =>
                        updateCheck(check.id, { required: event.target.checked })
                      }
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    {t("settings.checkIn.checkRequired")}
                  </label>
                  <button
                    type="button"
                    onClick={() => onChecksChange(checks.filter((item) => item.id !== check.id))}
                    aria-label={t("settings.checkIn.removeCheck", { label: check.label || "…" })}
                    className="flex h-10 w-10 items-center justify-center rounded-lg text-red-700 hover:bg-red-50"
                  >
                    <XMarkIcon className="h-5 w-5" aria-hidden="true" />
                  </button>
                </div>
                {checkErrors[check.id] && (
                  <p role="alert" className="mt-1 text-xs font-medium text-red-700">
                    {checkErrors[check.id]}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => onChecksChange([...checks, newCheck(checks.length)])}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-400"
          >
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
            {t("settings.checkIn.addCheck")}
          </button>
        </fieldset>
      </Row>
    </Section>
  );
}
