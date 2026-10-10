"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pricingCurrencyScale, parsePricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import { samePricingValue, type createReplacementPricingClient, type PricingSnapshot, type PricingTermsInput } from "@/services/api/replacementPricingClient";

import { baseAmounts, decimalAmount, editedSnapshot, type MessageKey, PricingError } from "./pricingAmounts";
import { financeNotReady, pricingSave, pricingSaveError } from "./savePricing";
import { FirstPricingSetup, type SetupRoom, type firstPricingInput } from "./FirstPricingSetup";
import { PricingTerms } from "./PricingTerms";
import { PricingIncludedAdjustments } from "./PricingIncludedAdjustments";
import { PricingStayOwnership } from "./PricingStayOwnership";
import { PricingStaySeasons } from "./PricingStaySeasons";
import { PricingStayDates } from "./PricingStayDates";
import { PricingStayRules } from "./PricingStayRules";
import { PricingSeasons } from "./PricingSeasons";
import { PricingMonths } from "./PricingMonths";
import { PricingWeekdays } from "./PricingWeekdays";
import { NewLinkedOffer } from "./NewLinkedOffer";
import { PricingLinkedParent } from "./PricingLinkedParent";
import { PricingMealPlan } from "./PricingMealPlan";
import { PricingMealCharges } from "./PricingMealCharges";
import { PricingChildCharges } from "./PricingChildCharges";
import { PricingLinkedAdjustment } from "./PricingLinkedAdjustment";
import { PricingDates } from "./PricingDates";
import { PricingRules } from "./PricingRules";
import { PricingStayPreview } from "./PricingStayPreview";

type Client = ReturnType<typeof createReplacementPricingClient>;
type Room = PricingSnapshot["rooms"][number];
/** A room's unsaved edits carried over a reload after a refused save, with the room as it was loaded. */
type Kept = { room: Room; base: Room | null; terms: Record<string, PricingTermsInput>; bases: Record<string, string | null> };
/** One room's prices (the room page's Prices tab). Saving publishes the whole property, with every other room
 * exactly as read. */
export function PricingEditor({ client, roomNames = {}, setup, roomTypeId: focus }: { client: Client; roomNames?: Record<string, string>; setup?: { propertyId: string; rooms: readonly SetupRoom[] }; roomTypeId: string }) {
  const [policyEdits, setPolicyEdits] = useState<Record<string, PricingTermsInput>>({});
  const policyBases = useRef<Record<string, string | null>>({});
  const policyKey = (room: string, offer: string) => JSON.stringify([room, offer]);
  const [independentOffer, setIndependentOffer] = useState(false);
  const [addingOfferRoom, setAddingOfferRoom] = useState<string | null>(null);
  const [pendingEntries, setPendingEntries] = useState<Record<string, boolean>>({});
  const exclusiveEditPending = addingOfferRoom !== null || Object.entries(pendingEntries).some(([key, pending]) => (key.startsWith("ownership:") || key.startsWith("mealPlan:") || key.startsWith("parent:") || key.startsWith("included:") || key.startsWith("policy:")) && pending);
  const hasPendingEntries = addingOfferRoom !== null || Object.values(pendingEntries).some(Boolean);
  const [empty, setEmpty] = useState(false);
  const [current, setCurrent] = useState<PricingSnapshot | null>(null), [baseRevision, setBaseRevision] = useState(0), [stale, setStale] = useState(false);
  const loadedRooms = useRef<readonly Room[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({}), [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [notice, setNotice] = useState<MessageKey | "">("");
  const [needsReload, setNeedsReload] = useState(false), [done, setDone] = useState(false), [retry, setRetry] = useState(false);
  const editableFailure = useRef<((error: unknown) => boolean) | null>(null);
  const action = useRef<(() => Promise<void>) | null>(null), locked = useRef(false), alive = useRef(true);
  const leaving = useRef(false);
  const [leave, setLeave] = useState<(() => void) | null>(null), [reloading, setReloading] = useState(false);
  const { t } = useTranslation();
  const roomName = (roomTypeId: string, ri: number) => roomNames[roomTypeId] ?? t("pricing.roomNumber", { number: ri + 1 });
  const offerLabel = (roomTypeId: string, ri: number, oi: number) => t("pricing.roomOffer", { room: roomName(roomTypeId, ri), number: oi + 1 });
  const load = useCallback(async (after?: { keep?: Kept; notice?: MessageKey }) => {
    setLoading(true); setEmpty(false); setError(null);
    try {
      const saved = await client.read(); if (!alive.current) return;
      const revision = (saved?.revision ?? 0) + 1, rooms = (saved?.rooms ?? []).map((room) => ({ ...room, revision }));
      const keep = after?.keep, kept = keep && keptRoom(keep, saved), room = kept && { ...kept, revision };
      setEmpty(saved === null && !room); setPolicyEdits(room ? keep!.terms : {}); loadedRooms.current = saved?.rooms ?? [];
      policyBases.current = { ...(room ? keep!.bases : {}), ...Object.fromEntries((saved?.rooms ?? []).flatMap((r) => r.offers.map((o) => [policyKey(r.roomTypeId, o.id), o.termsRevision]))) };
      setCurrent(saved || room ? { currency: saved?.currency ?? room!.currency, ownerReferences: { finance: saved?.ownerReferences.finance ?? "" },
        rooms: !room ? rooms : rooms.some((value) => value.roomTypeId === room.roomTypeId) ? rooms.map((value) => value.roomTypeId === room.roomTypeId ? room : value) : [...rooms, room] } : null);
      setAddingOfferRoom(null); setPendingEntries({}); setBaseRevision(saved?.revision ?? 0); setStale(!!saved?.stale); setInputs({}); setDirty(!!room); setNeedsReload(false); setDone(false);
      setNotice(room ? "pricing.room.noticeKept" : keep ? "pricing.room.noticeDropped" : after?.notice ?? (saved?.stale ? "pricing.room.noticeStale" : ""));
    } catch (e) { if (alive.current) setError(e); }
    finally { if (alive.current) setLoading(false); }
  }, [client, focus]);
  /** After a refused save (another publication, or a room, terms or payment change), reload and keep this room's
   * edits when the server still has this room exactly as it was loaded; the next press declares again. */
  function reloadKeepingRoom() {
    let room: Room | undefined;
    try { room = current ? editedSnapshot(current, inputs).rooms.find((value) => value.roomTypeId === focus) : undefined; } catch { room = undefined; }
    void load(room && { keep: { room, base: loadedRooms.current.find((value) => value.roomTypeId === focus) ?? null,
      terms: Object.fromEntries(Object.entries(policyEdits).filter(([, terms]) => terms.roomTypeId === focus)),
      bases: Object.fromEntries(Object.entries(policyBases.current).filter(([key]) => JSON.parse(key)[0] === focus)) } });
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]); // Client is property-bound; parent keys this component by property.
  const leaveRisk = hasPendingEntries || dirty || retry || busy;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (leaveRisk && !leaving.current) { event.preventDefault(); event.returnValue = ""; } };
    // Links stay in-app until this room has unsaved prices; then leaving asks first and leaves through the
    // document, so beforeunload does not ask a second time.
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || event.metaKey || event.ctrlKey || event.shiftKey || link.target === "_blank" || !leaveRisk) return;
      event.preventDefault(); event.stopPropagation();
      const href = link.href;
      setLeave(() => () => window.location.assign(href));
    };
    const switchProperty = (event: Event) => {
      if (!leaveRisk) { leaving.current = true; return; }
      event.preventDefault(); // Hold the switch until the in-app dialog confirms; the dispatcher's `proceed` resumes it.
      const proceed = (event as CustomEvent<{ proceed?: () => void } | undefined>).detail?.proceed;
      if (proceed) setLeave(() => proceed);
    };
    window.addEventListener("beforeunload", warn); document.addEventListener("click", navigate, true);
    window.addEventListener("pms:before-property-change", switchProperty);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", navigate, true); window.removeEventListener("pms:before-property-change", switchProperty); };
  }, [leaveRisk, focus]);
  async function run(next?: () => Promise<void>, stopEditable?: (error: unknown) => boolean) {
    if (locked.current) return;
    if (next) { action.current = next; editableFailure.current = stopEditable ?? null; }
    if (!action.current) return;
    locked.current = true; setBusy(true); setError(null);
    try { await action.current(); action.current = null; if (alive.current) setRetry(false); }
    catch (e) {
      if (alive.current) {
        setError(e);
        // A failure the staff member can fix (e.g. payment settings) ends the action but keeps the edits editable.
        const definitive = e instanceof ApiErrorResponse && [400, 403, 409].includes(e.status);
        if (editableFailure.current?.(e)) { action.current = null; setRetry(false); }
        else if (definitive) { action.current = null; setNeedsReload(true); setRetry(false); } else setRetry(true);
      }
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  function createInitial(input: ReturnType<typeof firstPricingInput>, addToRoom = false) {
    if (locked.current || busy || retry || needsReload || done) return;
    const otherRoom = input.configuration.roomTypeId !== focus;
    if (!addToRoom && (otherRoom || current && (current.currency !== input.configuration.currency || current.rooms.some((room) => room.roomTypeId === input.configuration.roomTypeId) ||
        !setup?.rooms.some((room) => room.roomTypeId === input.configuration.roomTypeId) || setup.propertyId !== input.configuration.propertyId))) {
      setError(new PricingError("pricing.editor.errorUnconfiguredRoom")); return;
    }
    let existing: PricingSnapshot | null, configuration = input.configuration;
    try {
      existing = current ? editedSnapshot(current, inputs) : null;
      if (addToRoom) {
        const target = existing?.rooms.find((room) => room.roomTypeId === addingOfferRoom);
        const offer = input.configuration.offers.find((value) => value.id === input.terms.offerId);
        if (!target || !offer || target.roomTypeId !== input.terms.roomTypeId || target.roomTypeId !== input.configuration.roomTypeId || target.offers.some((value) => value.id === offer.id)) throw new PricingError("pricing.editor.errorNewOffer");
        const appended = parsePricingConfiguration({ ...target, offers: [...target.offers, offer] });
        if (!appended) throw new PricingError("pricing.editor.errorNewOfferSettings");
        configuration = appended;
      }
    } catch (e) { setError(e); return; }
    const room = { ...configuration, revision: baseRevision + 1 };
    const rooms = addToRoom ? existing!.rooms.map((value) => value.roomTypeId === room.roomTypeId ? room : value) : [...(existing?.rooms ?? []), room];
    const key = policyKey(input.terms.roomTypeId, input.terms.offerId);
    policyBases.current[key] = input.terms.expectedRevision;
    setPolicyEdits((previous) => ({ ...previous, [key]: input.terms }));
    setCurrent({ currency: room.currency, rooms, ownerReferences: existing?.ownerReferences ?? { finance: "" } });
    setInputs({}); setAddingOfferRoom(null); setDirty(true);
    setNotice("pricing.editor.noticeSetupAdded");
  }

  /** One "Save prices" action (see `pricingSave`). Every finished step is kept, so "Retry last action" resumes
   * with the same idempotency keys; each new press starts a fresh draft. */
  function save() {
    if (!current || hasPendingEntries || done || !(dirty || stale)) return;
    let edited: PricingSnapshot;
    try { edited = editedSnapshot(current, inputs); } catch (e) { setError(e); return; }
    const step = pricingSave(client, { snapshot: edited, baseRevision, terms: Object.values(policyEdits) });
    void run(async () => {
      const attached = await step();
      if (!alive.current) return;
      // Shows the saved prices for review; "Edit prices again" reloads, so the next save starts from the new revision.
      setCurrent(attached.snapshot); setDone(true); setDirty(false); setInputs({}); setPolicyEdits({}); setNotice("pricing.editor.noticeSaved");
    }, financeNotReady);
  }
  const disabled = busy || retry || needsReload || done, display = current;
  const roomSetup = setup?.rooms.filter((room) => room.roomTypeId === focus) ?? [];
  const focusIndex = display ? display.rooms.findIndex((room) => room.roomTypeId === focus) : -1, editing = focusIndex >= 0;
  const shownRooms = (display?.rooms ?? []).map((room, ri) => [room, ri] as const).filter(([room]) => room.roomTypeId === focus);
  const scale = display ? pricingCurrencyScale(display.currency)! : 2;
  return <section className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold text-gray-950">{t("pricing.room.title")}</h2><p className="mt-1 text-sm text-gray-600">{t("pricing.room.subtitle")}</p></div>
      <button className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50" disabled={loading || busy || retry} onClick={() => { if (needsReload) reloadKeepingRoom(); else if (leaveRisk) setReloading(true); else void load(); }}>{t("pricing.editor.reload")}</button></header>
    {reloading && <ConfirmDialog title={t("pricing.reloadTitle")} message={t("pricing.reloadMessage")} confirmLabel={t("pricing.reloadConfirm")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { setReloading(false); void load(); }} onCancel={() => setReloading(false)} />}
    {leave && <ConfirmDialog title={t("pricing.leaveTitle")} message={t("pricing.leaveMessage")} confirmLabel={t("pricing.leaveConfirm")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { leaving.current = true; setLeave(null); leave(); }} onCancel={() => setLeave(null)} />}
    {error !== null && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{pricingSaveError(error, t)}{retry && <p className="mt-2">{t("pricing.editor.retryHint")}</p>}{needsReload && <p className="mt-2">{t("pricing.room.reloadKeeps")}</p>}</div>}
    {notice && <p role="status" className="rounded-lg bg-emerald-50 p-4 text-emerald-900">{t(notice)}</p>}
    {loading ? <p role="status">{t("pricing.editor.loading")}</p> : !display && !empty ? null : !display ? <div className="rounded-xl border bg-white p-8"><h2 className="font-semibold">{t("pricing.room.notConfigured")}</h2>{setup && roomSetup.length ? <FirstPricingSetup propertyId={setup.propertyId} rooms={roomSetup} disabled={disabled} onDirty={() => setDirty(true)} onCreate={createInitial} /> : <p className="mt-2 text-sm text-gray-600">{t(setup ? "pricing.room.notReady" : "pricing.editor.setupUnavailable")}</p>}
      {retry && <button disabled={busy} className="mt-4 rounded-lg border px-4 py-2" onClick={() => void run()}>{t("pricing.editor.retry")}</button>}</div> : <>
      {editing && <div className="flex justify-between text-sm"><strong>{t("pricing.editor.baseNightlyPrices", { currency: display.currency })}</strong><span>{t(done ? "pricing.editor.statusSaved" : dirty ? "pricing.editor.statusUnsaved" : "pricing.editor.statusCurrent")}</span></div>}
      {!editing && <div className="rounded-xl border bg-white p-5"><h3 className="font-semibold">{t("pricing.room.notConfigured")}</h3>
        {setup && roomSetup.length ? <FirstPricingSetup propertyId={setup.propertyId} rooms={roomSetup} fixedCurrency={display.currency} disabled={disabled} onDirty={() => setDirty(true)} onCreate={createInitial} /> : <p className="mt-2 text-sm text-gray-600">{t(setup ? "pricing.room.notReady" : "pricing.editor.setupUnavailable")}</p>}
        {retry && <button disabled={busy} className="mt-4 rounded-lg border px-4 py-2" onClick={() => void run()}>{t("pricing.editor.retry")}</button>}</div>}
      {shownRooms.map(([room, ri]) => <div key={room.roomTypeId} className="overflow-hidden rounded-xl border bg-white">
        <h2 className="border-b bg-gray-50 px-5 py-3 font-semibold">{roomName(room.roomTypeId, ri)}</h2>
        {addingOfferRoom === room.roomTypeId ? <div className="border-b p-5">
          {independentOffer ? <FirstPricingSetup propertyId={room.propertyId} rooms={[{ roomTypeId: room.roomTypeId, name: roomName(room.roomTypeId, ri), capacity: room.capacity }]} existingRoom={room} fixedCurrency={room.currency} disabled={disabled} onDirty={() => {}} onCreate={(input) => createInitial(input, true)} /> : <NewLinkedOffer room={room} disabled={disabled} onCreate={(input) => createInitial(input, true)} />}
          <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => { if (!disabled) { setAddingOfferRoom(null); setError(null); } }}>{t("pricing.editor.cancelOffer")}</button>
        </div> : <div className="flex gap-3 p-5">{[false, true].map((independent) => <button key={String(independent)} type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || hasPendingEntries} onClick={() => { if (!disabled && !hasPendingEntries) { setIndependentOffer(independent); setAddingOfferRoom(room.roomTypeId); setError(null); } }}>{t(independent ? "pricing.editor.addIndependentOffer" : "pricing.editor.addLinkedOffer")}</button>)}</div>}
        <PricingChildCharges room={room} label={roomName(room.roomTypeId, ri)} disabled={disabled || exclusiveEditPending}
          onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`children:${ri}`]: pending }))}
          onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
        {room.offers.map((offer, oi) => <div key={offer.id} className="grid gap-4 border-b p-5 last:border-0 sm:grid-cols-[1fr_2fr]">
          <div><h3 className="font-medium">{t("pricing.offerNumber", { number: oi + 1 })}</h3><p className="text-sm text-gray-500">{t(offer.price.kind === "linked" ? "pricing.editor.linkedRate" : "pricing.editor.independentRate")}</p></div>
          <div className="flex flex-wrap gap-3">{offer.price.kind === "independent" && baseAmounts(offer.price.calendar.base, t).map(([label, minor], ai) => <label key={ai} className="text-sm text-gray-600">{label}<input aria-label={`${offerLabel(room.roomTypeId, ri, oi)} ${label}`} inputMode="decimal" className="mt-1 block w-36 rounded-lg border px-3 py-2 text-gray-950 disabled:bg-gray-50" disabled={disabled || exclusiveEditPending}
            value={inputs[`${ri}:${oi}:${ai}`] ?? decimalAmount(minor, scale)} onChange={(event) => { setInputs({ ...inputs, [`${ri}:${oi}:${ai}`]: event.target.value }); setDirty(true); setNotice(""); }} /></label>)}
            {offer.price.kind === "independent" && !offer.price.calendar.base && <p className="text-sm text-gray-500">{t("pricing.editor.calendarOnly")}</p>}</div>
          <div className="sm:col-span-2"><PricingTerms propertyId={room.propertyId} client={client} roomTypeId={room.roomTypeId} offerId={offer.id} revision={offer.termsRevision}
            local={policyEdits[policyKey(room.roomTypeId, offer.id)]} disabled={disabled} blocked={hasPendingEntries}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`policy:${ri}:${oi}`]: pending }))}
            onApply={(terms) => { const key = policyKey(room.roomTypeId, offer.id); setPolicyEdits((previous) => ({ ...previous, [key]: {
              roomTypeId: room.roomTypeId, offerId: offer.id, expectedRevision: policyBases.current[key], cancellation: terms.cancellation, payment: terms.payment,
            } })); setDirty(true); setNotice(""); }} /></div>
          <PricingIncludedAdjustments room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} baseValue={inputs[`${ri}:${oi}:0`]} disabled={disabled} blocked={hasPendingEntries}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`included:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingDates room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`date:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingWeekdays room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`weekday:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingMonths room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`month:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingSeasons room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`season:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingMealPlan room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled} blocked={hasPendingEntries}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`mealPlan:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingMealCharges room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`meal:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingLinkedParent room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled} blocked={hasPendingEntries}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`parent:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingLinkedAdjustment room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`linked:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingStayOwnership room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled} blocked={hasPendingEntries}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`ownership:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingStayRules room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`stay:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingStayDates room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`stayDate:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
          <PricingStaySeasons room={room} offer={offer} label={offerLabel(room.roomTypeId, ri, oi)} disabled={disabled || exclusiveEditPending}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`staySeason:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); }} />
        </div>)}
        <details className="border-t px-5 py-3 text-sm text-gray-600"><summary className="cursor-pointer">{t("pricing.editor.retainedRules")}</summary>
          <p className="mt-2">{t("pricing.editor.adultAge", { age: room.children.adultFromAge })}</p>
          <p className="mt-2">{t("pricing.editor.reviewDates")}</p>
          {room.children.bands.map((band) => <p key={band.fromAge}>{t("pricing.editor.childBand", { from: band.fromAge, through: band.throughAge, amount: decimalAmount(band.nightlyMinor, scale), currency: display.currency })}</p>)}
          {room.offers.map((offer, oi) => <div key={offer.id} className="mt-2"><p>{t("pricing.offerNumber", { number: oi + 1 })} · {t(`pricing.meal.${offer.meal.kind}`)}</p>
            {offer.meal.charge.kind === "room" ? <p>{t("pricing.editor.mealPerRoom", { amount: decimalAmount(offer.meal.charge.amountMinor, scale), currency: display.currency })}</p> : <>
              <p>{t("pricing.editor.mealPerAdult", { amount: decimalAmount(offer.meal.charge.adultMinor, scale), currency: display.currency })}</p>
              {offer.meal.charge.childBandAmountsMinor.map((minor, bi) => <p key={bi}>{t("pricing.editor.mealPerChild", { from: room.children.bands[bi].fromAge, through: room.children.bands[bi].throughAge, amount: decimalAmount(minor, scale), currency: display.currency })}</p>)}
            </>}
            <PricingRules room={room} offer={offer} scale={scale} />
          </div>)}
        </details>
      </div>)}
      {editing && <><PricingStayPreview key={focusIndex} roomTypeId={focus} snapshot={display} inputs={inputs} disabled={disabled || hasPendingEntries} saved={false} roomNames={roomNames} />
      <footer className="space-y-2 border-t pt-5">
        {retry ? <button className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50" disabled={busy} onClick={() => void run()}>{t("pricing.editor.retry")}</button>
          : <button disabled={disabled || hasPendingEntries || !(dirty || stale)} className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50" onClick={save}>{t(busy ? "pricing.editor.saving" : "pricing.editor.save")}</button>}
        {done && <button type="button" className="ml-3 rounded-lg border px-5 py-2" onClick={() => void load()}>{t("pricing.room.editAgain")}</button>}
        <p className="text-sm text-gray-600">{t("pricing.editor.saveDeclaration")}</p>
      </footer>
      <p className="text-xs text-gray-500">{t("pricing.editor.keepOpen")}</p></>}
    </>}
  </section>;
}
/** Edits survive only when the server still has this room exactly as it was loaded (or still has no prices for
 * it) in the same currency, so a save after the reload never overwrites someone else's change to this room. */
function keptRoom(keep: Kept, saved: Awaited<ReturnType<Client["read"]>>) {
  const server = saved?.rooms.find((room) => room.roomTypeId === keep.room.roomTypeId);
  const unchanged = keep.base && server ? samePricingValue({ ...server, revision: 0 }, { ...keep.base, revision: 0 }) : !keep.base && !server;
  return unchanged && (!saved || saved.currency === keep.room.currency) ? keep.room : null;
}
