"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getPmsCalendarSettings,
  updatePmsCalendarSettings,
} from "@/services/api/pmsPropertyClient";
import { settingsService } from "@/services/settings";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { CalendarAutoOpenEditor } from "@/components/settings/CalendarAutoOpenEditor";
import { CalendarSection } from "@/components/settings/CalendarSection";
import { SettingsFeedback } from "@/components/settings/SettingsFeedback";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { humanizeApiError } from "@/components/settings/constants";

export default function CalendarSettingsPage() {
  const { t } = useTranslation();
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [sameDayEnabled, setSameDayEnabled] = useState(true);
  const [sameDayCutoffTime, setSameDayCutoffTime] = useState<string | null>("18:00");
  const [sameDayTimeZone, setSameDayTimeZone] = useState("");
  const [sameDayLoading, setSameDayLoading] = useState(true);
  const [sameDaySaving, setSameDaySaving] = useState(false);
  const [sameDayLoadError, setSameDayLoadError] = useState("");
  const [autoRearrangeEnabled, setAutoRearrangeEnabled] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarSaving, setCalendarSaving] = useState(false);
  const [calendarLoadError, setCalendarLoadError] = useState("");

  const loadCalendarSettings = useCallback(async () => {
    setCalendarLoading(true);
    setCalendarLoadError("");
    try {
      const settings = await getPmsCalendarSettings();
      setAutoRearrangeEnabled(settings.autoRearrangeEnabled);
    } catch (loadError) {
      setCalendarLoadError(
        localizedErrorText(
          loadError,
          humanizeApiError(loadError, t("settings.calendar.loadAssignmentError")),
          t,
        ),
      );
    } finally {
      setCalendarLoading(false);
    }
  }, [t]);

  const loadSameDayBooking = useCallback(async () => {
    setSameDayLoading(true);
    setSameDayLoadError("");
    try {
      const settings = await settingsService.getSameDayBooking();
      setSameDayEnabled(settings.enabled);
      setSameDayCutoffTime(settings.cutoffLocalTime);
      setSameDayTimeZone(settings.propertyTimeZone);
    } catch (loadError) {
      setSameDayLoadError(
        localizedErrorText(
          loadError,
          humanizeApiError(loadError, t("settings.calendar.loadSameDayError")),
          t,
        ),
      );
    } finally {
      setSameDayLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadCalendarSettings();
    void loadSameDayBooking();
  }, [loadCalendarSettings, loadSameDayBooking]);

  const saveAutoRearrange = async (enabled: boolean) => {
    setCalendarSaving(true);
    setError("");
    setSuccess("");
    try {
      const saved = await updatePmsCalendarSettings(enabled);
      setAutoRearrangeEnabled(saved.autoRearrangeEnabled);
      setSuccess(t("settings.calendar.saved"));
    } catch (saveError) {
      setError(humanizeApiError(saveError, t("settings.calendar.saveError")));
    } finally {
      setCalendarSaving(false);
    }
  };

  const saveSameDayBooking = async (enabled: boolean, cutoffLocalTime: string | null) => {
    setSameDaySaving(true);
    setError("");
    setSuccess("");
    try {
      const saved = await settingsService.updateSameDayBooking(enabled, cutoffLocalTime);
      setSameDayEnabled(saved.enabled);
      setSameDayCutoffTime(saved.cutoffLocalTime);
      setSameDayTimeZone(saved.propertyTimeZone);
      setSuccess(t("settings.calendar.sameDaySaved"));
    } catch (saveError) {
      setError(humanizeApiError(saveError, t("settings.calendar.sameDaySaveError")));
    } finally {
      setSameDaySaving(false);
    }
  };

  return (
    <SettingsSubPage
      title={t("settings.navigation.calendar")}
      description={t("settings.calendar.description")}
    >
      <SettingsFeedback error={error} success={success} />
      <CalendarSection
        enabled={autoRearrangeEnabled}
        loading={calendarLoading}
        saving={calendarSaving}
        loadError={calendarLoadError}
        onToggle={(next) => void saveAutoRearrange(next)}
        onRetry={() => void loadCalendarSettings()}
        autoOpenEditor={<CalendarAutoOpenEditor />}
        sameDayEnabled={sameDayEnabled}
        sameDayCutoffTime={sameDayCutoffTime}
        sameDayTimeZone={sameDayTimeZone}
        sameDayLoading={sameDayLoading}
        sameDaySaving={sameDaySaving}
        sameDayLoadError={sameDayLoadError}
        onSameDayToggle={(next) => void saveSameDayBooking(next, sameDayCutoffTime)}
        onSameDayCutoffChange={(next) => void saveSameDayBooking(sameDayEnabled, next)}
        onSameDayRetry={() => void loadSameDayBooking()}
      />
    </SettingsSubPage>
  );
}
