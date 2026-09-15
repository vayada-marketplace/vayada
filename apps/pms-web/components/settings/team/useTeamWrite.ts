"use client";
import { useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import { newPmsTeamCommandKey } from "@/services/api/pmsStaffClient";

export function useTeamWrite() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string }>();
  async function run<T>(
    payload: T,
    write: (payload: T, key: string) => Promise<unknown>,
  ): Promise<boolean> {
    if (inFlight.current) return false;
    const fingerprint = JSON.stringify(payload);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: newPmsTeamCommandKey() };
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await write(payload, attempt.current.key);
      return true;
    } catch (cause) {
      setError(
        t(
          cause instanceof ApiErrorResponse && cause.status === 409
            ? cause.data.code === "invitation_pending"
              ? "settings.team.invitationAlreadyPending"
              : cause.data.code === "role_in_use"
                ? "settings.team.roleInUse"
                : "settings.team.conflict"
            : cause instanceof ApiErrorResponse && cause.status === 403
              ? "settings.team.forbidden"
              : "settings.team.saveUnconfirmed",
        ),
      );
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run };
}
