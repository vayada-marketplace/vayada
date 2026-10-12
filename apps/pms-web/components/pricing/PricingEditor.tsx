"use client";

import { useCallback, useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { pricingAmountStep, pricingCurrencyScale, parsePricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import { samePricingValue, type createReplacementPricingClient, type PricingSnapshot, type PricingTermsInput } from "@/services/api/replacementPricingClient";

import { baseAmounts, decimalAmount, editedSnapshot, errorText, type MessageKey, parseMinorInput, PricingError } from "./pricingAmounts";
import { financeNotReady, pricingSave, pricingSaveError } from "./savePricing";
import type { NewRoomPrices } from "./newRoomPrices";
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
import { PricingStayPreview } from "./PricingStayPreview";
import { MoreOptions } from "./MoreOptions";
import { StepPrice } from "./StepPrice";
import { StepSeasons } from "./StepSeasons";
import { StepWeekends } from "./StepWeekends";
import { addDays, deleteBlocker, deleteOption, mainOffer, missingPresets, moreOptionsSummary, normalNight, optionNames, sampleStay, type OptionTerms, type PresetKey } from "./stepPricing";
import { PresetWindow } from "./PresetWindow";
import { AddOptionButton, StepOptions } from "./StepOptions";
import { StepStayRules } from "./StepStayRules";
import { StepFirstPrices } from "./StepFirstPrices";
import { GuestPreview } from "./GuestPreview";
import { PriceCalendar } from "./PriceCalendar";
import { OptionWindow } from "./OptionWindow";
import Modal from "@/components/Modal";
import * as ui from "./pricingStyles";

type Client = ReturnType<typeof createReplacementPricingClient>;
type Room = PricingSnapshot["rooms"][number];
/** A room's unsaved edits carried over a reload after a refused save, with the room as it was loaded. */
type Kept = { room: Room; base: Room | null; terms: Record<string, PricingTermsInput>; bases: Record<string, string | null> };
/** The New room page (VAY-2147): prices for a room that does not exist yet, under a temporary id. The page's "Create Room
 * Type" saves them, so there is no Save here: `take` returns what is typed (null: nothing) or throws what stops it,
 * `actions` sit in the bar instead, `locked` holds every input while the page saves, `onPrices` says whether any are typed. */
type NewRoom = { take: MutableRefObject<(() => NewRoomPrices | null) | null>; actions: ReactNode; locked: boolean; onPrices?: (entered: boolean) => void };
/** One room's prices (the room page's Prices tab). Saving publishes the whole property, with every other room
 * exactly as read. `onAttention`: a leave confirmation is waiting, so the page should show this tab;
 * `onPublished`: prices were published; a new `refresh` reloads unless this room has unsaved work. */
export function PricingEditor({ client, roomNames = {}, roomFacts = {}, setup, roomTypeId: focus, onAttention, onPublished, refresh = 0, newRoom }: { client: Client; roomNames?: Record<string, string>; roomFacts?: Record<string, { size: number | null; photo: string | null }>; setup?: { propertyId: string; rooms: readonly SetupRoom[] }; roomTypeId: string; onAttention?: () => void; onPublished?: () => void; refresh?: number; newRoom?: NewRoom }) {
  const onPrices = newRoom?.onPrices;
  const callbacks = useRef({ onAttention, onPublished, onPrices });
  useEffect(() => { callbacks.current = { onAttention, onPublished, onPrices }; }, [onAttention, onPublished, onPrices]);
  const [policyEdits, setPolicyEdits] = useState<Record<string, PricingTermsInput>>({});
  const policyBases = useRef<Record<string, string | null>>({});
  const policyKey = (room: string, offer: string) => JSON.stringify([room, offer]);
  const [independentOffer, setIndependentOffer] = useState<boolean | null>(null);
  const [optionOpen, setOptionOpen] = useState<string | null>(null), [childrenOpen, setChildrenOpen] = useState(false);
  const [preset, setPreset] = useState<PresetKey | null>(null), [deleting, setDeleting] = useState<string | null>(null), [deleteError, setDeleteError] = useState<unknown>(null);
  // The guest preview's sample stay (a picked calendar night, or the next weekend), the calendar's month and option.
  const [stayStart, setStayStart] = useState<string | null>(null), [shownMonth, setShownMonth] = useState<string | null>(null), [previewOffer, setPreviewOffer] = useState<string | null>(null);
  const [addingOfferRoom, setAddingOfferRoom] = useState<string | null>(null);
  const [pendingEntries, setPendingEntries] = useState<Record<string, boolean>>({});
  const exclusiveEditPending = addingOfferRoom !== null || preset !== null || Object.entries(pendingEntries).some(([key, pending]) => (key.startsWith("ownership:") || key.startsWith("mealPlan:") || key.startsWith("parent:") || key.startsWith("included:") || key.startsWith("policy:")) && pending);
  const hasPendingEntries = addingOfferRoom !== null || preset !== null || Object.values(pendingEntries).some(Boolean);
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
      setAddingOfferRoom(null); setPreset(null); setDeleting(null); setDeleteError(null); setPendingEntries({}); setBaseRevision(saved?.revision ?? 0); setStale(!!saved?.stale); setInputs({}); setDirty(!!room); setNeedsReload(false); setDone(false);
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
  // A new room has no saved terms: every option it has was added here, with its terms.
  const wantedTerms = newRoom ? "" : (focusRoom?.offers ?? []).map(termsKey).join("\n");
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
  /** Returns the error it shows, so a window that asked (quick add) can show it too. */
  function createInitial(input: ReturnType<typeof firstPricingInput>, addToRoom = false, targetRoom: string | null = addingOfferRoom): unknown {
    if (locked.current || busy || retry || needsReload || done) return null;
    const otherRoom = input.configuration.roomTypeId !== focus;
    if (!addToRoom && (otherRoom || current && (current.currency !== input.configuration.currency || current.rooms.some((room) => room.roomTypeId === input.configuration.roomTypeId) ||
        !setup?.rooms.some((room) => room.roomTypeId === input.configuration.roomTypeId) || setup.propertyId !== input.configuration.propertyId))) {
      const failure = new PricingError("pricing.editor.errorUnconfiguredRoom");
      setError(failure); return failure;
    }
    let existing: PricingSnapshot | null, configuration = input.configuration;
    try {
      existing = current ? editedSnapshot(current, inputs) : null;
      if (addToRoom) {
        const target = existing?.rooms.find((room) => room.roomTypeId === targetRoom);
        const offer = input.configuration.offers.find((value) => value.id === input.terms.offerId);
        if (!target || !offer || target.roomTypeId !== input.terms.roomTypeId || target.roomTypeId !== input.configuration.roomTypeId || target.offers.some((value) => value.id === offer.id)) throw new PricingError("pricing.editor.errorNewOffer");
        const appended = parsePricingConfiguration({ ...target, offers: [...target.offers, offer] });
        if (!appended) throw new PricingError("pricing.editor.errorNewOfferSettings");
        configuration = appended;
      }
    } catch (e) { setError(e); return e; }
    const room = { ...configuration, revision: baseRevision + 1 };
    const rooms = addToRoom ? existing!.rooms.map((value) => value.roomTypeId === room.roomTypeId ? room : value) : [...(existing?.rooms ?? []), room];
    const key = policyKey(input.terms.roomTypeId, input.terms.offerId);
    policyBases.current[key] = input.terms.expectedRevision;
    setPolicyEdits((previous) => ({ ...previous, [key]: input.terms }));
    setCurrent({ currency: room.currency, rooms, ownerReferences: existing?.ownerReferences ?? { finance: "" } });
    setInputs({}); setAddingOfferRoom(null); setPreset(null); setDirty(true);
    setNotice(newRoom ? "pricing.newRoom.noticeAdded" : "pricing.editor.noticeSetupAdded");
    return null;
  }
  /** Deletes an option from this room's draft; saving publishes the room without it. Typed prices are folded into
   * the room first, because they are kept by option position, which the deletion shifts. */
  function removeOption(offerId: string) {
    if (!current || hasPendingEntries || busy || retry || needsReload || done) return;
    try {
      const edited = editedSnapshot(current, inputs);
      const rooms = edited.rooms.map((room) => room.roomTypeId === focus ? deleteOption(room, offerId) : room);
      setCurrent({ ...current, rooms }); setInputs({});
      setPolicyEdits((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== policyKey(focus, offerId))));
      setOptionOpen(null); setDirty(true); setNotice("pricing.steps.delete.notice");
    } catch (e) { setDeleteError(e); }
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
  const firstPrices = useRef<(() => ReturnType<typeof firstPricingInput>) | null>(null);
  /** The New room page's prices: the room as edited and its options' terms; unapplied first answers count, an open
   * window or an amount that does not parse stops the create. While loading there are none ("Remove prices" reloads). */
  function takeNewRoomPrices(): NewRoomPrices | null {
    if (loading) return null;
    if (hasPendingEntries) throw new PricingError("pricing.newRoom.errorPending");
    const room = current && focusRoom ? editedSnapshot(current, inputs).rooms.find((value) => value.roomTypeId === focus) : undefined;
    if (room) return { room, terms: Object.values(policyEdits).filter((terms) => terms.roomTypeId === focus) };
    const first = dirty ? firstPrices.current?.() : undefined;
    return first ? { room: { ...first.configuration, revision: baseRevision + 1 }, terms: [first.terms] } : null;
  }
  const take = newRoom?.take;
  useEffect(() => { if (!take) return; take.current = takeNewRoomPrices; return () => { take.current = null; }; }); // Gone with the tab.
  useEffect(() => { callbacks.current.onPrices?.(dirty); }, [dirty]);
  const disabled = busy || retry || needsReload || done || !!newRoom?.locked, display = current;
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
    {!loading && (display || empty) && !editing && <div className={setup && roomSetup.length ? "space-y-4" : ui.card}>
      <div className="flex items-center justify-between gap-3"><h2 className={ui.cardHeading}>{t("pricing.room.title")}</h2><span className={`text-[11px] font-medium ${newRoom ? "text-gray-500" : "text-amber-600"}`}>{t(newRoom ? "pricing.newRoom.optional" : "pricing.room.notConfigured")}</span></div>
      {setup && roomSetup.length ? <StepFirstPrices propertyId={setup.propertyId} rooms={roomSetup} fixedCurrency={display?.currency} disabled={disabled} onDirty={() => setDirty(true)} onCreate={createInitial} pending={newRoom ? firstPrices : undefined} /> : <p className={ui.text}>{t(setup ? "pricing.room.notReady" : "pricing.editor.setupUnavailable")}</p>}
      {retry && <button disabled={busy} className={ui.secondaryButton} onClick={() => void run()}>{t("pricing.editor.retry")}</button>}</div>}
    {!loading && display && shownRooms.map(([room, ri]) => {
      const main = mainOffer(room), mi = room.offers.indexOf(main), mainLabel = offerLabel(room.roomTypeId, ri, mi);
      let edited: Room | null = null;
      try { edited = editedSnapshot(display, inputs).rooms[ri]; } catch { edited = null; }
      const prices = Object.fromEntries(room.offers.map((offer) => [offer.id, edited ? normalNight(edited, offer.id) : null]));
      // The main option's month and date prices and its stay rules sit under More options; its other settings, and
      // every other option's, in that option's Edit window. An unapplied entry keeps its place open.
      const pendingIn = (keys: readonly string[]) => keys.some((key) => pendingEntries[key]);
      const moreKeys = ["month", "date", "stay", "stayDate", "staySeason"].map((key) => `${key}:${ri}:${mi}`);
      const badPrice = (oi: number) => Object.entries(inputs).some(([key, value]) => {
        if (!key.startsWith(`${ri}:${oi}:`)) return false;
        try { parseMinorInput(value, scale, false, pricingAmountStep(room.currency)); return false; } catch { return true; }
      });
      const windowKeys = (oi: number) => (oi === mi ? ["policy", "included", "mealPlan", "meal"] : ["policy", "included", "date", "weekday", "month", "season", "mealPlan", "meal", "parent", "linked", "ownership", "stay", "stayDate", "staySeason"]).map((key) => `${key}:${ri}:${oi}`);
      const cancelAdding = () => { if (!disabled) { setAddingOfferRoom(null); setError(null); } };
      const group = (title: string) => <h3 className={`pt-2 ${ui.cardHeading}`}>{title}</h3>;
      const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const sample = sampleStay(edited ?? room, today), stayNights = Math.round((Date.parse(sample.checkOut) - Date.parse(sample.checkIn)) / 86400000);
      const stay = stayStart ? { checkIn: stayStart, checkOut: addDays(stayStart, stayNights) } : sample;
      const previewId = previewOffer && room.offers.some((offer) => offer.id === previewOffer) ? previewOffer : main.id;
      return <div key={room.roomTypeId} className="grid items-start gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
        <StepPrice room={room} roomIndex={ri} offerIndex={mi} label={mainLabel} inputs={inputs} disabled={disabled || exclusiveEditPending}
          onInput={(key, value) => { setInputs((previous) => ({ ...previous, [key]: value })); setDirty(true); setNotice(""); }} />
        <StepSeasons room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onChange={changeRoom(ri)} onPending={pend(`stepSeason:${ri}`)} />
        <StepWeekends room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onChange={changeRoom(ri)} onPending={pend(`stepWeekday:${ri}`)} />
        <StepOptions room={room} names={names} terms={optionTerms} prices={prices} disabled={disabled}
          termsFailed={room.offers.some((offer) => !policyEdits[policyKey(focus, offer.id)] && savedTerms[termsKey(offer)] === null)} onRetryTerms={retryTerms} onEdit={(offerId) => setOptionOpen(offerId)}
          add={<>
            {missingPresets(room, optionTerms).slice(0, 3).map((key) => <AddOptionButton key={key} label={t(`pricing.steps.preset.button.${key}`)} disabled={disabled || hasPendingEntries}
              onClick={() => { if (!disabled && !hasPendingEntries) { setPreset(key); setError(null); } }} />)}
            <AddOptionButton label={t("pricing.steps.options.own")} disabled={disabled || hasPendingEntries}
              onClick={() => { if (!disabled && !hasPendingEntries) { setIndependentOffer(null); setAddingOfferRoom(room.roomTypeId); setError(null); } }} />
          </>} />
        <StepStayRules room={room} names={names} disabled={disabled || exclusiveEditPending} onChange={changeRoom(ri)} onEditChildren={() => setChildrenOpen(true)}>
          <OptionWindow open={childrenOpen} title={t("pricing.steps.rules.childrenTitle")} closable={!pendingEntries[`children:${ri}`]} onClose={() => setChildrenOpen(false)}>
            <PricingChildCharges room={room} label={roomName(room.roomTypeId, ri)} disabled={disabled || exclusiveEditPending} onPending={pend(`children:${ri}`)} onChange={changeRoom(ri)} />
          </OptionWindow>
        </StepStayRules>
        <MoreOptions keepOpen={pendingIn(moreKeys)} summary={moreOptionsSummary(room, t)}>
          {group(t("pricing.steps.more.prices"))}
          <div className="space-y-2">
            <PricingMonths room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`month:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            <PricingDates room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`date:${ri}:${mi}`)} onChange={changeRoom(ri)} />
          </div>
          {group(t("pricing.steps.more.rules"))}
          <div className="space-y-2">
            <PricingStayRules room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`stay:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            <PricingStayDates room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`stayDate:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            <PricingStaySeasons room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`staySeason:${ri}:${mi}`)} onChange={changeRoom(ri)} />
          </div>
          {group(t("pricing.steps.more.check"))}
          <PricingStayPreview key={focusIndex} roomTypeId={focus} names={names} snapshot={display} inputs={inputs} disabled={disabled || hasPendingEntries} saved={false} roomNames={roomNames} />
        </MoreOptions>
        {room.offers.map((offer, oi) => {
          const label = offerLabel(room.roomTypeId, ri, oi), other = oi !== mi;
          const blocker = deleteBlocker(room, offer.id);
          return <OptionWindow key={offer.id} open={optionOpen === offer.id} title={names[offer.id] ?? ""} closable={!pendingIn(windowKeys(oi)) && !(oi !== mi && badPrice(oi))} onClose={() => { setOptionOpen(null); setDeleteError(null); }}
            footer={deleteError && optionOpen === offer.id ? <p role="alert" className={ui.errorText}>{errorText(deleteError, t, "pricing.steps.delete.errorBlocked")}</p> : blocker ? <p className={ui.help}>{blocker.kind === "only" ? t("pricing.steps.delete.only") : t("pricing.steps.delete.dependents", { names: blocker.ids.map((id) => names[id] ?? "").join(", ") })}</p>
              : <button type="button" disabled={disabled || hasPendingEntries} onClick={() => setDeleting(offer.id)} className="text-[13px] font-medium text-red-600 hover:text-red-700 disabled:opacity-50">{t("pricing.steps.delete.button")}</button>}>
            {group(t("pricing.steps.option.price"))}
            {other && offer.price.kind === "independent" && <div><p className={ui.label}>{t("pricing.editor.baseNightlyPrices", { currency: display.currency })}</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">{baseAmounts(offer.price.calendar.base, t).map(([name, minor], ai) => <label key={ai} className="block"><span className="mb-1.5 block text-[11px] text-gray-500">{name}</span><input aria-label={`${label} ${name}`} inputMode="decimal" className={ui.input} disabled={disabled || exclusiveEditPending}
                value={inputs[`${ri}:${oi}:${ai}`] ?? decimalAmount(minor, scale)} onChange={(event) => { setInputs({ ...inputs, [`${ri}:${oi}:${ai}`]: event.target.value }); setDirty(true); setNotice(""); }} /></label>)}</div>
              {!offer.price.calendar.base && <p className={ui.hint}>{t("pricing.editor.calendarOnly")}</p>}</div>}
            <div className="space-y-2">
              <PricingIncludedAdjustments room={room} offer={offer} label={label} baseValue={inputs[`${ri}:${oi}:0`]} disabled={disabled} blocked={hasPendingEntries} onPending={pend(`included:${ri}:${oi}`)} onChange={changeRoom(ri)} />
              <PricingLinkedParent room={room} offer={offer} names={names} label={label} disabled={disabled} blocked={hasPendingEntries} onPending={pend(`parent:${ri}:${oi}`)} onChange={changeRoom(ri)} />
              <PricingLinkedAdjustment room={room} offer={offer} names={names} label={label} disabled={disabled || exclusiveEditPending} onPending={pend(`linked:${ri}:${oi}`)} onChange={changeRoom(ri)} />
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
        {preset && <PresetWindow room={room} preset={preset} names={names} mainTerms={optionTerms[main.id]} disabled={disabled}
          onAdd={(input) => createInitial(input, true, room.roomTypeId)} onClose={() => setPreset(null)} />}
        {deleting && room.offers.some((offer) => offer.id === deleting) && <ConfirmDialog title={t("pricing.steps.delete.title", { name: names[deleting] ?? "" })} message={t("pricing.steps.delete.message")}
          confirmLabel={t("pricing.steps.delete.confirm")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { const id = deleting; setDeleting(null); removeOption(id); }} onCancel={() => setDeleting(null)} />}
        {addingOfferRoom === room.roomTypeId && <Modal onClose={cancelAdding} ariaLabel={t("pricing.steps.own.title")} maxWidth="xl"
          footer={<button type="button" className={ui.secondaryButton} disabled={disabled} onClick={cancelAdding}>{t("pricing.editor.cancelOffer")}</button>}>
          <h2 className={ui.stepTitle}>{t("pricing.steps.own.title")}</h2>
          <div className="mt-3 flex flex-wrap gap-2">{[false, true].map((independent) => <button key={String(independent)} type="button" aria-pressed={independentOffer === independent} disabled={disabled}
            className={ui.chip(independentOffer === independent)} onClick={() => setIndependentOffer(independent)}>{t(independent ? "pricing.steps.own.independent" : "pricing.steps.own.linked")}</button>)}</div>
          <div className="mt-4">{independentOffer === true ? <FirstPricingSetup propertyId={room.propertyId} rooms={[{ roomTypeId: room.roomTypeId, name: roomName(room.roomTypeId, ri), capacity: room.capacity }]} existingRoom={room} fixedCurrency={room.currency} disabled={disabled} onDirty={() => {}} onCreate={(input) => createInitial(input, true)} />
            : independentOffer === false ? <NewLinkedOffer room={room} names={names} disabled={disabled} onCreate={(input) => createInitial(input, true)} /> : <p className={ui.help}>{t("pricing.steps.own.choose")}</p>}</div>
        </Modal>}
        </div>
        <aside className="min-w-0 space-y-4">
          <GuestPreview room={edited} facts={{ name: roomName(room.roomTypeId, ri), ...(roomFacts[room.roomTypeId] ?? { size: null, photo: null }) }} names={names} terms={optionTerms}
            stay={stay} today={today} selected={previewId} onSelect={setPreviewOffer} />
          <PriceCalendar room={edited} offerId={previewId} optionName={names[previewId] ?? ""} month={shownMonth ?? stay.checkIn.slice(0, 7)} stay={stay}
            onMonth={setShownMonth} onPick={(date) => { setStayStart(date); setShownMonth(date.slice(0, 7)); }} />
        </aside>
      </div>;
    })}
    {!loading && editing && !newRoom && <p className={`text-right ${ui.hint}`}>{t("pricing.editor.keepOpen")}</p>}
    {/* Pressing Save is the declaration, so its text stays in the (sticky) bar beside the button. On the New room page
        the page's "Create Room Type" saves, and declares once prices are typed. */}
    {newRoom ? <div className={`flex-wrap ${ui.actionBar}`}>
      {dirty && <p className="w-full text-[11px] text-gray-500 md:mr-auto md:w-auto">{t("pricing.newRoom.declaration")}<span className="ml-2 font-medium text-amber-600">{t("pricing.newRoom.status")}</span></p>}
      {(dirty || error !== null) && <button type="button" className={ui.actionBarButton} disabled={loading || disabled} onClick={() => { if (dirty) setReloading(true); else void load(); }}>{t(dirty ? "pricing.newRoom.remove" : "pricing.editor.reload")}</button>}
      {newRoom.actions}
    </div> : <div className={`flex-wrap ${ui.actionBar}`}>
      {!loading && editing && <p id={declarationId} className="w-full text-[11px] text-gray-500 md:mr-auto md:w-auto">{t("pricing.editor.saveDeclaration")}
        <span className={`ml-2 font-medium ${done ? "text-green-600" : dirty ? "text-amber-600" : "text-gray-400"}`}>{t(done ? "pricing.editor.statusSaved" : dirty ? "pricing.editor.statusUnsaved" : "pricing.editor.statusCurrent")}</span></p>}
      <button type="button" className={ui.actionBarButton} disabled={loading || busy || retry} onClick={() => { if (keepsOnReload) reloadKeepingRoom(); else if (leaveRisk) setReloading(true); else void load(); }}>{t(cancels ? "common.cancel" : "pricing.editor.reload")}</button>
      {!loading && editing && done && <button type="button" className={ui.actionBarButton} onClick={() => void load()}>{t("pricing.room.editAgain")}</button>}
      {!loading && editing && (retry ? <button type="button" className={ui.actionBarPrimary} aria-describedby={declarationId} disabled={busy} onClick={() => void run()}>{t("pricing.editor.retry")}</button>
        : <button type="button" disabled={disabled || hasPendingEntries || !(dirty || stale)} className={ui.actionBarPrimary} aria-describedby={declarationId} onClick={save}>{t(busy ? "pricing.editor.saving" : "pricing.editor.save")}</button>)}
    </div>}
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
