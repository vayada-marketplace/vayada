"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import type {
  PricingAuthority,
  createReplacementPricingClient,
} from "@/services/api/replacementPricingClient";
import { errorText, PricingError } from "./pricingAmounts";

type Client = ReturnType<typeof createReplacementPricingClient>;
/** This choice is explicit and separate from publishing rates or connecting channels. */
export function PricingAuthorityControl({
  client,
  blocked,
  onActivityChange,
}: {
  client: Client;
  blocked: boolean;
  onActivityChange(active: boolean): void;
}) {
  const [current, setCurrent] = useState<PricingAuthority | null>(null);
  const [choice, setChoice] = useState<PricingAuthority["authority"]>("unconfigured");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState<ReturnType<Client["authorityAction"]> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { t } = useTranslation();
  const alive = useRef(true);
  useEffect(() => {
    onActivityChange(busy || !!pending);
  }, [busy, pending, onActivityChange]);
  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const value = await client.readAuthority();
      if (alive.current) {
        setCurrent(value);
        setChoice(value.authority);
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e : new PricingError("pricing.authority.loadFailed"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);
  async function save(confirmed = false) {
    setConfirming(false);
    if (!current || busy || blocked) return;
    let action = pending;
    if (!action) {
      if (!confirmed) {
        setConfirming(true);
        return;
      }
      action = client.authorityAction(current.revision, choice);
      setPending(() => action);
    }
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setPending(null);
      const saved = await client.readAuthority();
      if (saved.revision !== result.revision || saved.authority !== choice)
        throw new PricingError("pricing.authority.unverified");
      if (alive.current) setCurrent(saved);
    } catch (e) {
      if (e instanceof ApiErrorResponse && [400, 403, 409].includes(e.status)) setPending(null);
      if (alive.current)
        setError(
          e instanceof ApiErrorResponse && e.status === 409
            ? new PricingError("pricing.authority.changed")
            : e instanceof Error
              ? e
              : new PricingError("pricing.authority.saveFailed"),
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border bg-white p-5" aria-label={t("pricing.authority.title")}>
      <h2 className="font-semibold">{t("pricing.authority.title")}</h2>
      <p className="mt-1 text-sm text-gray-600">{t("pricing.authority.description")}</p>
      {current && (
        <p className="mt-3 text-sm">
          {t("pricing.authority.current")}{" "}
          <strong>{t(`pricing.source.${current.authority}`)}</strong>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {errorText(error, t, "pricing.authority.loadFailed")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <select
          aria-label={t("pricing.authority.select")}
          className="rounded border px-3 py-2 text-sm"
          disabled={!current || busy || blocked || !!pending}
          value={choice}
          onChange={(e) => setChoice(e.target.value as PricingAuthority["authority"])}
        >
          <option value="unconfigured">{t("pricing.authority.none")}</option>
          <option value="vayada">{t("pricing.source.vayada")}</option>
          <option value="external">{t("pricing.source.external")}</option>
        </select>
        <button
          type="button"
          className="rounded border px-4 py-2 text-sm disabled:opacity-50"
          disabled={!current || busy || blocked}
          onClick={() => void save()}
        >
          {pending
            ? t("pricing.authority.retry")
            : choice === current?.authority
              ? t("pricing.authority.reaffirm")
              : t("pricing.authority.save")}
        </button>
        <button
          type="button"
          className="rounded border px-4 py-2 text-sm disabled:opacity-50"
          disabled={busy || !!pending}
          onClick={() => void reload()}
        >
          {t("pricing.authority.reload")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("pricing.authorityTitle")}
          message={t("pricing.authorityMessage", { source: t(`pricing.source.${choice}`) })}
          confirmLabel={t("common.confirm")}
          cancelLabel={t("common.cancel")}
          onConfirm={() => void save(true)}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
