"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  CursorArrowRaysIcon,
  EyeSlashIcon,
  MapPinIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  NEARBY_CATEGORIES,
  NEARBY_CATEGORY_ICONS,
  NEARBY_CATEGORY_NAME_MAX_LENGTH,
  NEARBY_CUSTOM_CATEGORY_COLORS,
  NEARBY_MAX_CUSTOM_CATEGORIES,
  NEARBY_TIP_MAX_LENGTH,
  nearbyCategoryViews,
  type NearbyCategoryView,
  type NearbyCurationState,
  type NearbyCustomCategory,
} from "@vayada/domain-hotels";
import NearbyAreaSearch from "./NearbyAreaSearch";
import { NearbyCategoryBadge, nearbyCategoryIcons } from "./NearbyCategoryBadge";
import NearbyPlacesMap, { type NearbyMapPoint } from "./NearbyPlacesMap";
import {
  NEARBY_CATEGORY_HEX,
  NEARBY_PLACE_LIMIT,
  deleteNearbyCategory,
  formatDistance,
  isStandardCategory,
  moveItem,
  nearbyCategoryName,
  nearbyPlace,
  tipTooLong,
} from "./nearbyPlaces";
import type { Translate } from "./nearbyPlacesMessages";

/** Booking Admin's "Show nearby places" switch and its rooms with their own location (VAY-2326). */
export type NearbyGuestMap = {
  load: (signal: AbortSignal) => Promise<{
    nearbyEnabled: boolean;
    canSwitch: boolean;
    rooms: {
      name: string;
      pin: NearbyMapPoint | null;
      atProperty: boolean;
      approximate: boolean;
    }[];
  }>;
  setNearbyEnabled: (enabled: boolean) => Promise<boolean>;
};

type PlaceForm = { name: string; category: string; note: string; position: NearbyMapPoint | null };
type Mode =
  | { kind: "add"; form: PlaceForm }
  | { kind: "edit"; id: string; form: PlaceForm; deleting: boolean }
  | { kind: "categories" };

const button =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";
const primary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50";
const input =
  "mt-1.5 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100";
const label = "block text-sm font-semibold text-gray-900";
// Hotel content is plain text: the API refuses angle brackets.
const plain = (value: string) => value.replace(/[<>]/g, "");

/** The nearby places editor (VAY-2326), below the property's address on Booking Admin's location page. The host's
 * places in guest order, with the map of what guests see. Changes wait for "Save places"; the switch saves at once. */
export default function NearbyPlacesEditor({
  t,
  locale,
  apiKey,
  propertyName,
  propertyPin,
  saved,
  draft,
  setDraft,
  disabled,
  busy,
  dirty,
  locationDirty = false,
  reconfirm,
  onSave,
  onDiscard,
  guestMap,
  onFormOpen,
}: {
  t: Translate;
  locale: string;
  apiKey: string;
  propertyName: string;
  /** The property's saved pin, which distances are measured from. */
  propertyPin: NearbyMapPoint | null;
  saved: NearbyCurationState;
  draft: NearbyCurationState;
  setDraft: (update: (current: NearbyCurationState) => NearbyCurationState) => void;
  /** While the location has unsaved edits or a save runs. */
  disabled: boolean;
  busy: boolean;
  dirty: boolean;
  /** Unsaved address edits above: "Discard changes" undoes them too, as the page's one discard. */
  locationDirty?: boolean;
  /** The location moved since the places were saved: saving them again shows them to guests again. */
  reconfirm: boolean;
  onSave: () => void;
  onDiscard: () => void;
  guestMap?: NearbyGuestMap;
  /** An unfinished add or edit form, which leaving the page would lose. */
  onFormOpen?: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [newCategory, setNewCategory] = useState<Omit<NearbyCustomCategory, "id"> | null>(null);
  const [focus, setFocus] = useState<NearbyMapPoint | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // A new object per keyboard move, so the moved row's handle gets the focus back.
  const [focusHandle, setFocusHandle] = useState<{ id: string } | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const categoriesButton = useRef<HTMLButtonElement>(null);
  // When a form closes, the focus goes back to what opened it (or "Add a place" once that's gone).
  const returnFocus = useRef<() => HTMLElement | null | undefined>(() => null);
  const [restoreFocus, setRestoreFocus] = useState(0);
  // Categories made in the open place form: dropped again if the form is cancelled and no place uses them.
  const createdInForm = useRef<string[]>([]);
  const [guests, setGuests] = useState<{
    enabled: boolean;
    canSwitch: boolean;
    rooms: (NearbyMapPoint & { name: string; approximate: boolean })[];
  } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);

  useEffect(() => {
    if (!guestMap) return;
    const controller = new AbortController();
    guestMap
      .load(controller.signal)
      .then((summary) =>
        setGuests({
          enabled: summary.nearbyEnabled,
          canSwitch: summary.canSwitch,
          rooms: summary.rooms.flatMap((room) =>
            room.pin && !room.atProperty
              ? [{ name: room.name, approximate: room.approximate, ...room.pin }]
              : [],
          ),
        }),
      )
      // Without the switch (no access, or it failed to load) the editor still works.
      .catch(() => undefined);
    return () => controller.abort();
  }, [guestMap]);

  const formOpen = mode?.kind === "add" || mode?.kind === "edit";
  useEffect(() => {
    onFormOpen?.(formOpen);
  }, [formOpen, onFormOpen]);
  useEffect(() => {
    if (focusHandle) handles.current.get(focusHandle.id)?.focus();
  }, [focusHandle]);
  useEffect(() => {
    if (restoreFocus) (returnFocus.current() ?? addButton.current)?.focus();
  }, [restoreFocus]);

  function open(next: Mode, from: () => HTMLElement | null | undefined) {
    returnFocus.current = from;
    createdInForm.current = [];
    setNewCategory(null);
    setMode(next);
  }
  /** Closes the open form; a cancelled place form takes back the categories it made that nothing uses. */
  function close(saved = false) {
    const made = createdInForm.current;
    createdInForm.current = [];
    if (!saved && made.length)
      setDraft((current) => ({
        ...current,
        customCategories: current.customCategories.filter(
          ({ id }) =>
            !made.includes(id) || current.customPlaces.some((place) => place.category === id),
        ),
      }));
    setMode(null);
    setNewCategory(null);
    setRestoreFocus((count) => count + 1);
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };

  const categories = nearbyCategoryViews(draft);
  const categoryOf = (id: string): NearbyCategoryView =>
    categories.find((category) => category.id === id) ?? categories[0];
  const places = draft.customPlaces;
  const limit = NEARBY_PLACE_LIMIT - draft.choices.filter((choice) => choice.added).length;
  const distance = (point: NearbyMapPoint) =>
    propertyPin ? formatDistance(propertyPin, point, locale, t) : null;
  const coordinate = (value: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
      useGrouping: false,
    }).format(value);
  const shown = guests?.enabled ?? true;
  const update = (form: Partial<PlaceForm>) =>
    setMode((current) =>
      current && current.kind !== "categories"
        ? { ...current, form: { ...current.form, ...form } }
        : current,
    );

  async function toggle() {
    if (!guestMap || !guests || switching) return;
    setSwitching(true);
    setSwitchFailed(false);
    try {
      const enabled = await guestMap.setNearbyEnabled(!guests.enabled);
      setGuests({ ...guests, enabled });
    } catch {
      setSwitchFailed(true);
    } finally {
      setSwitching(false);
    }
  }

  function reorder(from: number, to: number) {
    if (from === to || to < 0 || to >= places.length) return;
    const place = places[from];
    setDraft((current) => ({ ...current, customPlaces: moveItem(current.customPlaces, from, to) }));
    setFocusHandle({ id: place.id });
    setAnnouncement(
      t("nearbyPlaces.row.moved", { name: place.name, position: to + 1, count: places.length }),
    );
  }

  function startDrag(index: number, event: PointerEvent<HTMLButtonElement>) {
    if (disabled || formOpen) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let over = index;
    setDrag({ from: index, over });
    const move = (moved: globalThis.PointerEvent) => {
      const row = document
        .elementFromPoint(moved.clientX, moved.clientY)
        ?.closest<HTMLElement>("[data-nearby-row]");
      const target = Number(row?.dataset.nearbyRow);
      if (row && Number.isInteger(target) && target !== over) {
        over = target;
        setDrag({ from: index, over });
      }
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", drop);
      handle.removeEventListener("pointercancel", cancel);
      setDrag(null);
    };
    const drop = () => {
      stop();
      reorder(index, over);
    };
    // A cancelled gesture (a scroll took over) leaves the order as it was.
    const cancel = stop;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", drop);
    handle.addEventListener("pointercancel", cancel);
  }

  function savePlace() {
    if (!mode || mode.kind === "categories" || !mode.form.position) return;
    const { form } = mode;
    const position = form.position!;
    if (mode.kind === "add") {
      const place = nearbyPlace(crypto.randomUUID(), { ...form, ...position });
      setDraft((current) => ({ ...current, customPlaces: [...current.customPlaces, place] }));
    } else {
      setDraft((current) => ({
        ...current,
        customPlaces: current.customPlaces.map((place) =>
          place.id === mode.id ? nearbyPlace(place.id, { ...form, ...position }, place) : place,
        ),
      }));
    }
    close(true);
  }

  function addCategory() {
    if (!newCategory?.name.trim()) return;
    const id = crypto.randomUUID();
    setDraft((current) => ({
      ...current,
      customCategories: [
        ...current.customCategories,
        { ...newCategory, id, name: newCategory.name.trim() },
      ],
    }));
    createdInForm.current = [...createdInForm.current, id];
    update({ category: id });
    setNewCategory(null);
  }

  // The map shows the place being edited as the form has it.
  const editing = mode?.kind === "edit" ? mode : null;
  const mapPlaces = places.map((place) => {
    const form = editing?.id === place.id ? editing.form : null;
    return {
      id: place.id,
      name: form?.name.trim() || place.name,
      latitude: form?.position?.latitude ?? place.latitude,
      longitude: form?.position?.longitude ?? place.longitude,
      category: categoryOf(form?.category ?? place.category),
    };
  });
  const adding = mode?.kind === "add" ? mode : null;
  const savedNote = (id: string) => saved.customPlaces.find((place) => place.id === id)?.note;

  const form = mode && mode.kind !== "categories" && (
    <PlaceFormFields
      t={t}
      form={mode.form}
      categories={categories}
      savedNote={mode.kind === "edit" ? savedNote(mode.id) : null}
      newCategory={newCategory}
      canAddCategory={draft.customCategories.length < NEARBY_MAX_CUSTOM_CATEGORIES}
      onChange={update}
      onNewCategory={setNewCategory}
      onAddCategory={addCategory}
    />
  );
  const formReady =
    mode &&
    mode.kind !== "categories" &&
    mode.form.position &&
    mode.form.name.trim() &&
    !newCategory &&
    !tipTooLong(mode.form.note, mode.kind === "edit" ? savedNote(mode.id) : null);

  return (
    <section
      aria-labelledby="nearby-places-title"
      className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2 id="nearby-places-title" className="text-lg font-bold text-gray-950">
            {t("nearbyPlaces.title")}
          </h2>
          <p className="mt-1 text-sm text-gray-500">{t("nearbyPlaces.intro")}</p>
        </div>
        {guests && (
          <div className="shrink-0 sm:text-right">
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={guests.enabled}
                aria-labelledby="nearby-places-switch"
                // Saving keeps the switch focusable; a second press waits for the first.
                aria-busy={switching || undefined}
                disabled={!guests.canSwitch}
                onClick={() => void toggle()}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                  guests.enabled ? "bg-blue-700" : "bg-gray-300"
                }`}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    guests.enabled ? "translate-x-4" : ""
                  }`}
                />
              </button>
              <span id="nearby-places-switch" className="text-sm font-semibold text-gray-900">
                {t("nearbyPlaces.switch")}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {guests.canSwitch
                ? t("nearbyPlaces.switchHint")
                : t("nearbyPlaces.switchUnavailable")}
            </p>
            {switchFailed && (
              <p role="alert" className="mt-1 text-xs text-red-700">
                {t("nearbyPlaces.switchFailed")}
              </p>
            )}
          </div>
        )}
      </div>

      {guests && !guests.enabled && (
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <EyeSlashIcon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-gray-600" />
          <div>
            <p className="text-sm font-semibold text-gray-900">{t("nearbyPlaces.off.title")}</p>
            <p className="mt-0.5 text-sm text-gray-600">{t("nearbyPlaces.off.body")}</p>
          </div>
        </div>
      )}
      {reconfirm && (
        <p role="status" className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
          {t("nearbyPlaces.reconfirm")}
        </p>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.07fr)_minmax(0,1fr)] lg:items-start">
        <div className="lg:sticky lg:top-4 lg:order-2">
          <div className="h-[260px] sm:h-[360px] lg:h-[560px]">
            <NearbyPlacesMap
              apiKey={apiKey}
              t={t}
              property={propertyPin && { ...propertyPin, name: propertyName }}
              rooms={guests?.rooms ?? []}
              places={mapPlaces}
              shown={shown}
              draft={
                adding && {
                  position: adding.form.position,
                  name: adding.form.name,
                  category: categoryOf(adding.form.category),
                }
              }
              editingId={editing?.id ?? null}
              focus={focus}
              onDrop={adding && !disabled ? (position) => update({ position }) : undefined}
              onMove={
                editing && !disabled
                  ? (id, position) => {
                      if (editing.id === id) update({ position });
                    }
                  : undefined
              }
            />
          </div>
          {shown && <p className="mt-2 text-xs text-gray-500">{t("nearbyPlaces.map.caption")}</p>}
        </div>

        <fieldset disabled={disabled} className="min-w-0 space-y-2 lg:order-1">
          <legend className="sr-only">{t("nearbyPlaces.title")}</legend>
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
          {places.length === 0 && !adding && (
            <p className="rounded-xl border border-gray-200 p-4 text-sm text-gray-500">
              {t("nearbyPlaces.empty")}
            </p>
          )}
          <ol className="space-y-2">
            {places.map((place, index) => {
              const category = categoryOf(place.category);
              const away = distance(place);
              if (editing?.id === place.id)
                return (
                  <li
                    key={place.id}
                    onKeyDown={escape}
                    className="rounded-xl border-2 border-blue-600 bg-white p-4 shadow-[0_0_0_4px_rgb(219_234_254)]"
                  >
                    <p className="flex items-center gap-2.5 text-sm text-gray-500">
                      <span className="w-5 text-right text-xs font-bold text-gray-700">
                        {index + 1}
                      </span>
                      <NearbyCategoryBadge category={categoryOf(editing.form.category)} size={26} />
                      {t("nearbyPlaces.form.editing", {
                        category: nearbyCategoryName(categoryOf(editing.form.category), t),
                        distance: (editing.form.position && distance(editing.form.position)) ?? "",
                      })}
                    </p>
                    {editing.deleting ? (
                      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
                        <div className="flex items-start gap-3">
                          <TrashIcon
                            aria-hidden="true"
                            className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
                          />
                          <div>
                            <p className="text-sm font-bold text-gray-900">
                              {t("nearbyPlaces.delete.title")}
                            </p>
                            <p className="mt-0.5 text-sm text-gray-700">
                              {t("nearbyPlaces.delete.body", { name: place.name })}
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 flex justify-end gap-2">
                          <button
                            type="button"
                            className={button}
                            // The question replaces the Delete button that had the focus.
                            autoFocus
                            onClick={() => setMode({ ...editing, deleting: false })}
                          >
                            {t("nearbyPlaces.delete.keep")}
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
                            onClick={() => {
                              setDraft((current) => ({
                                ...current,
                                customPlaces: current.customPlaces.filter(
                                  (item) => item.id !== place.id,
                                ),
                              }));
                              close();
                            }}
                          >
                            {t("nearbyPlaces.delete.confirm")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 space-y-4">
                        {form}
                        <p className="flex items-center gap-1.5 text-xs font-medium text-blue-700">
                          <CursorArrowRaysIcon aria-hidden="true" className="h-4 w-4" />
                          {t("nearbyPlaces.form.moveHint")}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="mr-auto inline-flex items-center gap-1.5 rounded-lg px-1 py-2 text-sm font-semibold text-red-600 hover:text-red-700"
                            onClick={() => setMode({ ...editing, deleting: true })}
                          >
                            <TrashIcon aria-hidden="true" className="h-4 w-4" />
                            {t("nearbyPlaces.form.delete")}
                          </button>
                          <button type="button" className={button} onClick={() => close()}>
                            {t("nearbyPlaces.form.cancel")}
                          </button>
                          <button
                            type="button"
                            className={primary}
                            disabled={!formReady}
                            onClick={savePlace}
                          >
                            {t("nearbyPlaces.form.save")}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              return (
                <li
                  key={place.id}
                  data-nearby-row={index}
                  className={`flex gap-3 rounded-xl border bg-white p-4 transition ${
                    drag?.from === index
                      ? "border-dashed border-gray-300 opacity-40"
                      : drag && drag.over === index
                        ? "border-indigo-500 ring-2 ring-indigo-500"
                        : "border-gray-200"
                  }`}
                >
                  <button
                    type="button"
                    ref={(element) => {
                      if (element) handles.current.set(place.id, element);
                      else handles.current.delete(place.id);
                    }}
                    aria-label={t("nearbyPlaces.row.move", { name: place.name })}
                    disabled={formOpen}
                    className="-ml-1 flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 active:cursor-grabbing disabled:cursor-default disabled:opacity-50"
                    onPointerDown={(event) => startDrag(index, event)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        reorder(index, index + (event.key === "ArrowUp" ? -1 : 1));
                      }
                    }}
                  >
                    <GripIcon />
                  </button>
                  <span className="w-4 shrink-0 pt-0.5 text-right text-xs font-bold text-gray-700">
                    {index + 1}
                  </span>
                  <NearbyCategoryBadge category={category} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[15px] font-bold text-gray-950">{place.name}</p>
                    <p className="mt-0.5 text-[13px] text-gray-500">
                      {[nearbyCategoryName(category, t), away].filter(Boolean).join(" · ")}
                    </p>
                    {place.note && (
                      <p className="mt-1 break-words text-[13px] text-gray-700">
                        {t("nearbyPlaces.row.tip", { tip: place.note })}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    ref={(element) => {
                      if (element) editButtons.current.set(place.id, element);
                      else editButtons.current.delete(place.id);
                    }}
                    aria-label={t("nearbyPlaces.row.edit", { name: place.name })}
                    disabled={formOpen}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                    onClick={() =>
                      open(
                        {
                          kind: "edit",
                          id: place.id,
                          deleting: false,
                          form: {
                            name: place.name,
                            category: place.category,
                            note: place.note ?? "",
                            position: { latitude: place.latitude, longitude: place.longitude },
                          },
                        },
                        () => editButtons.current.get(place.id),
                      )
                    }
                  >
                    <PencilSquareIcon aria-hidden="true" className="h-5 w-5" />
                  </button>
                </li>
              );
            })}
          </ol>

          {adding ? (
            <div
              onKeyDown={escape}
              className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/60 p-4"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-bold text-gray-950">
                  {t("nearbyPlaces.form.addTitle")}
                </h3>
                <button
                  type="button"
                  aria-label={t("nearbyPlaces.form.close")}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-white"
                  onClick={() => close()}
                >
                  <XMarkIcon aria-hidden="true" className="h-5 w-5" />
                </button>
              </div>
              {apiKey && <NearbyAreaSearch apiKey={apiKey} t={t} onLocate={setFocus} />}
              <p
                className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                  adding.form.position
                    ? "border-green-200 bg-green-50 text-gray-900"
                    : "border-gray-200 bg-white text-gray-600"
                }`}
              >
                <MapPinIcon
                  aria-hidden="true"
                  className={`h-4 w-4 shrink-0 ${adding.form.position ? "text-green-700" : "text-gray-500"}`}
                />
                {adding.form.position ? (
                  <span>
                    <span className="font-semibold">
                      {t("nearbyPlaces.form.pinDropped", {
                        distance: distance(adding.form.position) ?? "",
                        property: propertyName,
                      })}
                    </span>{" "}
                    <span className="text-gray-500">
                      {coordinate(adding.form.position.latitude)},{" "}
                      {coordinate(adding.form.position.longitude)}
                    </span>
                  </span>
                ) : (
                  t("nearbyPlaces.form.clickMap")
                )}
              </p>
              {form}
              <div className="flex justify-end gap-2">
                <button type="button" className={button} onClick={() => close()}>
                  {t("nearbyPlaces.form.cancel")}
                </button>
                <button type="button" className={primary} disabled={!formReady} onClick={savePlace}>
                  <PlusIcon aria-hidden="true" className="h-4 w-4" />
                  {t("nearbyPlaces.form.addToMap")}
                </button>
              </div>
            </div>
          ) : mode?.kind === "categories" ? (
            <CategoriesPanel t={t} draft={draft} setDraft={setDraft} onClose={() => close(true)} />
          ) : (
            <>
              <button
                type="button"
                ref={addButton}
                disabled={formOpen || !propertyPin || places.length >= limit}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-blue-300 py-3 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() =>
                  open(
                    {
                      kind: "add",
                      form: { name: "", category: categories[0].id, note: "", position: null },
                    },
                    () => addButton.current,
                  )
                }
              >
                <PlusIcon aria-hidden="true" className="h-4 w-4" />
                {t("nearbyPlaces.add")}
              </button>
              {!propertyPin ? (
                <p className="text-sm text-gray-500">{t("nearbyPlaces.noPin")}</p>
              ) : (
                places.length >= limit && (
                  <p className="text-sm text-gray-500">{t("nearbyPlaces.full", { limit })}</p>
                )
              )}
              {!formOpen && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    ref={categoriesButton}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                    onClick={() => open({ kind: "categories" }, () => categoriesButton.current)}
                  >
                    <PencilSquareIcon aria-hidden="true" className="h-4 w-4" />
                    {t("nearbyPlaces.editCategories")}
                  </button>
                </div>
              )}
            </>
          )}
        </fieldset>
      </div>

      <div className="mt-6 flex flex-col gap-3 border-t border-gray-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-600">
          {t("nearbyPlaces.footer.count", { count: places.length, limit })}
          {" · "}
          <span className={`font-semibold ${dirty ? "text-amber-700" : "text-gray-700"}`}>
            {dirty ? t("nearbyPlaces.footer.unsaved") : t("nearbyPlaces.footer.saved")}
          </span>
        </p>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button
            type="button"
            className={button}
            disabled={busy || (!dirty && !formOpen && !locationDirty)}
            onClick={() => {
              createdInForm.current = [];
              setMode(null);
              setNewCategory(null);
              onDiscard();
            }}
          >
            {t("nearbyPlaces.footer.discard")}
          </button>
          <button
            type="button"
            className={primary}
            disabled={
              busy ||
              disabled ||
              formOpen ||
              (!dirty && !reconfirm) ||
              draft.customCategories.some((category) => !category.name.trim())
            }
            onClick={onSave}
          >
            {busy ? t("nearbyPlaces.footer.saving") : t("nearbyPlaces.footer.save")}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Name, category (with "New category") and tip, shared by the add and edit forms. */
function PlaceFormFields({
  t,
  form,
  categories,
  savedNote,
  newCategory,
  canAddCategory,
  onChange,
  onNewCategory,
  onAddCategory,
}: {
  t: Translate;
  form: PlaceForm;
  categories: NearbyCategoryView[];
  savedNote: string | null | undefined;
  newCategory: Omit<NearbyCustomCategory, "id"> | null;
  canAddCategory: boolean;
  onChange: (form: Partial<PlaceForm>) => void;
  onNewCategory: (category: Omit<NearbyCustomCategory, "id"> | null) => void;
  onAddCategory: () => void;
}) {
  const tooLong = tipTooLong(form.note, savedNote);
  const counter = useId();
  return (
    <>
      <label className={label}>
        {t("nearbyPlaces.form.name")}
        <input
          className={input}
          value={form.name}
          maxLength={120}
          // A form opened by a button moves the focus into it; it goes back when the form closes.
          autoFocus
          onChange={(event) => onChange({ name: plain(event.target.value) })}
        />
      </label>
      <fieldset>
        <legend className={label}>{t("nearbyPlaces.form.category")}</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {categories.map((category) => (
            <CategoryChip
              key={category.id}
              category={category}
              name={nearbyCategoryName(category, t)}
              selected={form.category === category.id}
              onSelect={() => onChange({ category: category.id })}
            />
          ))}
          {canAddCategory && (
            <button
              type="button"
              aria-expanded={Boolean(newCategory)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed px-3 text-[13px] font-semibold text-blue-700 ${
                newCategory
                  ? "border-blue-600 bg-white"
                  : "border-blue-300 bg-white hover:bg-blue-50"
              }`}
              onClick={() =>
                onNewCategory(
                  newCategory ? null : { name: "", color: "pink", icon: "musical-note" },
                )
              }
            >
              <PlusIcon aria-hidden="true" className="h-4 w-4" />
              {t("nearbyPlaces.category.new")}
            </button>
          )}
        </div>
        {!canAddCategory && (
          <p className="mt-1.5 text-xs text-gray-500">
            {t("nearbyPlaces.category.full", { limit: NEARBY_MAX_CUSTOM_CATEGORIES })}
          </p>
        )}
        {newCategory && (
          <NewCategoryForm
            t={t}
            value={newCategory}
            onChange={onNewCategory}
            onCancel={() => onNewCategory(null)}
            onAdd={onAddCategory}
          />
        )}
      </fieldset>
      <div>
        <label className={label}>
          {t("nearbyPlaces.form.tip")}{" "}
          <span className="text-xs font-normal text-gray-500">
            {t("nearbyPlaces.form.optional")}
          </span>
          <textarea
            className={`${input} min-h-[64px]`}
            rows={2}
            value={form.note}
            aria-invalid={tooLong || undefined}
            aria-describedby={counter}
            onChange={(event) => onChange({ note: plain(event.target.value) })}
          />
        </label>
        <p
          id={counter}
          className={`mt-1 text-right text-xs ${tooLong ? "font-semibold text-red-700" : "text-gray-500"}`}
        >
          {tooLong && (
            <span className="mr-2">
              {t("nearbyPlaces.form.tipTooLong", { max: NEARBY_TIP_MAX_LENGTH })}
            </span>
          )}
          {t("nearbyPlaces.form.count", {
            count: form.note.trim().length,
            max: NEARBY_TIP_MAX_LENGTH,
          })}
        </p>
      </div>
    </>
  );
}

function CategoryChip({
  category,
  name,
  selected,
  onSelect,
}: {
  category: Pick<NearbyCategoryView, "color" | "icon">;
  name: string;
  selected: boolean;
  onSelect?: () => void;
}) {
  const Icon = nearbyCategoryIcons[category.icon];
  const color = NEARBY_CATEGORY_HEX[category.color];
  const content = (
    <>
      <Icon
        aria-hidden="true"
        className="h-4 w-4 shrink-0"
        style={selected ? undefined : { color }}
      />
      <span className="truncate">{name}</span>
    </>
  );
  const className =
    "inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold";
  const style = selected
    ? { backgroundColor: color, borderColor: color, color: "#FFFFFF" }
    : { borderColor: "rgb(229 231 235)", backgroundColor: "#FFFFFF", color: "rgb(17 24 39)" };
  // The new category's preview is a picture of the chip, not a choice.
  if (!onSelect)
    return (
      <span className={className} style={style}>
        {content}
      </span>
    );
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={className}
      style={style}
      onClick={onSelect}
    >
      {content}
    </button>
  );
}

/** "New category": name, one of 7 colours and 8 icons, and a preview of its marker and chip. */
function NewCategoryForm({
  t,
  value,
  onChange,
  onCancel,
  onAdd,
}: {
  t: Translate;
  value: Omit<NearbyCustomCategory, "id">;
  onChange: (value: Omit<NearbyCustomCategory, "id">) => void;
  onCancel: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="mt-3 space-y-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-bold text-gray-950">{t("nearbyPlaces.category.new")}</p>
        <p className="text-xs text-gray-500">{t("nearbyPlaces.category.newHint")}</p>
      </div>
      <div>
        <label className={label}>
          {t("nearbyPlaces.category.name")}
          <input
            className={input}
            value={value.name}
            maxLength={NEARBY_CATEGORY_NAME_MAX_LENGTH}
            onChange={(event) => onChange({ ...value, name: plain(event.target.value) })}
          />
        </label>
        <p className="mt-1 text-right text-xs text-gray-500">
          {t("nearbyPlaces.form.count", {
            count: value.name.length,
            max: NEARBY_CATEGORY_NAME_MAX_LENGTH,
          })}
        </p>
      </div>
      <fieldset>
        <legend className={label}>{t("nearbyPlaces.category.colour")}</legend>
        <div className="mt-2 flex flex-wrap gap-2.5">
          {NEARBY_CUSTOM_CATEGORY_COLORS.map((color) => (
            <label key={color} className="cursor-pointer">
              <input
                type="radio"
                name="nearby-category-colour"
                className="peer sr-only"
                checked={value.color === color}
                onChange={() => onChange({ ...value, color })}
              />
              <span className="sr-only">{t(`nearbyPlaces.colour.${color}`)}</span>
              <span
                aria-hidden="true"
                className="block h-7 w-7 rounded-full peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-blue-600"
                style={{
                  backgroundColor: NEARBY_CATEGORY_HEX[color],
                  boxShadow:
                    value.color === color
                      ? `0 0 0 2px #FFFFFF, 0 0 0 4px ${NEARBY_CATEGORY_HEX[color]}`
                      : undefined,
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className={label}>{t("nearbyPlaces.category.icon")}</legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {NEARBY_CATEGORY_ICONS.map((icon) => {
            const Icon = nearbyCategoryIcons[icon];
            const selected = value.icon === icon;
            const color = NEARBY_CATEGORY_HEX[value.color];
            return (
              <label key={icon} className="cursor-pointer">
                <input
                  type="radio"
                  name="nearby-category-icon"
                  className="peer sr-only"
                  checked={selected}
                  onChange={() => onChange({ ...value, icon })}
                />
                <span className="sr-only">{t(`nearbyPlaces.icon.${icon}`)}</span>
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 items-center justify-center rounded-lg border peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-600"
                  style={
                    selected
                      ? { borderColor: color, borderWidth: 2, backgroundColor: `${color}1A`, color }
                      : { borderColor: "rgb(229 231 235)", color: "rgb(75 85 99)" }
                  }
                >
                  <Icon className="h-[18px] w-[18px]" />
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div>
        <p className={label}>{t("nearbyPlaces.category.preview")}</p>
        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
          <span className="rounded-full ring-2 ring-white shadow">
            <NearbyCategoryBadge category={value} size={28} />
          </span>
          <CategoryChip
            category={value}
            name={value.name.trim() || t("nearbyPlaces.category.new")}
            selected
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={onCancel}>
          {t("nearbyPlaces.form.cancel")}
        </button>
        <button type="button" className={primary} disabled={!value.name.trim()} onClick={onAdd}>
          {t("nearbyPlaces.category.add")}
        </button>
      </div>
    </div>
  );
}

/** "Edit categories": rename the four standard ones, rename or delete the host's own. Deleting one whose places
 * remain asks where they move, or removes them too (the approved board notes, VAY-2326). */
function CategoriesPanel({
  t,
  draft,
  setDraft,
  onClose,
}: {
  t: Translate;
  draft: NearbyCurationState;
  setDraft: (update: (current: NearbyCurationState) => NearbyCurationState) => void;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState<{ id: string; moveTo: string } | null>(null);
  // What the host types. An emptied standard name brings the standard one back; an emptied name of the host's own
  // keeps its last name, so a category never goes nameless.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const categories = nearbyCategoryViews(draft);
  const rename = (id: string, value: string) => {
    const name = plain(value);
    setTyped((current) => ({ ...current, [id]: name }));
    setDraft((current) => {
      if (!isStandardCategory(id))
        return name.trim()
          ? {
              ...current,
              customCategories: current.customCategories.map((category) =>
                category.id === id ? { ...category, name } : category,
              ),
            }
          : current;
      // In the categories' own order, so renaming back and forth doesn't count as a change.
      const names: Record<string, string> = {};
      for (const key of NEARBY_CATEGORIES) {
        const next = key === id ? name : current.categoryNames[key];
        if (next?.trim()) names[key] = next;
      }
      return { ...current, categoryNames: names };
    });
  };
  const row = (category: NearbyCategoryView, extra?: ReactNode) => {
    const standardName = t(`nearbyPlaces.category.${category.id}`);
    const standard = isStandardCategory(category.id);
    return (
      <li key={category.id} className="space-y-2">
        <div className="flex items-center gap-2.5">
          <NearbyCategoryBadge category={category} size={28} />
          <input
            aria-label={t("nearbyPlaces.categories.rename", {
              name: standard ? standardName : (category.name ?? ""),
            })}
            className={`${input} mt-0 min-w-0 flex-1`}
            value={
              typed[category.id] ??
              (standard
                ? (draft.categoryNames[category.id as keyof typeof draft.categoryNames] ?? "")
                : (category.name ?? ""))
            }
            autoFocus={category.id === categories[0].id}
            placeholder={standard ? standardName : undefined}
            maxLength={NEARBY_CATEGORY_NAME_MAX_LENGTH}
            onChange={(event) => rename(category.id, event.target.value)}
          />
          {extra}
        </div>
      </li>
    );
  };
  const target = deleting && categories.find((category) => category.id === deleting.id);
  const used = deleting
    ? draft.customPlaces.filter((place) => place.category === deleting.id).length
    : 0;
  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/60 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-bold text-gray-950">
            {t("nearbyPlaces.categories.title")}
          </h3>
          <p className="mt-0.5 text-xs text-gray-600">{t("nearbyPlaces.categories.hint")}</p>
        </div>
        <button
          type="button"
          aria-label={t("nearbyPlaces.form.close")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-white"
          onClick={onClose}
        >
          <XMarkIcon aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
          {t("nearbyPlaces.categories.standard")}
        </p>
        <ul className="mt-2 space-y-2">
          {categories.filter((c) => isStandardCategory(c.id)).map((c) => row(c))}
        </ul>
      </div>
      {draft.customCategories.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
            {t("nearbyPlaces.categories.yours")}
          </p>
          <ul className="mt-2 space-y-2">
            {categories
              .filter((category) => !isStandardCategory(category.id))
              .map((category) =>
                row(
                  category,
                  <button
                    type="button"
                    aria-label={t("nearbyPlaces.categories.delete", { name: category.name ?? "" })}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-red-600 hover:bg-red-50"
                    onClick={() => setDeleting({ id: category.id, moveTo: "food" })}
                  >
                    <TrashIcon aria-hidden="true" className="h-5 w-5" />
                  </button>,
                ),
              )}
          </ul>
        </div>
      )}
      {target && deleting && (
        <div
          role="group"
          aria-label={t("nearbyPlaces.categories.deleteTitle", { name: target.name ?? "" })}
          className="rounded-lg border border-red-200 bg-red-50 p-4"
        >
          <p className="text-sm font-bold text-gray-900">
            {t("nearbyPlaces.categories.deleteTitle", { name: target.name ?? "" })}
          </p>
          {used === 0 ? (
            <p className="mt-1 text-sm text-gray-700">{t("nearbyPlaces.categories.unused")}</p>
          ) : (
            <label className="mt-1 block text-sm text-gray-700">
              {t(
                used === 1
                  ? "nearbyPlaces.categories.used.one"
                  : "nearbyPlaces.categories.used.other",
                {
                  count: used,
                },
              )}
              <select
                className={input}
                value={deleting.moveTo}
                onChange={(event) => setDeleting({ ...deleting, moveTo: event.target.value })}
              >
                {categories
                  .filter((category) => category.id !== deleting.id)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {nearbyCategoryName(category, t)}
                    </option>
                  ))}
                <option value="">{t("nearbyPlaces.categories.removePlaces")}</option>
              </select>
            </label>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={button} onClick={() => setDeleting(null)}>
              {t("nearbyPlaces.categories.keep")}
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  ...deleteNearbyCategory(current, deleting.id, deleting.moveTo || null),
                }));
                setDeleting(null);
              }}
            >
              {t("nearbyPlaces.categories.confirmDelete")}
            </button>
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <button type="button" className={primary} onClick={onClose}>
          {t("nearbyPlaces.categories.done")}
        </button>
      </div>
    </div>
  );
}

/** The six-dot drag handle the boards draw. */
function GripIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 18" className="h-[18px] w-3" fill="currentColor">
      {[3, 9, 15].flatMap((y) => [
        <circle key={`l${y}`} cx="3" cy={y} r="1.5" />,
        <circle key={`r${y}`} cx="9" cy={y} r="1.5" />,
      ])}
    </svg>
  );
}
