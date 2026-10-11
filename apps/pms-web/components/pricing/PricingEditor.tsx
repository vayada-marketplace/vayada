"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { pricingAmountStep, pricingCurrencyScale, parsePricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import { samePricingValue, type createReplacementPricingClient, type PricingSnapshot, type PricingTermsInput } from "@/services/api/replacementPricingClient";

import { baseAmounts, decimalAmount, editedSnapshot, type MessageKey, parseMinorInput, PricingError } from "./pricingAmounts";
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
import { PricingSection } from "./PricingSection";
import { MoreOptions } from "./MoreOptions";
import { StepPrice } from "./StepPrice";
import { StepSeasons } from "./StepSeasons";
import { StepWeekends } from "./StepWeekends";
import { mainOffer, normalNight, optionNames, type OptionTerms } from "./stepPricing";
import { AddOptionButton, StepOptions } from "./StepOptions";
import { OptionWindow } from "./OptionWindow";
import Modal from "@/components/Modal";
import * as ui from "./pricingStyles";

type Client = ReturnType<typeof createReplacementPricingClient>;
type Room = PricingSnapshot["rooms"][number];
/** A room's unsaved edits carried over a reload after a refused save, with the room as it was loaded. */
type Kept = { room: Room; base: Room | null; terms: Record<string, PricingTermsInput>; bases: Record<string, string | null> };
/** One room's prices (the room page's Prices tab). Saving publishes the whole property, with every other room
 * exactly as read. `onAttention`: a leave confirmation is waiting, so the page should show this tab;
 * `onPublished`: prices were published; a new `refresh` reloads unless this room has unsaved work. */
export function PricingEditor({ client, roomNames = {}, setup, roomTypeId: focus, onAttention, onPublished, refresh = 0 }: { client: Client; roomNames?: Record<string, string>; setup?: { propertyId: string; rooms: readonly SetupRoom[] }; roomTypeId: string; onAttention?: () => void; onPublished?: () => void; refresh?: number }) {
  const callbacks = useRef({ onAttention, onPublished });
  useEffect(() => { callbacks.current = { onAttention, onPublished }; }, [onAttention, onPublished]);
  const [policyEdits, setPolicyEdits] = useState<Record<string, PricingTermsInput>>({});
  const policyBases = useRef<Record<string, string | null>>({});
  const policyKey = (room: string, offer: string) => JSON.stringify([room, offer]);
  const [independentOffer, setIndependentOffer] = useState<boolean | null>(null);
  const [optionOpen, setOptionOpen] = useState<string | null>(null);
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
  const declarationId = useId();
  const roomName = (roomTypeId: string, ri: number) => roomNames[roomTypeId] ?? t("pricing.roomNumber", { number: ri + 1 });
  const offerLabel = (roomTypeId: string, ri: number, oi: number) => t("pricing.roomOffer", { room: roomName(roomTypeId, ri), number: oi + 1 });
  // Options are named from their terms (the engine stores no name), so this room's terms are read up front, once per
  // offer and terms revision; every load reads them again. An unsaved terms change names its option at once.
  const [savedTerms, setSavedTerms] = useState<Record<string, OptionTerms | null>>({}), [termsAttempt, setTermsAttempt] = useState(0);
  const requestedTerms = useRef(new Set<string>());
  const loads = useRef(0);
  const load = useCallback(async (after?: { keep?: Kept }) => {
    const seq = ++loads.current, latest = () => alive.current && seq === loads.current; // An older read never overwrites a newer one.
    setLoading(true); setEmpty(false); setError(null);
    try {
      const saved = await client.read(); if (!latest()) return;
      const revision = (saved?.revision ?? 0) + 1, rooms = (saved?.rooms ?? []).map((room) => ({ ...room, revision }));
      const keep = after?.keep, kept = keep && keptRoom(keep, saved), room = kept && { ...kept, revision };
      setEmpty(saved === null && !room); setPolicyEdits(room ? keep!.terms : {}); loadedRooms.current = saved?.rooms ?? [];
      policyBases.current = { ...(room ? keep!.bases : {}), ...Object.fromEntries((saved?.rooms ?? []).flatMap((r) => r.offers.map((o) => [policyKey(r.roomTypeId, o.id), o.termsRevision]))) };
      setCurrent(saved || room ? { currency: saved?.currency ?? room!.currency, ownerReferences: { finance: saved?.ownerReferences.finance ?? "" },
        rooms: !room ? rooms : rooms.some((value) => value.roomTypeId === room.roomTypeId) ? rooms.map((value) => value.roomTypeId === room.roomTypeId ? room : value) : [...rooms, room] } : null);
      requestedTerms.current.clear(); setSavedTerms({});
      setAddingOfferRoom(null); setPendingEntries({}); setBaseRevision(saved?.revision ?? 0); setStale(!!saved?.stale); setInputs({}); setDirty(!!room); setNeedsReload(false); setDone(false);
      setNotice(room ? "pricing.room.noticeKept" : keep ? "pricing.room.noticeDropped" : saved?.stale ? "pricing.room.noticeStale" : "");
    } catch (e) { if (latest()) setError(e); }
    finally { if (latest()) setLoading(false); }
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
  const focusRoom = current?.rooms.find((room) => room.roomTypeId === focus);
  const termsKey = (offer: Room["offers"][number]) => JSON.stringify([focus, offer.id, offer.termsRevision]);
  const wantedTerms = (focusRoom?.offers ?? []).map(termsKey).join("\n");
  useEffect(() => {
    for (const key of wantedTerms ? wantedTerms.split("\n") : []) {
      if (requestedTerms.current.has(key)) continue;
      requestedTerms.current.add(key);
      const [roomTypeId, offerId, revision] = JSON.parse(key) as [string, string, string];
      void Promise.resolve().then(() => client.readTerms(roomTypeId, offerId, revision)).then((value) => value ?? null, () => null)
        .then((value) => { if (alive.current) setSavedTerms((previous) => ({ ...previous, [key]: value && { cancellation: value.cancellation, payment: value.payment } })); });
    }
  }, [client, wantedTerms, termsAttempt]);
  /** Reads the terms that failed again (step 4's Retry). */
  function retryTerms() {
    for (const [key, value] of Object.entries(savedTerms)) if (value === null) requestedTerms.current.delete(key);
    setSavedTerms((previous) => Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== null)));
    setTermsAttempt((attempt) => attempt + 1);
  }
  const optionTerms: Record<string, OptionTerms | undefined> = Object.fromEntries((focusRoom?.offers ?? []).map((offer) => [offer.id, policyEdits[policyKey(focus, offer.id)] ?? savedTerms[termsKey(offer)] ?? undefined]));
  const names = focusRoom ? optionNames(focusRoom, optionTerms, t) : {};
  const leaveRisk = hasPendingEntries || dirty || retry || busy;
  const risk = useRef(leaveRisk);
  // Unsaved work, or the saved prices still on show for review, outlast a page refresh. Declared before the
  // refresh effect, which reads it.
  useEffect(() => { risk.current = leaveRisk || done; }, [leaveRisk, done]);
  const seenRefresh = useRef(refresh);
  useEffect(() => { if (refresh === seenRefresh.current) return; seenRefresh.current = refresh; if (!risk.current) void load(); }, [refresh, load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (leaveRisk && !leaving.current) { event.preventDefault(); event.returnValue = ""; } };
    // Links stay in-app until this room has unsaved prices; then leaving asks first and leaves through the
    // document, so beforeunload does not ask a second time.
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || event.metaKey || event.ctrlKey || event.shiftKey || link.target === "_blank" || !leaveRisk) return;
      event.preventDefault(); event.stopPropagation();
      const href = link.href;
      setLeave(() => () => window.location.assign(href)); callbacks.current.onAttention?.();
    };
    const switchProperty = (event: Event) => {
      if (!leaveRisk) { leaving.current = true; return; }
      event.preventDefault(); // Hold the switch until the in-app dialog confirms; the dispatcher's `proceed` resumes it.
      const proceed = (event as CustomEvent<{ proceed?: () => void } | undefined>).detail?.proceed;
      if (proceed) { setLeave(() => proceed); callbacks.current.onAttention?.(); }
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
      callbacks.current.onPublished?.();
    }, financeNotReady);
  }
  const disabled = busy || retry || needsReload || done, display = current;
  // Edits survive a reload after a conflict; a denial (no permission) would only be refused again.
  const keepsOnReload = needsReload && dirty && !(error instanceof ApiErrorResponse && error.status === 403);
  const roomSetup = setup?.rooms.filter((room) => room.roomTypeId === focus) ?? [];
  const focusIndex = display ? display.rooms.findIndex((room) => room.roomTypeId === focus) : -1, editing = focusIndex >= 0;
  const shownRooms = (display?.rooms ?? []).map((room, ri) => [room, ri] as const).filter(([room]) => room.roomTypeId === focus);
  const scale = display ? pricingCurrencyScale(display.currency)! : 2;
  const warning = notice === "pricing.room.noticeStale" || notice === "pricing.room.noticeDropped";
  const changeRoom = (ri: number) => (nextRoom: Room) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); };
  const pend = (key: string) => (pending: boolean) => setPendingEntries((previous) => ({ ...previous, [key]: pending }));
  // While editing, the button beside Save discards this room's changes; otherwise it reloads pricing.
  const cancels = leaveRisk && !needsReload && !retry && !busy && !done;
  // Laid out as the Paper design's numbered steps; the other editors sit under More options. Cancel and Save at the bottom.
  return <section className="space-y-4">
    {error !== null && <div role="alert" className={ui.errorBanner}>{pricingSaveError(error, t)}{retry && <p className="mt-2">{t("pricing.editor.retryHint")}</p>}{keepsOnReload && <p className="mt-2">{t("pricing.room.reloadKeeps")}</p>}</div>}
    {notice && <p role="status" className={warning ? ui.warningBanner : ui.successBanner}>{t(notice)}</p>}
    {loading && <p role="status" className={ui.text}>{t("pricing.editor.loading")}</p>}
    {!loading && (display || empty) && !editing && <div className={ui.card}>
      <div className="flex items-center justify-between gap-3"><h2 className={ui.cardHeading}>{t("pricing.room.title")}</h2><span className="text-[11px] font-medium text-amber-600">{t("pricing.room.notConfigured")}</span></div>
      {setup && roomSetup.length ? <FirstPricingSetup propertyId={setup.propertyId} rooms={roomSetup} fixedCurrency={display?.currency} disabled={disabled} onDirty={() => setDirty(true)} onCreate={createInitial} /> : <p className={ui.text}>{t(setup ? "pricing.room.notReady" : "pricing.editor.setupUnavailable")}</p>}
      {retry && <button disabled={busy} className={ui.secondaryButton} onClick={() => void run()}>{t("pricing.editor.retry")}</button>}</div>}
    {!loading && display && shownRooms.map(([room, ri]) => {
      const main = mainOffer(room), mi = room.offers.indexOf(main), mainLabel = offerLabel(room.roomTypeId, ri, mi);
      let edited: Room | null = null;
      try { edited = editedSnapshot(display, inputs).rooms[ri]; } catch { edited = null; }
      const prices = Object.fromEntries(room.offers.map((offer) => [offer.id, edited ? normalNight(edited, offer.id) : null]));
      // The main option's month and date prices and its stay rules sit under More options; its other settings, and
      // every other option's, in that option's Edit window. An unapplied entry keeps its place open.
      const pendingIn = (keys: readonly string[]) => keys.some((key) => pendingEntries[key]);
      const moreKeys = [`children:${ri}`, ...["month", "date", "stay", "stayDate", "staySeason"].map((key) => `${key}:${ri}:${mi}`)];
      const badPrice = (oi: number) => Object.entries(inputs).some(([key, value]) => {
        if (!key.startsWith(`${ri}:${oi}:`)) return false;
        try { parseMinorInput(value, scale, false, pricingAmountStep(room.currency)); return false; } catch { return true; }
      });
      const windowKeys = (oi: number) => (oi === mi ? ["policy", "included", "mealPlan", "meal"] : ["policy", "included", "date", "weekday", "month", "season", "mealPlan", "meal", "parent", "linked", "ownership", "stay", "stayDate", "staySeason"]).map((key) => `${key}:${ri}:${oi}`);
      const cancelAdding = () => { if (!disabled) { setAddingOfferRoom(null); setError(null); } };
      const group = (title: string) => <h3 className={`pt-2 ${ui.cardHeading}`}>{title}</h3>;
      return <div key={room.roomTypeId} className="space-y-4">
        <StepPrice room={room} roomIndex={ri} offerIndex={mi} label={mainLabel} inputs={inputs} disabled={disabled || exclusiveEditPending}
          onInput={(key, value) => { setInputs((previous) => ({ ...previous, [key]: value })); setDirty(true); setNotice(""); }} />
        <StepSeasons room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onChange={changeRoom(ri)} onPending={pend(`stepSeason:${ri}`)} />
        <StepWeekends room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onChange={changeRoom(ri)} onPending={pend(`stepWeekday:${ri}`)} />
        <StepOptions room={room} names={names} terms={optionTerms} prices={prices} disabled={disabled}
          termsFailed={room.offers.some((offer) => !policyEdits[policyKey(focus, offer.id)] && savedTerms[termsKey(offer)] === null)} onRetryTerms={retryTerms} onEdit={(offerId) => setOptionOpen(offerId)}
          add={<AddOptionButton label={t("pricing.steps.options.own")} disabled={disabled || hasPendingEntries}
            onClick={() => { if (!disabled && !hasPendingEntries) { setIndependentOffer(null); setAddingOfferRoom(room.roomTypeId); setError(null); } }} />} />
        <MoreOptions keepOpen={pendingIn(moreKeys)}>
          <PricingChildCharges room={room} label={roomName(room.roomTypeId, ri)} disabled={disabled || exclusiveEditPending} onPending={pend(`children:${ri}`)} onChange={changeRoom(ri)} />
          <div className="space-y-2">
            <PricingMonths room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`month:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            <PricingDates room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`date:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            <PricingStayRules room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`stay:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            <PricingStayDates room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`stayDate:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            <PricingStaySeasons room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`staySeason:${ri}:${mi}`)} onChange={changeRoom(ri)} />
          </div>
          <PricingSection title={t("pricing.editor.retainedRules")}>
            <p>{t("pricing.editor.adultAge", { age: room.children.adultFromAge })}</p>
            <p>{t("pricing.editor.reviewDates")}</p>
            {room.children.bands.map((band) => <p key={band.fromAge}>{t("pricing.editor.childBand", { from: band.fromAge, through: band.throughAge, amount: decimalAmount(band.nightlyMinor, scale), currency: display.currency })}</p>)}
            {room.offers.map((offer, oi) => <div key={offer.id} className="pt-2"><p className="font-semibold text-gray-900">{t("pricing.offerNumber", { number: oi + 1 })} · {t(`pricing.meal.${offer.meal.kind}`)}</p>
              {offer.meal.charge.kind === "room" ? <p>{t("pricing.editor.mealPerRoom", { amount: decimalAmount(offer.meal.charge.amountMinor, scale), currency: display.currency })}</p> : <>
                <p>{t("pricing.editor.mealPerAdult", { amount: decimalAmount(offer.meal.charge.adultMinor, scale), currency: display.currency })}</p>
                {offer.meal.charge.childBandAmountsMinor.map((minor, bi) => <p key={bi}>{t("pricing.editor.mealPerChild", { from: room.children.bands[bi].fromAge, through: room.children.bands[bi].throughAge, amount: decimalAmount(minor, scale), currency: display.currency })}</p>)}
              </>}
              <PricingRules room={room} offer={offer} scale={scale} />
            </div>)}
          </PricingSection>
        </MoreOptions>
        {room.offers.map((offer, oi) => {
          const label = offerLabel(room.roomTypeId, ri, oi), other = oi !== mi;
          return <OptionWindow key={offer.id} open={optionOpen === offer.id} title={names[offer.id] ?? ""} closable={!pendingIn(windowKeys(oi)) && !(oi !== mi && badPrice(oi))} onClose={() => setOptionOpen(null)}>
            {group(t("pricing.steps.option.price"))}
            {other && offer.price.kind === "independent" && <div><p className={ui.label}>{t("pricing.editor.baseNightlyPrices", { currency: display.currency })}</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">{baseAmounts(offer.price.calendar.base, t).map(([name, minor], ai) => <label key={ai} className="block"><span className="mb-1.5 block text-[11px] text-gray-500">{name}</span><input aria-label={`${label} ${name}`} inputMode="decimal" className={ui.input} disabled={disabled || exclusiveEditPending}
                value={inputs[`${ri}:${oi}:${ai}`] ?? decimalAmount(minor, scale)} onChange={(event) => { setInputs({ ...inputs, [`${ri}:${oi}:${ai}`]: event.target.value }); setDirty(true); setNotice(""); }} /></label>)}</div>
              {!offer.price.calendar.base && <p className={ui.hint}>{t("pricing.editor.calendarOnly")}</p>}</div>}
            <div className="space-y-2">
              <PricingIncludedAdjustments room={room} offer={offer} label={label} baseValue={inputs[`${ri}:${oi}:0`]} disabled={disabled} blocked={hasPendingEntries} onPending={pend(`included:${ri}:${oi}`)} onChange={changeRoom(ri)} />
              <PricingLinkedParent room={room} offer={offer} label={label} disabled={disabled} blocked={hasPendingEntries} onPending={pend(`parent:${ri}:${oi}`)} onChange={changeRoom(ri)} />
              <PricingLinkedAdjustment room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`linked:${ri}:${oi}`)} onChange={changeRoom(ri)} />
              {other && <>
                <PricingSeasons room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`season:${ri}:${oi}`)} onChange={changeRoom(ri)} />
                <PricingWeekdays room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`weekday:${ri}:${oi}`)} onChange={changeRoom(ri)} />
                <PricingMonths room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`month:${ri}:${oi}`)} onChange={changeRoom(ri)} />
                <PricingDates room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`date:${ri}:${oi}`)} onChange={changeRoom(ri)} />
              </>}
            </div>
            {group(t("pricing.steps.option.meals"))}
            <div className="space-y-2">
              <PricingMealPlan room={room} offer={offer} label={label} disabled={disabled} blocked={hasPendingEntries} onPending={pend(`mealPlan:${ri}:${oi}`)} onChange={changeRoom(ri)} />
              <PricingMealCharges room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`meal:${ri}:${oi}`)} onChange={changeRoom(ri)} />
            </div>
            {group(t("pricing.steps.option.terms"))}
            <PricingTerms propertyId={room.propertyId} client={client} roomTypeId={room.roomTypeId} offerId={offer.id} revision={offer.termsRevision}
              local={policyEdits[policyKey(room.roomTypeId, offer.id)]} disabled={disabled} blocked={hasPendingEntries}
              onPending={pend(`policy:${ri}:${oi}`)}
              onApply={(terms) => { const key = policyKey(room.roomTypeId, offer.id); setPolicyEdits((previous) => ({ ...previous, [key]: {
                roomTypeId: room.roomTypeId, offerId: offer.id, expectedRevision: policyBases.current[key], cancellation: terms.cancellation, payment: terms.payment,
              } })); setDirty(true); setNotice(""); }} />
            {other && <>
              {group(t("pricing.steps.option.rules"))}
              <div className="space-y-2">
                <PricingStayOwnership room={room} offer={offer} label={label} disabled={disabled} blocked={hasPendingEntries} onPending={pend(`ownership:${ri}:${oi}`)} onChange={changeRoom(ri)} />
                <PricingStayRules room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`stay:${ri}:${oi}`)} onChange={changeRoom(ri)} />
                <PricingStayDates room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`stayDate:${ri}:${oi}`)} onChange={changeRoom(ri)} />
                <PricingStaySeasons room={room} offer={offer} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`staySeason:${ri}:${oi}`)} onChange={changeRoom(ri)} />
              </div>
            </>}
          </OptionWindow>;
        })}
        {addingOfferRoom === room.roomTypeId && <Modal onClose={cancelAdding} ariaLabel={t("pricing.steps.own.title")} maxWidth="xl"
          footer={<button type="button" className={ui.secondaryButton} disabled={disabled} onClick={cancelAdding}>{t("pricing.editor.cancelOffer")}</button>}>
          <h2 className={ui.stepTitle}>{t("pricing.steps.own.title")}</h2>
          <div className="mt-3 flex flex-wrap gap-2">{[false, true].map((independent) => <button key={String(independent)} type="button" aria-pressed={independentOffer === independent} disabled={disabled}
            className={ui.chip(independentOffer === independent)} onClick={() => setIndependentOffer(independent)}>{t(independent ? "pricing.steps.own.independent" : "pricing.steps.own.linked")}</button>)}</div>
          <div className="mt-4">{independentOffer === true ? <FirstPricingSetup propertyId={room.propertyId} rooms={[{ roomTypeId: room.roomTypeId, name: roomName(room.roomTypeId, ri), capacity: room.capacity }]} existingRoom={room} fixedCurrency={room.currency} disabled={disabled} onDirty={() => {}} onCreate={(input) => createInitial(input, true)} />
            : independentOffer === false ? <NewLinkedOffer room={room} disabled={disabled} onCreate={(input) => createInitial(input, true)} /> : <p className={ui.help}>{t("pricing.steps.own.choose")}</p>}</div>
        </Modal>}
      </div>;
    })}
    {!loading && editing && display && <PricingStayPreview key={focusIndex} roomTypeId={focus} snapshot={display} inputs={inputs} disabled={disabled || hasPendingEntries} saved={false} roomNames={roomNames} />}
    {!loading && editing && <p className={`text-right ${ui.hint}`}>{t("pricing.editor.keepOpen")}</p>}
    {/* Pressing Save is the declaration, so its text stays in the (sticky) bar beside the button. */}
    <div className={`flex-wrap ${ui.actionBar}`}>
      {!loading && editing && <p id={declarationId} className="w-full text-[11px] text-gray-500 md:mr-auto md:w-auto">{t("pricing.editor.saveDeclaration")}
        <span className={`ml-2 font-medium ${done ? "text-green-600" : dirty ? "text-amber-600" : "text-gray-400"}`}>{t(done ? "pricing.editor.statusSaved" : dirty ? "pricing.editor.statusUnsaved" : "pricing.editor.statusCurrent")}</span></p>}
      <button type="button" className={ui.actionBarButton} disabled={loading || busy || retry} onClick={() => { if (keepsOnReload) reloadKeepingRoom(); else if (leaveRisk) setReloading(true); else void load(); }}>{t(cancels ? "common.cancel" : "pricing.editor.reload")}</button>
      {!loading && editing && done && <button type="button" className={ui.actionBarButton} onClick={() => void load()}>{t("pricing.room.editAgain")}</button>}
      {!loading && editing && (retry ? <button type="button" className={ui.actionBarPrimary} aria-describedby={declarationId} disabled={busy} onClick={() => void run()}>{t("pricing.editor.retry")}</button>
        : <button type="button" disabled={disabled || hasPendingEntries || !(dirty || stale)} className={ui.actionBarPrimary} aria-describedby={declarationId} onClick={save}>{t(busy ? "pricing.editor.saving" : "pricing.editor.save")}</button>)}
    </div>
    {/* Last, so they open above an option's window. */}
    {reloading && <ConfirmDialog title={t(cancels ? "pricing.steps.discardTitle" : "pricing.reloadTitle")} message={t(cancels ? "pricing.steps.discardMessage" : "pricing.reloadMessage")} confirmLabel={t(cancels ? "pricing.steps.discardConfirm" : "pricing.reloadConfirm")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { setReloading(false); void load(); }} onCancel={() => setReloading(false)} />}
    {leave && <ConfirmDialog title={t("pricing.leaveTitle")} message={t("pricing.leaveMessage")} confirmLabel={t("pricing.leaveConfirm")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { leaving.current = true; setLeave(null); leave(); }} onCancel={() => setLeave(null)} />}
  </section>;
}
/** Edits survive only when the server still has this room exactly as it was loaded (or still has no prices for
 * it) in the same currency, so a save after the reload never overwrites someone else's change to this room. */
function keptRoom(keep: Kept, saved: Awaited<ReturnType<Client["read"]>>) {
  const server = saved?.rooms.find((room) => room.roomTypeId === keep.room.roomTypeId);
  const unchanged = keep.base && server ? samePricingValue({ ...server, revision: 0 }, { ...keep.base, revision: 0 }) : !keep.base && !server;
  return unchanged && (!saved || saved.currency === keep.room.currency) ? keep.room : null;
}
