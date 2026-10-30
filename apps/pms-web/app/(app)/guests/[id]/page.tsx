"use client";

import {
  use,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  EllipsisHorizontalIcon,
  EnvelopeIcon,
  HomeModernIcon,
  PencilIcon,
  PhoneIcon,
} from "@heroicons/react/24/outline";
import { nationalityLabel } from "@vayada/locale-constants";
import Modal from "@/components/Modal";
import { NationalitySelect } from "@/components/NationalitySelect";
import { GuestNotes } from "@/components/guests/GuestNotes";
import { useTranslation } from "@/lib/i18n";
import { useHasPmsPermission } from "@/lib/settings/PmsAccessContext";
import { countLabel } from "@/lib/checkin/labels";
import { BIRTH_DATE_PLACEHOLDER, birthDateInput } from "@/lib/checkin/birthDate";
import { bookingChannelLabel } from "@/lib/bookings/channelLabel";
import { formatCurrency } from "@/lib/formatCurrency";
import {
  formatGuestDate,
  formatStayDates,
  guestInitials,
  localToday,
  propertyColor,
  stayNights,
  stayRoleKey,
  stayStatus,
} from "@/lib/guests/guestDisplay";
import { guestForm, guestFormChanges, type GuestForm } from "@/lib/guests/guestEdit";
import {
  getStoredPmsPropertyId,
  storeSelectedPmsPropertyId,
} from "@/services/api/pmsPropertyClient";
import { HIDDEN_GUEST_CONTACT } from "@/services/bookings";
import {
  guestsService,
  type GuestDocumentType,
  type GuestFields,
  type GuestProfile,
  type GuestStay,
  type GuestSummary,
} from "@/services/guests";

const CARD = "bg-white border border-[#E4E7EC] rounded-2xl";
const INPUT =
  "mt-1 w-full h-10 rounded-[10px] border border-[#D0D5DD] bg-white px-3 text-sm text-[#101828] outline-none focus:border-[#2D3FD3] disabled:bg-gray-50 disabled:text-gray-500";
const SECONDARY_BUTTON =
  "inline-flex items-center justify-center gap-2 h-11 px-4 rounded-[10px] border border-[#D0D5DD] bg-white font-semibold text-sm text-[#101828] hover:bg-gray-50 disabled:opacity-50";
const PRIMARY_BUTTON =
  "inline-flex items-center justify-center h-10 px-4 rounded-[10px] bg-[#2D3FD3] text-sm font-semibold text-white hover:bg-[#1F2DA3] disabled:opacity-50";
const FIELDS: (keyof GuestFields)[] = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "countryCode",
  "dateOfBirth",
  "documentType",
  "documentNumber",
];
// Without guest contact access these stay hidden (and can't be edited).
const CONTACT_FIELDS: (keyof GuestFields)[] = [
  "email",
  "phone",
  "dateOfBirth",
  "documentType",
  "documentNumber",
];
const DOCUMENT_TYPES: GuestDocumentType[] = ["passport", "national_id", "driving_licence", "other"];

/** VAY-2420: one guest record with its stays across the account's properties (Timo's mockup). */
export default function GuestProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { locale, t } = useTranslation();
  const [guest, setGuest] = useState<GuestProfile | null>(null);
  const [loadError, setLoadError] = useState<"not_found" | "failed" | null>(null);
  // The form, and what it showed when Edit was opened: only fields staff changed from that are sent.
  const [editing, setEditing] = useState<{ shown: GuestForm; form: GuestForm } | null>(null);
  const [triedSave, setTriedSave] = useState(false);
  const [saving, setSaving] = useState(false);
  // Edits, merges, separations and notes need the operations permission (front desk can only read).
  const canManage = useHasPmsPermission("pms.operations.manage");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; href?: string } | null>(null);
  const [dialog, setDialog] = useState<"merge" | "separate" | null>(null);

  useEffect(() => {
    let alive = true;
    guestsService
      .get(id)
      .then((profile) => alive && setGuest(profile))
      .catch((err: { status?: number }) =>
        alive ? setLoadError(err?.status === 404 ? "not_found" : "failed") : undefined,
      );
    return () => {
      alive = false;
    };
  }, [id]);

  if (!guest)
    return (
      <div className="p-4 md:p-6">
        <div className="max-w-[960px] mx-auto">
          <Breadcrumb name={null} />
          <p className="mt-10 text-center text-sm text-[#5B6474]">
            {loadError === "not_found"
              ? t("guests.notFound")
              : loadError
                ? t("guests.failedToLoadGuest")
                : t("common.loading")}
          </p>
        </div>
      </div>
    );

  const name = `${guest.firstName} ${guest.lastName}`.trim();
  const today = localToday();
  const changes = editing ? guestFormChanges(editing.shown, editing.form, today) : {};
  const namesMissing =
    editing !== null && (!editing.form.firstName.trim() || !editing.form.lastName.trim());
  // A date of birth is judged once all 8 digits are typed, or on Save.
  const birthDateInvalid =
    changes === "invalid_birth_date" &&
    (triedSave || editing!.form.dateOfBirth.replace(/\D/g, "").length >= 8);
  // Hidden until the request is accepted: email and phone can't be read or changed yet.
  const contactLocked = (field: keyof GuestFields) =>
    (!guest.canReadContact && CONTACT_FIELDS.includes(field)) ||
    (guest.contactHidden && (field === "email" || field === "phone"));

  const save = async () => {
    setTriedSave(true);
    if (!editing || changes === "invalid_birth_date") return;
    if (Object.keys(changes).length === 0) return setEditing(null);
    setSaving(true);
    setError("");
    try {
      setGuest(await guestsService.edit(guest.guestProfileId, changes));
      setEditing(null);
    } catch (err) {
      setError(
        (err as { data?: { code?: string } })?.data?.code === "guest_contact_hidden"
          ? t("guests.contactHiddenError")
          : t("guests.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const fieldValue = (field: keyof GuestFields): ReactNode => {
    const value = guest.fields[field];
    if (!value)
      return (
        <span className="text-[#667085]">
          {guest.contactHidden && (field === "email" || field === "phone")
            ? HIDDEN_GUEST_CONTACT
            : !guest.canReadContact && CONTACT_FIELDS.includes(field)
              ? t("guests.hidden")
              : t("guests.notProvided")}
        </span>
      );
    if (field === "countryCode") return nationalityLabel(value) ?? value;
    if (field === "dateOfBirth") return formatGuestDate(value, locale);
    if (field === "documentType") return t(`checkIn.flow.document.${value}`);
    return value;
  };

  const fieldInput = (field: keyof GuestFields) => {
    const { form } = editing!;
    const label = t(`settings.checkIn.field.${field === "countryCode" ? "nationality" : field}`);
    const locked = contactLocked(field);
    const set = (value: string) => setEditing({ ...editing!, form: { ...form, [field]: value } });
    if (field === "countryCode")
      return (
        <NationalitySelect
          label={<span className="text-[13px] text-[#5B6474]">{label}</span>}
          value={form.countryCode}
          onChange={set}
          labelClassName="block"
          inputClassName={INPUT}
        />
      );
    return (
      <label className="block">
        <span className="text-[13px] text-[#5B6474]">{label}</span>
        {field === "documentType" ? (
          <select
            value={form.documentType}
            disabled={locked}
            onChange={(event) => set(event.target.value)}
            className={INPUT}
          >
            <option value="">{t("checkIn.flow.form.choose")}</option>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`checkIn.flow.document.${type}`)}
              </option>
            ))}
          </select>
        ) : (
          <input
            type={field === "email" ? "email" : field === "phone" ? "tel" : "text"}
            inputMode={field === "dateOfBirth" ? "numeric" : undefined}
            placeholder={field === "dateOfBirth" ? BIRTH_DATE_PLACEHOLDER : undefined}
            value={form[field]}
            disabled={locked}
            onChange={(event) =>
              set(field === "dateOfBirth" ? birthDateInput(event.target.value) : event.target.value)
            }
            className={INPUT}
          />
        )}
      </label>
    );
  };

  return (
    <div className="p-4 md:px-6 md:pt-7 md:pb-12">
      <div className="max-w-[960px] mx-auto flex flex-col gap-5">
        <Breadcrumb name={name} />

        {notice && (
          <p
            role="status"
            className="rounded-xl bg-[#EEF0FD] px-4 py-3 text-sm text-[#101828] flex flex-wrap gap-2"
          >
            {notice.text}
            {notice.href && (
              <Link href={notice.href} className="font-semibold text-[#2D3FD3]">
                {t("guests.openNewGuest")}
              </Link>
            )}
          </p>
        )}

        {/* Profile header */}
        <section className={`${CARD} p-6 flex flex-col gap-5`}>
          <div className="flex flex-wrap items-center gap-5">
            <span
              aria-hidden="true"
              className="w-16 h-16 rounded-full bg-[#EEF0FD] text-[#2D3FD3] text-[22px] font-semibold flex items-center justify-center shrink-0"
            >
              {guestInitials(guest.firstName, guest.lastName)}
            </span>
            <div className="flex-[1_1_320px] min-w-0 flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-[26px] leading-[1.2] font-bold text-[#101828] break-words">
                  {name}
                </h1>
                {guest.reservations > 1 && (
                  <span className="rounded-full bg-[#EEF0FD] px-2.5 py-[3px] text-xs font-semibold text-[#2D3FD3]">
                    {t("guests.returningGuest")}
                  </span>
                )}
              </div>
              {(guest.email || guest.phone) && (
                <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-[#475467]">
                  {guest.email && (
                    <span className="flex items-center gap-1.5 min-w-0 break-all">
                      <EnvelopeIcon className="w-[15px] h-[15px] shrink-0" aria-hidden="true" />
                      {guest.email}
                    </span>
                  )}
                  {guest.phone && (
                    <span className="flex items-center gap-1.5">
                      <PhoneIcon className="w-[15px] h-[15px] shrink-0" aria-hidden="true" />
                      {guest.phone}
                    </span>
                  )}
                </div>
              )}
            </div>
            {canManage && (
              <div className="flex gap-2.5">
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  disabled={editing !== null}
                  onClick={() => {
                    const shown = guestForm(guest.fields);
                    setError("");
                    setTriedSave(false);
                    setEditing({ shown, form: shown });
                  }}
                >
                  <PencilIcon className="w-4 h-4" aria-hidden="true" />
                  {t("guests.editGuest")}
                </button>
                <MoreActions
                  disabled={editing !== null}
                  label={t("guests.moreActions")}
                  items={[
                    { label: t("guests.mergeAction"), onSelect: () => setDialog("merge") },
                    ...(guest.stays.length > 1
                      ? [
                          {
                            label: t("guests.separateAction"),
                            onSelect: () => setDialog("separate"),
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
            {[
              [t("guests.statReservations"), String(guest.reservations)],
              [
                t("guests.statNextArrival"),
                guest.nextArrival ? formatGuestDate(guest.nextArrival, locale, false) : "—",
              ],
              [t("guests.statGuestSince"), formatGuestDate(guest.guestSince.slice(0, 10), locale)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-[#F9FAFB] px-4 py-3">
                <div className="text-xs text-[#5B6474]">{label}</div>
                <div className="text-xl font-bold text-[#101828]">{value}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Guest data */}
        <section className={`${CARD} px-6 py-5`} aria-labelledby="guest-data">
          <h2 id="guest-data" className="text-[17px] font-semibold text-[#101828]">
            {t("guests.guestData")}
          </h2>
          {editing ? (
            <div className="mt-3.5">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6 gap-y-4">
                {FIELDS.map((field) => (
                  <div key={field}>{fieldInput(field)}</div>
                ))}
              </div>
              {(namesMissing || birthDateInvalid || error) && (
                <p role="alert" className="mt-3 text-sm text-red-600">
                  {namesMissing
                    ? t("guests.namesRequired")
                    : birthDateInvalid
                      ? t("guests.invalidBirthDate")
                      : error}
                </p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="h-10 px-4 rounded-[10px] text-sm font-semibold text-[#344054] hover:bg-gray-100"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || namesMissing || birthDateInvalid}
                  className={PRIMARY_BUTTON}
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
          ) : (
            <dl className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6">
              {FIELDS.map((field) => (
                <div key={field} className="py-3 border-t border-[#EAECF0]">
                  <dt className="text-[13px] text-[#5B6474]">
                    {t(`settings.checkIn.field.${field === "countryCode" ? "nationality" : field}`)}
                  </dt>
                  <dd className="mt-0.5 font-medium text-[#101828] [overflow-wrap:anywhere]">
                    {fieldValue(field)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-1 pt-3 border-t border-[#EAECF0] text-xs text-[#5B6474]">
            {t("guests.dataFootnote")}
          </p>
        </section>

        {/* Stay history */}
        <section className={`${CARD} overflow-hidden`} aria-labelledby="stay-history">
          <h2
            id="stay-history"
            className="px-6 py-[18px] border-b border-[#EAECF0] text-[17px] font-semibold text-[#101828]"
          >
            {t("guests.stayHistory")}
          </h2>
          {guest.stays.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-[#5B6474]">{t("guests.noStays")}</p>
          ) : (
            <ul>
              {guest.stays.map((stay) => (
                <li key={stay.bookingGuestId} className="border-b border-[#EAECF0] last:border-0">
                  <StayRow stay={stay} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <GuestNotes
          guestProfileId={guest.guestProfileId}
          firstName={guest.firstName}
          notes={guest.notes}
          onNotesChange={(notes) => setGuest({ ...guest, notes })}
          propertyName={(propertyId) =>
            guest.stays.find((stay) => stay.propertyId === propertyId)?.propertyName ?? null
          }
        />
      </div>

      {dialog === "merge" && (
        <MergeDialog
          guest={guest}
          onClose={() => setDialog(null)}
          onMerged={(profile, other) => {
            setGuest(profile);
            setDialog(null);
            setNotice({ text: t("guests.mergedNotice", { name: other }) });
          }}
        />
      )}
      {dialog === "separate" && (
        <SeparateDialog
          guest={guest}
          onClose={() => setDialog(null)}
          onSeparated={(newGuestProfileId) => {
            setDialog(null);
            guestsService
              .get(guest.guestProfileId)
              .then(setGuest)
              .catch(() => undefined);
            setNotice({
              text: t("guests.separatedNotice"),
              href: `/guests/${newGuestProfileId}`,
            });
          }}
        />
      )}
    </div>
  );
}

function Breadcrumb({ name }: { name: string | null }) {
  const { t } = useTranslation();
  return (
    <nav className="flex items-center gap-2 text-sm text-[#5B6474]" aria-label={t("guests.title")}>
      <Link
        href="/guests"
        aria-label={t("guests.backToGuests")}
        className="w-8 h-8 rounded-lg flex items-center justify-center text-[#344054] hover:bg-gray-100"
      >
        <ArrowLeftIcon className="w-[18px] h-[18px]" aria-hidden="true" />
      </Link>
      <Link href="/guests" className="hover:text-[#101828]">
        {t("guests.title")}
      </Link>
      {name && (
        <>
          <span aria-hidden="true">/</span>
          <span className="text-[#101828] truncate">{name}</span>
        </>
      )}
    </nav>
  );
}

/** One reservation of the guest. A stay at another property opens there (the PMS switches to it). */
function StayRow({ stay }: { stay: GuestStay }) {
  const { locale, t } = useTranslation();
  const status = stayStatus(stay.status);
  const nights = stayNights(stay.checkIn, stay.checkOut);
  const source =
    stay.channel === "direct" && stay.directSource === "booking_engine"
      ? t("guests.sourceBookingEngine")
      : bookingChannelLabel(stay.channel, t);
  const href = `/bookings/${stay.guestBookingId}`;
  return (
    <a
      href={href}
      onClick={(event) => {
        if (stay.propertyId === getStoredPmsPropertyId()) return;
        // Another property: the PMS switches to it first, so it opens here, not in a new tab.
        event.preventDefault();
        storeSelectedPmsPropertyId(stay.propertyId);
        window.location.assign(href);
      }}
      className="flex flex-wrap items-center gap-x-[18px] gap-y-3 px-6 py-[18px] hover:bg-gray-50"
    >
      <span
        aria-hidden="true"
        className="w-11 h-11 rounded-[10px] flex items-center justify-center shrink-0"
        style={{ backgroundColor: propertyColor(stay.propertyId) }}
      >
        <HomeModernIcon className="w-5 h-5 text-white" />
      </span>
      <span className="flex-[1_1_260px] min-w-0 flex flex-col gap-[3px]">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-[#101828]">{stay.propertyName}</span>
          {status.labelKey && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}>
              {t(status.labelKey)}
            </span>
          )}
        </span>
        <span className="text-sm text-[#475467]">
          {[
            formatStayDates(stay.checkIn, stay.checkOut, locale),
            countLabel(t, "nights", nights),
            ...stay.rooms.map((room) => t("guests.roomLabel", { name: room })),
            countLabel(t, "adults", stay.adults),
            ...(stay.children ? [countLabel(t, "children", stay.children)] : []),
          ].join(" · ")}
        </span>
        <span className="text-[13px] text-[#5B6474] truncate">
          {[stay.bookingReference, source, t(stayRoleKey(stay.role))].join(" · ")}
        </span>
      </span>
      <span className="ml-auto flex items-center gap-3">
        <span className="text-base font-semibold text-[#101828]">
          {formatCurrency(Number(stay.totalAmount), stay.currency)}
        </span>
        <ChevronRightIcon className="w-[18px] h-[18px] text-[#98A2B3]" aria-hidden="true" />
      </span>
    </a>
  );
}

function MoreActions({
  label,
  items,
  disabled = false,
}: {
  label: string;
  items: { label: string; onSelect: () => void }[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const at = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      entries[
        (at + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length
      ]?.focus();
    } else if (event.key === "Escape") {
      setOpen(false);
      button.current?.focus();
    } else if (event.key === "Tab") setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="w-11 h-11 rounded-[10px] border border-[#D0D5DD] bg-white text-[#344054] flex items-center justify-center hover:bg-gray-50 disabled:opacity-50"
      >
        <EllipsisHorizontalIcon className="w-[18px] h-[18px]" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-12 z-20 min-w-[220px] rounded-xl border border-[#E4E7EC] bg-white py-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="block w-full px-4 py-2.5 text-left text-sm text-[#101828] hover:bg-gray-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Dialog({
  title,
  onClose,
  actions,
  children,
}: {
  title: string;
  onClose: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <Modal onClose={onClose} maxWidth="lg" ariaLabel={title} footer={actions}>
      <h2 className="text-[17px] font-semibold text-[#101828]">{title}</h2>
      {children}
    </Modal>
  );
}

/** D7: two records that are one person. The other guest's stays and notes move to this one. */
function MergeDialog({
  guest,
  onClose,
  onMerged,
}: {
  guest: GuestProfile;
  onClose: () => void;
  onMerged: (profile: GuestProfile, otherName: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(guest.lastName);
  // null while searching; "failed" when the search couldn't run.
  const [candidates, setCandidates] = useState<GuestSummary[] | "failed" | null>(null);
  const [chosen, setChosen] = useState<GuestSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = `${guest.firstName} ${guest.lastName}`.trim();

  useEffect(() => {
    let alive = true;
    // A guest no longer listed can't stay chosen.
    setChosen(null);
    setCandidates(null);
    const timer = setTimeout(() => {
      guestsService
        .search(query, 10)
        .then(
          (list) =>
            alive &&
            setCandidates(list.filter((other) => other.guestProfileId !== guest.guestProfileId)),
        )
        .catch(() => alive && setCandidates("failed"));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, guest.guestProfileId]);

  const merge = async () => {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      onMerged(
        await guestsService.merge(guest.guestProfileId, chosen.guestProfileId),
        `${chosen.firstName} ${chosen.lastName}`.trim(),
      );
    } catch {
      setError(t("guests.mergeFailed"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("guests.mergeTitle")}
      onClose={onClose}
      actions={
        <DialogActions
          onCancel={onClose}
          confirm={t("guests.mergeConfirm")}
          onConfirm={merge}
          disabled={!chosen || busy}
        />
      }
    >
      <p className="mt-1 text-sm text-[#475467]">{t("guests.mergeHelp", { name })}</p>
      <label className="mt-4 block">
        <span className="text-[13px] text-[#5B6474]">{t("guests.searchLabel")}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("guests.searchPlaceholder")}
          className={INPUT}
        />
      </label>
      <ul className="mt-3 rounded-xl border border-[#EAECF0]">
        {candidates === null || candidates === "failed" || candidates.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-[#5B6474]">
            {candidates === null
              ? t("common.loading")
              : candidates === "failed"
                ? t("guests.failedToLoad")
                : t("guests.noMatches", { query: query.trim() })}
          </li>
        ) : (
          candidates.map((other) => (
            <li key={other.guestProfileId} className="border-b border-[#EAECF0] last:border-0">
              <label className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="merge-guest"
                  checked={chosen?.guestProfileId === other.guestProfileId}
                  onChange={() => setChosen(other)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[#101828]">
                    {`${other.firstName} ${other.lastName}`.trim()}
                  </span>
                  <span className="block text-[13px] text-[#5B6474] truncate">
                    {[
                      other.email,
                      other.phone,
                      t(
                        other.reservations === 1
                          ? "guests.reservationsOne"
                          : "guests.reservationsMany",
                        { count: other.reservations },
                      ),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </label>
            </li>
          ))
        )}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** D7: one stay that belongs to somebody else gets its own guest record, from its booking's copy. */
function SeparateDialog({
  guest,
  onClose,
  onSeparated,
}: {
  guest: GuestProfile;
  onClose: () => void;
  onSeparated: (newGuestProfileId: string) => void;
}) {
  const { locale, t } = useTranslation();
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const separate = async () => {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      onSeparated((await guestsService.separate(guest.guestProfileId, chosen)).guestProfileId);
    } catch {
      setError(t("guests.separateFailed"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("guests.separateTitle")}
      onClose={onClose}
      actions={
        <DialogActions
          onCancel={onClose}
          confirm={t("guests.separateConfirm")}
          onConfirm={separate}
          disabled={!chosen || busy}
        />
      }
    >
      <p className="mt-1 text-sm text-[#475467]">{t("guests.separateHelp")}</p>
      <ul className="mt-4 rounded-xl border border-[#EAECF0]">
        {guest.stays.map((stay) => (
          <li key={stay.bookingGuestId} className="border-b border-[#EAECF0] last:border-0">
            <label className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="separate-stay"
                checked={chosen === stay.bookingGuestId}
                onChange={() => setChosen(stay.bookingGuestId)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[#101828]">
                  {stay.propertyName}
                </span>
                <span className="block text-[13px] text-[#5B6474] truncate">
                  {[
                    formatStayDates(stay.checkIn, stay.checkOut, locale),
                    stay.bookingReference,
                  ].join(" · ")}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function DialogActions({
  onCancel,
  confirm,
  onConfirm,
  disabled,
}: {
  onCancel: () => void;
  confirm: string;
  onConfirm: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="h-10 px-4 rounded-[10px] text-sm font-semibold text-[#344054] hover:bg-gray-100"
      >
        {t("common.cancel")}
      </button>
      <button type="button" disabled={disabled} className={PRIMARY_BUTTON} onClick={onConfirm}>
        {confirm}
      </button>
    </div>
  );
}
