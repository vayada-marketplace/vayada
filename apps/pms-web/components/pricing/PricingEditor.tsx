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
import type { KeptNewRoomPrices } from "./keptNewRoomPrices";
import { FirstPricingSetup, type SetupRoom, type firstPricingInput } from "./FirstPricingSetup";
import { PricingTerms } from "./PricingTerms";
import { PricingManualMethodsProvider, useLoadedPricingManualMethods } from "./pricingManualMethods";
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
import { StepSeasons } from "./StepSeasons";
import { StepWeekends } from "./StepWeekends";
import { addDays, deleteBlocker, deleteOption, mainOffer, missingPresets, money, normalNight, optionNames, sampleAdults, sampleStay, type OptionTerms, type PresetKey } from "./stepPricing";
import { lowestNightMinor, nightsWithoutPrice } from "./priceCalendarModel";
import { simpleRoom } from "./simplePricing";
import { StepRates } from "./StepRates";
import { StepExtras } from "./StepExtras";
import { keptSettings, MoreGroup, simpleSummary } from "./SimpleMoreOptions";
import { PresetWindow } from "./PresetWindow";
import { AddOptionButton, StepOptions } from "./StepOptions";
import { StepOpening } from "./StepOpening";
import { StepFirstPrices, type FirstPrices, type FirstThen } from "./StepFirstPrices";
import { paymentSettingsMethods } from "./pricingPaymentDefaults";
import type { PaymentMethod } from "./AcceptedPaymentMethods";
import { GuestPreview } from "./GuestPreview";
import { CalendarDaysIcon } from "@heroicons/react/24/outline";
import { PriceCalendar } from "./PriceCalendar";
import { NightPanel } from "./NightPanel";
import { pickNight, type NightSelection } from "./nightActions";
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
 * `onPublished`: prices were published; a new `refresh` reloads unless this room has unsaved work; `staleShown`: the
 * page already warns that the prices need saving again, so the editor does not repeat it. */
export function PricingEditor({ client, roomNames = {}, roomFacts = {}, setup, roomTypeId: focus, onAttention, onPublished, refresh = 0, newRoom, kept, onHandover, staleShown = false }: { client: Client; roomNames?: Record<string, string>; roomFacts?: Record<string, { size: number | null; photo: string | null }>; setup?: { propertyId: string; rooms: readonly SetupRoom[] }; roomTypeId: string; onAttention?: () => void; onPublished?: () => void; refresh?: number; newRoom?: NewRoom; kept?: KeptNewRoomPrices; onHandover?: (kept: boolean) => void; staleShown?: boolean }) {
  const manualMethods = useLoadedPricingManualMethods(client);
  const onPrices = newRoom?.onPrices;
  const callbacks = useRef({ onAttention, onPublished, onPrices, onHandover });
  useEffect(() => { callbacks.current = { onAttention, onPublished, onPrices, onHandover }; }, [onAttention, onPublished, onPrices, onHandover]);
  const [policyEdits, setPolicyEdits] = useState<Record<string, PricingTermsInput>>({});
  const policyBases = useRef<Record<string, string | null>>({});
  const policyKey = (room: string, offer: string) => JSON.stringify([room, offer]);
  const [independentOffer, setIndependentOffer] = useState<boolean | null>(null);
  const [optionOpen, setOptionOpen] = useState<string | null>(null), [childrenOpen, setChildrenOpen] = useState(false);
  const [preset, setPreset] = useState<PresetKey | null>(null), [deleting, setDeleting] = useState<string | null>(null), [deleteError, setDeleteError] = useState<unknown>(null);
  // The guest preview's sample stay (a picked calendar night, or the next weekend), the calendar's month and option.
  const [stayStart, setStayStart] = useState<string | null>(null), [shownMonth, setShownMonth] = useState<string | null>(null), [previewOffer, setPreviewOffer] = useState<string | null>(null);
  const [calendarAdults, setCalendarAdults] = useState<number | null>(null), [selection, setSelection] = useState<NightSelection | null>(null);
  const [addingOfferRoom, setAddingOfferRoom] = useState<string | null>(null);
  // A first price's ways to pay from Payment settings (undefined: loading; null: unknown), and a season window to open
  // once "Add a season" has added the first prices (VAY-2188).
  const [defaultMethods, setDefaultMethods] = useState<readonly PaymentMethod[] | null | undefined>(undefined), [seasonOnStart, setSeasonOnStart] = useState(false);
  const [pendingEntries, setPendingEntries] = useState<Record<string, boolean>>({});
  const exclusiveEditPending = addingOfferRoom !== null || preset !== null || Object.entries(pendingEntries).some(([key, pending]) => (key.startsWith("ownership:") || key.startsWith("mealPlan:") || key.startsWith("parent:") || key.startsWith("included:") || key.startsWith("policy:")) && pending);
  const hasPendingEntries = addingOfferRoom !== null || preset !== null || Object.values(pendingEntries).some(Boolean);
  // The switches' typed amounts belong to no option position, so deleting an option can't strand them.
  const pendingBesidesExtras = addingOfferRoom !== null || preset !== null || Object.entries(pendingEntries).some(([key, pending]) => pending && !key.startsWith("extras:") && !key.startsWith("rates:"));
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
  // Prices the New room page could not save for this room: the first load that reads pricing starts from them and
  // says why (VAY-2147).
  const handedOver = useRef(kept);
  const load = useCallback(async (requested?: { keep?: Kept }) => {
    const handover = requested ? undefined : handedOver.current, after = handover ? { keep: handedOverEdits(handover) } : requested;
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
      if (handover) handedOver.current = undefined;
      // A save that broke off without an answer may have published them after all: only when the published prices
      // are exactly these (someone else may have priced the room meanwhile).
      const published = saved?.rooms.find((value) => value.roomTypeId === focus);
      const savedAfterAll = handover?.outcomeUnknown && published && samePricingValue(savedPrices(published), savedPrices(handover.room));
      setNotice(room ? (handover ? "pricing.newRoom.noticeKept" : "pricing.room.noticeKept") : savedAfterAll ? "pricing.newRoom.noticeSavedAfterAll" : keep ? "pricing.room.noticeDropped" : saved?.stale ? "pricing.room.noticeStale" : "");
      // Why they were not saved, also when they no longer apply; `onHandover` says whether they were kept.
      if (handover && !savedAfterAll) setError(handover.error);
      if (handover) callbacks.current.onHandover?.(!!room);
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
   * the room first, because they are kept by option position, which the deletion shifts. A switch's unparsed amount
   * doesn't block it (see `pendingBesidesExtras`). */
  function removeOption(offerId: string) {
    if (!current || pendingBesidesExtras || busy || retry || needsReload || done) return;
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
    publish(edited, Object.values(policyEdits));
  }
  /** Publishes `edited` with these terms (see `pricingSave`); the room's first prices go through it straight away. */
  function publish(edited: PricingSnapshot, terms: PricingTermsInput[]) {
    const step = pricingSave(client, { snapshot: edited, baseRevision, terms });
    void run(async () => {
      const attached = await step();
      if (!alive.current) return;
      // Shows the saved prices for review; "Edit prices again" reloads, so the next save starts from the new revision.
      setCurrent(attached.snapshot); setDone(true); setDirty(false); setInputs({}); setPolicyEdits({}); setNotice("pricing.editor.noticeSaved");
      callbacks.current.onPublished?.();
    }, financeNotReady);
  }
  /** The room's first prices (VAY-2188): added to the draft with their options' terms, then saved at once, left
   * unsaved (the New room page saves them with the room), or left unsaved with the season window opening. */
  function startFirst(input: FirstPrices, then: FirstThen) {
    if (locked.current || busy || retry || needsReload || done) return;
    const configuration = input.configuration;
    if (configuration.roomTypeId !== focus || (current && (current.currency !== configuration.currency || current.rooms.some((room) => room.roomTypeId === focus))) ||
        !setup?.rooms.some((room) => room.roomTypeId === focus) || setup.propertyId !== configuration.propertyId) { setError(new PricingError("pricing.editor.errorUnconfiguredRoom")); return; }
    let existing: PricingSnapshot | null;
    try { existing = current ? editedSnapshot(current, inputs) : null; } catch (e) { setError(e); return; }
    const room = { ...configuration, revision: baseRevision + 1 };
    const snapshot = { currency: room.currency, rooms: [...(existing?.rooms ?? []), room], ownerReferences: existing?.ownerReferences ?? { finance: "" } };
    const edits = { ...policyEdits };
    for (const terms of input.terms) { const key = policyKey(terms.roomTypeId, terms.offerId); policyBases.current[key] = terms.expectedRevision; edits[key] = terms; }
    setPolicyEdits(edits); setCurrent(snapshot); setInputs({}); setDirty(true); setError(null);
    setNotice(newRoom ? "pricing.newRoom.noticeAdded" : then === "save" ? "" : "pricing.editor.noticeSetupAdded");
    if (then === "season") setSeasonOnStart(true);
    if (then === "save" && !newRoom) publish(snapshot, Object.values(edits));
  }
  const firstPrices = useRef<(() => FirstPrices) | null>(null);
  /** The New room page's prices: the room as edited and its options' terms; unapplied first answers count, an open
   * window or an amount that does not parse stops the create. While loading there are none ("Remove prices" reloads). */
  function takeNewRoomPrices(): NewRoomPrices | null {
    if (loading) return null;
    if (hasPendingEntries) throw new PricingError("pricing.newRoom.errorPending");
    const room = current && focusRoom ? editedSnapshot(current, inputs).rooms.find((value) => value.roomTypeId === focus) : undefined;
    if (room) return { room, terms: Object.values(policyEdits).filter((terms) => terms.roomTypeId === focus) };
    const first = dirty ? firstPrices.current?.() : undefined;
    return first ? { room: { ...first.configuration, revision: baseRevision + 1 }, terms: first.terms } : null;
  }
  const take = newRoom?.take;
  useEffect(() => { if (!take) return; take.current = takeNewRoomPrices; return () => { take.current = null; }; }); // Gone with the tab.
  useEffect(() => { callbacks.current.onPrices?.(dirty); }, [dirty]);
  const disabled = busy || retry || needsReload || done || !!newRoom?.locked, display = current;
  // Edits survive a reload after a conflict; a denial (no permission) would only be refused again.
  const keepsOnReload = needsReload && dirty && !(error instanceof ApiErrorResponse && error.status === 403);
  const roomSetup = setup?.rooms.filter((room) => room.roomTypeId === focus) ?? [];
  const firstTime = !loading && !focusRoom && roomSetup.length > 0;
  useEffect(() => {
    if (!firstTime) return;
    let live = true;
    void paymentSettingsMethods(client).then((methods) => { if (live) setDefaultMethods(methods); });
    return () => { live = false; };
  }, [firstTime, client]);
  const focusIndex = display ? display.rooms.findIndex((room) => room.roomTypeId === focus) : -1, editing = focusIndex >= 0;
  // The Save bar's "Guests pay from" (VAY-2280): the focused room's lowest standard or season night this year, over its rates.
  let guestsFrom = "";
  if (display && editing) try {
    const shown = editedSnapshot(display, inputs).rooms[focusIndex]!, rate = simpleRoom(shown, optionTerms)?.nonRefundable;
    const minor = lowestNightMinor(shown, [mainOffer(shown).id, ...(rate ? [rate.id] : [])], sampleAdults(shown), String(new Date().getFullYear()));
    if (minor) guestsFrom = t("pricing.bar.from", { amount: money(minor, shown.currency) });
  } catch { guestsFrom = ""; }
  const shownRooms = (display?.rooms ?? []).map((room, ri) => [room, ri] as const).filter(([room]) => room.roomTypeId === focus);
  const scale = display ? pricingCurrencyScale(display.currency)! : 2;
  const warning = notice === "pricing.room.noticeStale" || notice === "pricing.room.noticeDropped" || notice === "pricing.newRoom.noticeKept";
  const changeRoom = (ri: number) => (nextRoom: Room) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setNotice(""); };
  const pend = (key: string) => (pending: boolean) => setPendingEntries((previous) => ({ ...previous, [key]: pending }));
  /** The card's terms changes (cancellation, payment) as this session's terms edits, like an option window's. */
  const applyTerms = (roomTypeId: string) => (edits: readonly { offerId: string; terms: OptionTerms }[]) => {
    setPolicyEdits((previous) => ({ ...previous, ...Object.fromEntries(edits.map(({ offerId, terms }) => {
      const key = policyKey(roomTypeId, offerId);
      return [key, { roomTypeId, offerId, expectedRevision: policyBases.current[key] ?? null, cancellation: terms.cancellation, payment: terms.payment }];
    })) }));
    setDirty(true); setNotice("");
  };
  // While editing, the button beside Save discards this room's changes; otherwise it reloads pricing.
  const cancels = leaveRisk && !needsReload && !retry && !busy && !done;
  // Laid out as the Paper design's numbered steps; the other editors sit under More options. Cancel and Save at the bottom.
  return <PricingManualMethodsProvider value={manualMethods}><section className="space-y-4">
    {error !== null && <div role="alert" className={ui.errorBanner}>{pricingSaveError(error, t)}{retry && <p className="mt-2">{t("pricing.editor.retryHint")}</p>}{keepsOnReload && <p className="mt-2">{t("pricing.room.reloadKeeps")}</p>}</div>}
    {notice && !(staleShown && notice === "pricing.room.noticeStale") && <p role="status" className={warning ? ui.warningBanner : ui.successBanner}>{t(notice)}</p>}
    {loading && <p role="status" className={ui.text}>{t("pricing.editor.loading")}</p>}
    {!loading && (display || empty) && !editing && <div className={setup && roomSetup.length ? "space-y-4" : ui.card}>
      {/* The first-price form says itself that the room has no price (VAY-2188). */}
      {!(setup && roomSetup.length) && <div className="flex items-center justify-between gap-3"><h2 className={ui.cardHeading}>{t("pricing.room.title")}</h2><span className={`text-[11px] font-medium ${newRoom ? "text-gray-500" : "text-amber-600"}`}>{t(newRoom ? "pricing.newRoom.optional" : "pricing.room.notConfigured")}</span></div>}
      {/* No prices yet (VAY-2280): the calendar shows the nights waiting for one, beside "Start with one price". */}
      {setup && roomSetup.length > 0 && (() => {
        const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        return <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <PriceCalendar room={null} empty options={[]} offerId="" onOffer={() => undefined} adults={null} onAdults={() => undefined}
            month={shownMonth ?? today.slice(0, 7)} today={today} stay={{ checkIn: today, checkOut: today }} onMonth={setShownMonth} onPick={() => undefined} />
          <section aria-label={t("pricing.calendar.emptyTitle")} className="space-y-2.5 rounded-2xl border border-gray-200 bg-white p-5 md:p-6">
            <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-gray-100"><CalendarDaysIcon aria-hidden="true" className="h-5 w-5 text-gray-500" /></span>
            <h2 className="text-[16px] font-semibold text-gray-900">{t("pricing.calendar.emptyTitle")}</h2>
            <p className="text-[14px] leading-5 text-gray-600">{t("pricing.calendar.emptyText")}</p>
          </section>
        </div>;
      })()}
      {setup && roomSetup.length ? <StepFirstPrices propertyId={setup.propertyId} rooms={roomSetup} fixedCurrency={display?.currency} disabled={disabled} defaultMethods={defaultMethods} onDirty={() => setDirty(true)} onCreate={startFirst} pending={newRoom ? firstPrices : undefined} /> : <p className={ui.text}>{t(setup ? "pricing.room.notReady" : "pricing.editor.setupUnavailable")}</p>}
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
      const termsFailed = room.offers.some((offer) => !policyEdits[policyKey(focus, offer.id)] && savedTerms[termsKey(offer)] === null);
      const simple = simpleRoom(room, optionTerms), kept = keptSettings(room, simple);
      // VAY-2284: the calendar shows what guests pay for the rates, Flexible and Non-refundable; other options build on them.
      const rates = [{ id: main.id, name: t("pricing.calendar.flexible") }, ...(simple?.nonRefundable ? [{ id: simple.nonRefundable.id, name: t("pricing.calendar.nonRefundable") }] : [])];
      const calendarId = rates.some((rate) => rate.id === previewId) ? previewId : main.id;
      const gaps = edited ? nightsWithoutPrice(edited, main.id, sampleAdults(edited), today.slice(0, 7)) : 0;
      // The approved layout (VAY-2280): "Prices by date" first, then the price rules beside "What guests see".
      return <div key={room.roomTypeId} className="space-y-6">
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <PriceCalendar room={edited} options={rates} offerId={calendarId} onOffer={setPreviewOffer}
            adults={calendarAdults} onAdults={setCalendarAdults} month={shownMonth ?? stay.checkIn.slice(0, 7)} today={today} stay={stay} selection={selection}
            onMonth={setShownMonth} onPick={(date) => { const next = pickNight(selection, date); setSelection(next); setStayStart(next.from); setShownMonth(date.slice(0, 7)); }} />
          <NightPanel room={room} shown={edited} selection={selection} adults={calendarAdults ?? sampleAdults(room)} names={names} disabled={disabled || exclusiveEditPending}
            onClear={() => setSelection(null)} onChange={changeRoom(ri)} onPending={pend(`night:${ri}`)} />
        </div>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
        {kept && <p role="status" className={ui.infoBanner}>{t("pricing.simple.kept")}</p>}
        {/* The simple Prices card (VAY-2188): price, cancellation, the two switches and busier dates; everything else under More options. */}
        {/* "Price rules" (VAY-2280): the four steps behind every price in the calendar, and the nights no price covers. */}
        <div className="flex flex-wrap items-end justify-between gap-2 pt-2">
          <div className="space-y-1">
            <h2 className="text-[20px] font-bold text-gray-900">{t("pricing.rules.title")}</h2>
            <p className={ui.stepHint}>{t("pricing.rules.hint")}</p>
          </div>
          {gaps > 0 && <span role="status" className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-[13px] font-medium text-red-700">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" />{t(gaps === 1 ? "pricing.rules.gaps.one" : "pricing.rules.gaps.other", { count: gaps })}</span>}
        </div>
        <div className={ui.pricesCard}>
          <StepOpening room={room} disabled={disabled || exclusiveEditPending} onChange={changeRoom(ri)} onPending={pend(`opening:${ri}`)} />
          <StepSeasons room={room} offer={main} roomIndex={ri} offerIndex={mi} label={mainLabel} inputs={inputs} disabled={disabled || exclusiveEditPending} names={names}
            onInput={(key, value) => { setInputs((previous) => ({ ...previous, [key]: value })); setDirty(true); setNotice(""); }} onEditMeal={() => setOptionOpen(main.id)}
            onEditChildren={() => setChildrenOpen(true)} shown={edited}
            onPriceMode={(next) => { changeRoom(ri)(next); setInputs((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${ri}:`)))); }}
            onChange={changeRoom(ri)} onPending={pend(`stepSeason:${ri}`)} addOnMount={seasonOnStart} onAddStarted={() => setSeasonOnStart(false)}>
            <StepWeekends room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onChange={changeRoom(ri)} onPending={pend(`stepWeekday:${ri}`)} />
          </StepSeasons>
          {/* Step "Rates" (VAY-2282): the Flexible and Non-refundable rates, then the other booking options (VAY-2283). */}
          <StepRates room={room} simple={simple} terms={optionTerms} failed={termsFailed} prices={prices} disabled={disabled || (hasPendingEntries && !pendingEntries[`rates:${ri}`])}
            onTerms={applyTerms(room.roomTypeId)} onRetry={retryTerms} onEditOwn={() => setOptionOpen(main.id)} onAdd={(input) => createInitial(input, true, room.roomTypeId)}
            onRemove={(offerId) => { if (!disabled && !pendingBesidesExtras) setDeleting(offerId); }} onChange={changeRoom(ri)} onPending={pend(`rates:${ri}`)}
            edited={room.offers.filter((offer) => policyEdits[policyKey(focus, offer.id)]).map((offer) => offer.id)}>
            <div className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500">{t("pricing.rates.others")}</h4>
              <StepOptions room={room} offers={simple ? simple.others : room.offers.filter((offer) => offer.id !== main.id)} names={names} terms={optionTerms} prices={prices} disabled={disabled}
                termsFailed={termsFailed} onRetryTerms={retryTerms} onEdit={(offerId) => setOptionOpen(offerId)}
                add={<>
                  {missingPresets(room, optionTerms).filter((key) => !(key === "non_refundable" && simple?.cancellation.kind === "free") && !(key === "breakfast" && simple && simple.cancellation.kind !== "own")).map((key) => <AddOptionButton key={key} label={t(`pricing.steps.preset.button.${key}`)} disabled={disabled || hasPendingEntries}
                    onClick={() => { if (!disabled && !hasPendingEntries) { setPreset(key); setError(null); } }} />)}
                  <AddOptionButton label={t("pricing.steps.options.own")} disabled={disabled || hasPendingEntries}
                    onClick={() => { if (!disabled && !hasPendingEntries) { setIndependentOffer(null); setAddingOfferRoom(room.roomTypeId); setError(null); } }} />
                </>} />
              <p className={ui.stepHint}>{t("pricing.paymentMethods.hint")}</p>
            </div>
          </StepRates>
          {/* The breakfast switch; it becomes step "Meals" (VAY-2280 PR 6). */}
          {simple && <StepExtras room={room} simple={simple} prices={prices} only="breakfast" disabled={disabled || (hasPendingEntries && !pendingEntries[`extras:${ri}`])}
            onAdd={(input) => createInitial(input, true, room.roomTypeId)} onRemove={(offerId) => { if (!disabled && !pendingBesidesExtras) setDeleting(offerId); }} onChange={changeRoom(ri)} onPending={pend(`extras:${ri}`)} />}
        </div>
        <OptionWindow open={childrenOpen} title={t("pricing.steps.rules.childrenTitle")} closable={!pendingEntries[`children:${ri}`]} onClose={() => setChildrenOpen(false)}>
          <PricingChildCharges room={room} label={roomName(room.roomTypeId, ri)} disabled={disabled || exclusiveEditPending} onPending={pend(`children:${ri}`)} onChange={changeRoom(ri)} />
        </OptionWindow>
        <MoreOptions keepOpen={pendingIn(moreKeys)} summary={simpleSummary(room, t)} marked={kept}>
          <MoreGroup title={t("pricing.simple.more.dates")}>
            <div className="space-y-2">
              <PricingMonths room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`month:${ri}:${mi}`)} onChange={changeRoom(ri)} />
              <PricingDates room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`date:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            </div>
          </MoreGroup>
          <MoreGroup title={t("pricing.simple.more.rules")}>
            <div className="space-y-2">
              <PricingStayRules room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`stay:${ri}:${mi}`)} onChange={changeRoom(ri)} />
              <PricingStayDates room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`stayDate:${ri}:${mi}`)} onChange={changeRoom(ri)} />
              <PricingStaySeasons room={room} offer={main} label={mainLabel} disabled={disabled || exclusiveEditPending} onPending={pend(`staySeason:${ri}:${mi}`)} onChange={changeRoom(ri)} />
            </div>
          </MoreGroup>
          <MoreGroup title={t("pricing.steps.more.check")}>
            <PricingStayPreview key={focusIndex} roomTypeId={focus} names={names} snapshot={display} inputs={inputs} disabled={disabled || hasPendingEntries} saved={false} roomNames={roomNames} />
          </MoreGroup>
        </MoreOptions>
        {room.offers.map((offer, oi) => {
          const label = offerLabel(room.roomTypeId, ri, oi), other = oi !== mi;
          const blocker = deleteBlocker(room, offer.id);
          // The main option's normal price is step 1; only an included-guest price has more to edit here.
          const priceShown = other || offer.price.kind !== "independent" || offer.price.calendar.base?.mode === "included_guests";
          return <OptionWindow key={offer.id} open={optionOpen === offer.id} title={names[offer.id] ?? ""} closable={!pendingIn(windowKeys(oi)) && !(oi !== mi && badPrice(oi))} onClose={() => { setOptionOpen(null); setDeleteError(null); }}
            footer={deleteError && optionOpen === offer.id ? <p role="alert" className={ui.errorText}>{errorText(deleteError, t, "pricing.steps.delete.errorBlocked")}</p> : blocker ? <p className={ui.help}>{blocker.kind === "only" ? t("pricing.steps.delete.only") : t("pricing.steps.delete.dependents", { names: blocker.ids.map((id) => names[id] ?? "").join(", ") })}</p>
              : <button type="button" disabled={disabled || hasPendingEntries} onClick={() => setDeleting(offer.id)} className="text-[13px] font-medium text-red-600 hover:text-red-700 disabled:opacity-50">{t("pricing.steps.delete.button")}</button>}>
            {priceShown && group(t("pricing.steps.option.price"))}
            {other && offer.price.kind === "independent" && <div><p className={ui.label}>{t("pricing.editor.baseNightlyPrices", { currency: display.currency })}</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">{baseAmounts(offer.price.calendar.base, t).map(([name, minor], ai) => <label key={ai} className="block"><span className="mb-1.5 block text-[11px] text-gray-500">{name}</span><input aria-label={`${label} ${name}`} inputMode="decimal" className={ui.input} disabled={disabled || exclusiveEditPending}
                value={inputs[`${ri}:${oi}:${ai}`] ?? decimalAmount(minor, scale)} onChange={(event) => { setInputs({ ...inputs, [`${ri}:${oi}:${ai}`]: event.target.value }); setDirty(true); setNotice(""); }} /></label>)}</div>
              {!offer.price.calendar.base && <p className={ui.hint}>{t("pricing.editor.calendarOnly")}</p>}</div>}
            <div className="space-y-2" hidden={!priceShown}>
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
        </aside>
        </div>
      </div>;
    })}
    {!loading && editing && !newRoom && busy && <p className={`text-right ${ui.hint}`}>{t("pricing.editor.keepOpen")}</p>}
    {/* Pressing Save is the declaration, so its text stays in the (sticky) bar beside the button. On the New room page
        the page's "Create Room Type" saves, and declares once prices are typed. */}
    {newRoom ? <div className={`flex-wrap ${ui.actionBar}`}>
      {dirty && <p className="w-full text-[11px] text-gray-500 md:mr-auto md:w-auto">{t("pricing.newRoom.declaration")}<span className="ml-2 font-medium text-amber-600">{t("pricing.newRoom.status")}</span></p>}
      {(dirty || error !== null) && <button type="button" className={ui.actionBarButton} disabled={loading || disabled} onClick={() => { if (dirty) setReloading(true); else void load(); }}>{t(dirty ? "pricing.newRoom.remove" : "pricing.editor.reload")}</button>}
      {newRoom.actions}
    </div> : <div className={`flex-wrap ${ui.actionBar}`}>
      {!loading && editing && <p id={declarationId} className="w-full text-[11px] text-gray-500 md:mr-auto md:w-auto">{t("pricing.editor.saveDeclaration")}
        <span className={`ml-2 font-medium ${done ? "text-green-600" : dirty ? "text-amber-600" : "text-gray-400"}`}>{t(done ? "pricing.editor.statusSaved" : dirty ? "pricing.editor.statusUnsaved" : "pricing.editor.statusCurrent")}</span></p>}
      {!loading && editing && guestsFrom && <span className="w-full text-[13px] text-gray-600 md:w-auto">{guestsFrom}</span>}
      <button type="button" className={ui.actionBarButton} disabled={loading || busy || retry} onClick={() => { if (keepsOnReload) reloadKeepingRoom(); else if (leaveRisk) setReloading(true); else void load(); }}>{t(cancels ? "common.cancel" : "pricing.editor.reload")}</button>
      {!loading && editing && done && <button type="button" className={ui.actionBarButton} onClick={() => void load()}>{t("pricing.room.editAgain")}</button>}
      {!loading && editing && (retry ? <button type="button" className={ui.actionBarPrimary} aria-describedby={declarationId} disabled={busy} onClick={() => void run()}>{t("pricing.editor.retry")}</button>
        : <button type="button" disabled={disabled || hasPendingEntries || !(dirty || stale)} className={ui.actionBarPrimary} aria-describedby={declarationId} onClick={save}>{t(busy ? "pricing.editor.saving" : "pricing.editor.save")}</button>)}
    </div>}
    {/* Last, so they open above an option's window. */}
    {reloading && <ConfirmDialog title={t(cancels ? "pricing.steps.discardTitle" : "pricing.reloadTitle")} message={t(cancels ? "pricing.steps.discardMessage" : "pricing.reloadMessage")} confirmLabel={t(cancels ? "pricing.steps.discardConfirm" : "pricing.reloadConfirm")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { setReloading(false); void load(); }} onCancel={() => setReloading(false)} />}
    {leave && <ConfirmDialog title={t("pricing.leaveTitle")} message={t("pricing.leaveMessage")} confirmLabel={t("pricing.leaveConfirm")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { leaving.current = true; setLeave(null); leave(); }} onCancel={() => setLeave(null)} />}
  </section></PricingManualMethodsProvider>;
}
/** A room's prices without what a save assigns (its revision and its options' terms revisions). */
const savedPrices = (room: Room) => ({ ...room, revision: 0, offers: room.offers.map((offer) => ({ ...offer, termsRevision: "" })) });
/** The New room page's kept prices as edits kept over a reload: a new room has no saved prices to compare with. */
function handedOverEdits(handover: KeptNewRoomPrices): Kept {
  const key = (terms: PricingTermsInput) => JSON.stringify([terms.roomTypeId, terms.offerId]); // As `policyKey`.
  return { room: handover.room, base: null, terms: Object.fromEntries(handover.terms.map((terms) => [key(terms), terms])),
    bases: Object.fromEntries(handover.terms.map((terms) => [key(terms), terms.expectedRevision])) };
}
/** Edits survive only when the server still has this room exactly as it was loaded (or still has no prices for
 * it) in the same currency, so a save after the reload never overwrites someone else's change to this room. */
function keptRoom(keep: Kept, saved: Awaited<ReturnType<Client["read"]>>) {
  const server = saved?.rooms.find((room) => room.roomTypeId === keep.room.roomTypeId);
  const unchanged = keep.base && server ? samePricingValue({ ...server, revision: 0 }, { ...keep.base, revision: 0 }) : !keep.base && !server;
  return unchanged && (!saved || saved.currency === keep.room.currency) ? keep.room : null;
}
