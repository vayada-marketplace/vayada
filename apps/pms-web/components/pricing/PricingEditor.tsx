"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pricingCurrencyScale } from "@vayada/domain-pms/replacement-pricing";
import { ApiErrorResponse } from "@/services/api/client";
import { type createReplacementPricingClient, type PricingSnapshot, type PricingDraft, type PricingChargeReview } from "@/services/api/replacementPricingClient";

import { baseAmounts, decimalAmount, editedSnapshot } from "./pricingAmounts";
import { FirstPricingSetup, type SetupRoom, type firstPricingInput } from "./FirstPricingSetup";
import { PricingTerms } from "./PricingTerms";
import { PricingMonths } from "./PricingMonths";
import { PricingWeekdays } from "./PricingWeekdays";
import { PricingDates } from "./PricingDates";
import { PricingRules } from "./PricingRules";

type Client = ReturnType<typeof createReplacementPricingClient>;
export function PricingEditor({ client, roomNames = {}, setup }: { client: Client; roomNames?: Record<string, string>; setup?: { propertyId: string; rooms: readonly SetupRoom[] } }) {
  const [pendingEntries, setPendingEntries] = useState<Record<string, boolean>>({});
  const hasPendingEntries = Object.values(pendingEntries).some(Boolean);
  const [empty, setEmpty] = useState(false);
  const [current, setCurrent] = useState<PricingSnapshot | null>(null), [baseRevision, setBaseRevision] = useState(0);
  const [draft, setDraft] = useState<PricingDraft | null>(null), [review, setReview] = useState<PricingChargeReview | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({}), [dirty, setDirty] = useState(false), [ack, setAck] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [needsReload, setNeedsReload] = useState(false), [done, setDone] = useState(false), [retry, setRetry] = useState(false);
  const retainFailure = useRef<(() => boolean) | null>(null);
  const action = useRef<(() => Promise<void>) | null>(null), locked = useRef(false), alive = useRef(true);
  const pendingDraftId = useRef(crypto.randomUUID()), leaving = useRef(false);
  const load = useCallback(async () => {
    setLoading(true); setEmpty(false); setError("");
    try {
      const saved = await client.read(); if (!alive.current) return;
      setEmpty(saved === null);
      setCurrent(saved ? { currency: saved.currency, ownerReferences: { finance: saved.ownerReferences.finance },
        rooms: saved.rooms.map((room) => ({ ...room, revision: saved.revision + 1 })) } : null);
      setPendingEntries({}); setBaseRevision(saved?.revision ?? 0); setInputs({}); setDraft(null); setReview(null); setDirty(false); setAck(false); setNeedsReload(false); setDone(false);
      pendingDraftId.current = crypto.randomUUID();
      setNotice(saved?.stale ? "Some source settings changed. Saving will check them again." : "");
    } catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setLoading(false); }
  }, [client]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]); // Client is property-bound; parent keys this component by property.
  const leaveRisk = hasPendingEntries || dirty || retry || busy || (!!draft && !done);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (leaveRisk && !leaving.current) { event.preventDefault(); event.returnValue = ""; } };
    // Pricing is entered and left through document navigation so browser history also runs beforeunload.
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || event.metaKey || event.ctrlKey || event.shiftKey || link.target === "_blank") return;
      event.preventDefault(); event.stopPropagation(); window.location.assign(link.href);
    };
    const switchProperty = (event: Event) => {
      if (leaveRisk && !window.confirm("Leave pricing? This draft and any pending retry cannot be recovered after leaving.")) event.preventDefault();
      else leaving.current = true;
    };
    window.addEventListener("beforeunload", warn); document.addEventListener("click", navigate, true);
    window.addEventListener("pms:before-property-change", switchProperty);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", navigate, true); window.removeEventListener("pms:before-property-change", switchProperty); };
  }, [leaveRisk]);
  async function run(next?: () => Promise<void>, keepFailure?: () => boolean) {
    if (locked.current) return;
    if (next) { action.current = next; retainFailure.current = keepFailure ?? null; }
    if (!action.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await action.current(); action.current = null; if (alive.current) setRetry(false); }
    catch (e) {
      if (alive.current) {
        setError(message(e));
        const definitive = e instanceof ApiErrorResponse && [400, 403, 409].includes(e.status) && !retainFailure.current?.();
        if (definitive) { action.current = null; setNeedsReload(true); setRetry(false); } else setRetry(true);
      }
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  function createInitial(input: ReturnType<typeof firstPricingInput>) {
    const saveTerms = client.termsAction(input.terms);
    let saved: Awaited<ReturnType<typeof saveTerms>> | null = null;
    void run(async () => {
      saved ??= await saveTerms();
      if (alive.current) setNotice("The offer policy is saved. Checking pricing readiness; pricing is not approved yet.");
      const room = { ...input.configuration, offers: input.configuration.offers.map((offer) => ({ ...offer, termsRevision: saved!.revision })) };
      const prepared = await client.prepare({ currency: room.currency, rooms: [room] });
      if (alive.current) { setCurrent(prepared.snapshot); setBaseRevision(0); setDirty(true); setNotice("Setup is ready. Save your draft, then review its charges before approval."); }
    }, () => saved !== null); // Preparation is read-only; keep the accepted policy even after readiness is rejected.
  }
  function save() {
    if (!current || hasPendingEntries) return;
    let edited: PricingSnapshot;
    try { edited = editedSnapshot(current, inputs); } catch (e) { setError(message(e)); return; }
    const expected = draft?.revision ?? 0, id = draft?.draftId ?? pendingDraftId.current;
    let prepared: Awaited<ReturnType<Client["prepare"]>> | null = null;
    void run(async () => {
      prepared ??= await client.prepare({ currency: edited.currency, rooms: edited.rooms });
      const revision = await client.saveDraft({ draftId: id, expectedDraftRevision: expected, baseRevision, ...prepared });
      if (alive.current) { setDraft({ draftId: id, revision, baseRevision, ...prepared, stale: false }); setDirty(false); setNotice("Draft saved. Review charges before approving rates."); }
    });
  }
  function approve() {
    if (!review || !ack) return;
    const saved = review, confirm = client.confirmationAction(saved);
    let confirmed: Awaited<ReturnType<typeof confirm>> | null = null, attached: PricingDraft | null = null;
    let publish: ReturnType<Client["publicationAction"]> | null = null;
    void run(async () => {
      confirmed ??= await confirm();
      const snapshot = { ...saved.snapshot, ownerReferences: { ...saved.snapshot.ownerReferences, charges: confirmed.id } };
      if (!attached) {
        const revision = await client.saveDraft({ draftId: saved.draftId, expectedDraftRevision: saved.revision, baseRevision: saved.baseRevision, sources: saved.sources, snapshot });
        attached = { ...saved, snapshot, revision };
      }
      publish ??= client.publicationAction({ draftId: attached.draftId, snapshot: attached.snapshot, revision: attached.revision, baseRevision: attached.baseRevision, sources: attached.sources, stale: false });
      await publish();
      if (alive.current) { setDone(true); setDirty(false); setReview(null); setNotice("Approved rates saved. Channel distribution is not connected yet."); }
    });
  }
  const disabled = busy || retry || needsReload || done, display = review?.snapshot ?? current;
  const scale = display ? pricingCurrencyScale(display.currency)! : 2;
  return <section className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold text-gray-950">Pricing</h1><p className="mt-1 text-sm text-gray-600">Edit nightly prices and calendar rules, then review and approve your saved draft.</p></div>
      <button className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50" disabled={loading || busy || retry} onClick={() => { if (!leaveRisk || window.confirm("Discard this draft and reload pricing?")) void load(); }}>Reload pricing</button></header>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{error}{retry && <p className="mt-2">Keep this page open and retry the same action. Do not start another pricing action.</p>}</div>}
    {notice && <p role="status" className="rounded-lg bg-emerald-50 p-4 text-emerald-900">{notice}</p>}
    {loading ? <p role="status">Loading pricing…</p> : !display && !empty ? null : !display ? <div className="rounded-xl border bg-white p-8"><h2 className="font-semibold">Pricing is not configured yet</h2>{setup ? <FirstPricingSetup propertyId={setup.propertyId} rooms={setup.rooms} disabled={disabled} onDirty={() => setDirty(true)} onCreate={createInitial} /> : <p className="mt-2 text-sm text-gray-600">Room setup information is unavailable. Reload pricing before creating a rate.</p>}
      {retry && <button disabled={busy} className="mt-4 rounded-lg border px-4 py-2" onClick={() => void run()}>Retry last action</button>}</div> : <>
      <div className="flex justify-between text-sm"><strong>{display.currency} · Base nightly prices</strong><span>{done ? "Approved rates" : review ? "Saved draft review" : dirty ? "Unsaved changes" : draft ? "Draft saved" : "Current rates"}</span></div>
      {display.rooms.map((room, ri) => <div key={room.roomTypeId} className="overflow-hidden rounded-xl border bg-white">
        <h2 className="border-b bg-gray-50 px-5 py-3 font-semibold">{roomNames[room.roomTypeId] ?? `Room ${ri + 1}`}</h2>
        {room.offers.map((offer, oi) => <div key={offer.id} className="grid gap-4 border-b p-5 last:border-0 sm:grid-cols-[1fr_2fr]">
          <div><h3 className="font-medium">Offer {oi + 1}</h3><p className="text-sm text-gray-500">{offer.price.kind === "linked" ? "Linked rate · managed through its parent" : "Independent rate"}</p></div>
          <div className="flex flex-wrap gap-3">{offer.price.kind === "independent" && baseAmounts(offer.price.calendar.base).map(([label, minor], ai) => <label key={ai} className="text-sm text-gray-600">{label}<input aria-label={`${roomNames[room.roomTypeId] ?? `Room ${ri + 1}`} Offer ${oi + 1} ${label}`} inputMode="decimal" className="mt-1 block w-36 rounded-lg border px-3 py-2 text-gray-950 disabled:bg-gray-50" disabled={disabled || !!review}
            value={review ? decimalAmount(minor, scale) : inputs[`${ri}:${oi}:${ai}`] ?? decimalAmount(minor, scale)} onChange={(event) => { setInputs({ ...inputs, [`${ri}:${oi}:${ai}`]: event.target.value }); setDirty(true); setReview(null); setAck(false); setNotice(""); }} /></label>)}
            {offer.price.kind === "independent" && !offer.price.calendar.base && <p className="text-sm text-gray-500">Calendar-only rate. Add date prices below; other calendar editing is not available yet.</p>}</div>
          <PricingDates room={room} offer={offer} label={`${roomNames[room.roomTypeId] ?? `Room ${ri + 1}`} Offer ${oi + 1}`} disabled={disabled || !!review}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`date:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setReview(null); setAck(false); setNotice(""); }} />
          <PricingWeekdays room={room} offer={offer} label={`${roomNames[room.roomTypeId] ?? `Room ${ri + 1}`} Offer ${oi + 1}`} disabled={disabled || !!review}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`weekday:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setReview(null); setAck(false); setNotice(""); }} />
          <PricingMonths room={room} offer={offer} label={`${roomNames[room.roomTypeId] ?? `Room ${ri + 1}`} Offer ${oi + 1}`} disabled={disabled || !!review}
            onPending={(pending) => setPendingEntries((previous) => ({ ...previous, [`month:${ri}:${oi}`]: pending }))}
            onChange={(nextRoom) => { setCurrent((previous) => previous ? { ...previous, rooms: previous.rooms.map((value, index) => index === ri ? nextRoom : value) } : null); setDirty(true); setReview(null); setAck(false); setNotice(""); }} />
        </div>)}
        <details className="border-t px-5 py-3 text-sm text-gray-600"><summary className="cursor-pointer">Retained rules and other charges</summary>
          <p className="mt-2">Adult prices apply from age {room.children.adultFromAge}. Younger guests use the child charges below, even when they count toward capacity.</p>
          <p className="mt-2">Review date prices below. Other calendar rules, linked adjustments, cancellation terms and stay restrictions are preserved.</p>
          {room.children.bands.map((band) => <p key={band.fromAge}>Children aged {band.fromAge}–{band.throughAge}: {decimalAmount(band.nightlyMinor, scale)} {display.currency} per night.</p>)}
          {room.offers.map((offer, oi) => <div key={offer.id} className="mt-2"><p>Offer {oi + 1} · {offer.meal.kind.replaceAll("_", " ")}</p>
            {offer.meal.charge.kind === "room" ? <p>Meal: {decimalAmount(offer.meal.charge.amountMinor, scale)} {display.currency} per room per night.</p> : <>
              <p>Meal: {decimalAmount(offer.meal.charge.adultMinor, scale)} {display.currency} per adult per night.</p>
              {offer.meal.charge.childBandAmountsMinor.map((minor, bi) => <p key={bi}>Meal, ages {room.children.bands[bi].fromAge}–{room.children.bands[bi].throughAge}: {decimalAmount(minor, scale)} {display.currency} per child per night.</p>)}
            </>}
            <PricingRules room={room} offer={offer} scale={scale} />
            <PricingTerms propertyId={room.propertyId} client={client} roomTypeId={room.roomTypeId} offerId={offer.id} revision={offer.termsRevision} />
          </div>)}
        </details>
      </div>)}
      {review && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5"><h2 className="font-semibold">Confirm the saved prices</h2><p className="mt-2 text-sm">Review the saved amounts above, including child and meal charges. Approving creates a saved pricing revision; it does not send rates to channels yet.</p>
        <label className="mt-4 flex gap-3 text-sm"><input type="checkbox" checked={ack} disabled={disabled} onChange={(e) => setAck(e.target.checked)} />All mandatory charges are included in these prices.</label></div>}
      <footer className="flex flex-wrap gap-3 border-t pt-5">
        {retry ? <button className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50" disabled={busy} onClick={() => void run()}>Retry last action</button> : review ? <>
          <button disabled={disabled} className="rounded-lg border px-5 py-2 disabled:opacity-50" onClick={() => { setReview(null); setAck(false); }}>Back to editing</button>
          <button disabled={disabled || !ack} className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50" onClick={approve}>Approve rates</button></> : <>
          <button disabled={disabled || hasPendingEntries} className="rounded-lg border px-5 py-2 disabled:opacity-50" onClick={save}>Save draft</button>
          <button disabled={disabled || hasPendingEntries || dirty || !draft} className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50" onClick={() => void run(async () => { const next = await client.reviewCharges(draft!.draftId); if (!next) throw new ApiErrorResponse(409, { message: "The saved draft is missing. Reload pricing." }); if (alive.current) { setReview(next); setAck(false); } })}>Review saved charges</button></>}
      </footer>
      <p className="text-xs text-gray-500">Keep this page open while saving or approving. Draft recovery after closing the page is not available yet.</p>
    </>}
  </section>;
}
function message(error: unknown) {
  if (error instanceof ApiErrorResponse && error.status === 409) return "Pricing or its settings changed. Reload pricing before continuing.";
  if (error instanceof ApiErrorResponse && error.status === 403) return "You do not have access to make this change, or the current pricing settings are unavailable.";
  return error instanceof Error ? error.message : "Pricing could not be saved. Try again.";
}
