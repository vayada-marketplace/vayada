"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseAccountBookingPageUpdate } from "@vayada/domain-booking/account-booking-page";
import { PageLayout } from "@/components/layout/PageLayout";
import { SettingsBreadcrumb } from "@/components/settings/SettingsSubPage";
import {
  FiltersSection,
  HeaderSection,
  LayoutSection,
  PageSection,
  PropertiesSection,
  ResultsSection,
  StayPageSection,
  type SectionProps,
} from "@/components/settings/MultiPropertySections";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import {
  draftProblems,
  pageStatus,
  type AccountBookingPageDraft,
} from "@/lib/utils/accountBookingPage";
import { buildBookingPreviewUrl } from "@/lib/utils/bookingPreviewUrl";
import { uploadSingleImageWithMediaReference, type UploadedImage } from "@/lib/utils/uploadImage";
import {
  accountBookingPageClient,
  type AccountBookingPageSummary,
} from "@/services/api/accountBookingPageClient";
import { ApiErrorResponse } from "@/services/api/client";

const SECTIONS = [
  ["page", "settings.multiProperty.nav.page"],
  ["header", "settings.multiProperty.nav.header"],
  ["properties", "settings.multiProperty.nav.properties"],
  ["layout", "settings.multiProperty.nav.layout"],
  ["results", "settings.multiProperty.nav.results"],
  ["filters", "settings.multiProperty.nav.filters"],
  ["stay", "settings.multiProperty.nav.stayPage"],
] as const;

// next-api's refusals (VAY-2456) and what the member reads.
const SAVE_ERRORS: Record<string, string> = {
  page_changed: "settings.multiProperty.error.changed",
  slug_taken: "settings.multiProperty.error.slugTaken",
  account_needs_two_properties: "settings.multiProperty.error.needsTwo",
  property_not_in_account: "settings.multiProperty.error.notInAccount",
  property_not_ready: "settings.multiProperty.error.notReady",
  design_property_not_included: "settings.multiProperty.error.designNotIncluded",
  no_ready_property: "settings.multiProperty.error.noReadyProperty",
  header_image_invalid: "settings.multiProperty.error.headerImageInvalid",
};

const draftOf = (summary: AccountBookingPageSummary): AccountBookingPageDraft => ({
  slug: summary.page.slug,
  live: summary.page.live,
  settings: structuredClone(summary.page.settings),
  propertyIds: [...summary.page.propertyIds],
  headerImage: summary.page.headerImage,
});

/** The draft as it is saved: text trimmed. Unsaved changes are measured on this. */
const normalized = (draft: AccountBookingPageDraft): AccountBookingPageDraft => ({
  ...draft,
  slug: draft.slug.trim(),
  settings: {
    ...draft.settings,
    page: {
      title: draft.settings.page.title.trim(),
      description: draft.settings.page.description.trim(),
    },
  },
});

/**
 * Settings › Multi-property booking engine (VAY-2457, Timo's admin board in VAY-2450): one booking page
 * for all stays of the account. Seven sections saved together with one Save; next-api checks the revision,
 * so a save made on an older version is refused and the latest one is loaded.
 */
export function MultiPropertyBookingPage({
  client = accountBookingPageClient,
  copyText = (value: string) =>
    navigator.clipboard
      ? navigator.clipboard.writeText(value)
      : Promise.reject(new Error("No clipboard")),
  uploadHeaderImage = (file: File) =>
    uploadSingleImageWithMediaReference(file, "booking.account_page.header_image"),
}: {
  client?: typeof accountBookingPageClient;
  copyText?: (value: string) => Promise<void>;
  uploadHeaderImage?: (file: File) => Promise<UploadedImage>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "failed" | "noAccess" | "ready">("loading");
  const [summary, setSummary] = useState<AccountBookingPageSummary | null>(null);
  const [draft, setDraft] = useState<AccountBookingPageDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [saving, setSaving] = useState(false);
  // An upload landing during a save would be lost when the saved page comes back: Save waits.
  const [uploading, setUploading] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const loadVersion = useRef(0);

  const apply = useCallback((loaded: AccountBookingPageSummary) => {
    const next = draftOf(loaded);
    setSummary(loaded);
    setDraft(next);
    setBaseline(JSON.stringify(normalized(next)));
    setShowProblems(false);
  }, []);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setState("loading");
    try {
      const loaded = await client.load();
      if (version !== loadVersion.current) return;
      apply(loaded);
      setState("ready");
    } catch (error) {
      if (version !== loadVersion.current) return;
      setState(error instanceof ApiErrorResponse && error.status === 403 ? "noAccess" : "failed");
    }
  }, [apply, client]);

  useEffect(() => {
    void load();
    return () => {
      loadVersion.current += 1;
    };
  }, [load]);

  const title = t("settings.cards.multiProperty.title");
  // As PageHeader, but the save note and button may wrap: in longer languages they don't fit
  // next to each other on a phone.
  const header = (actions?: React.ReactNode) => (
    <div className="page-header">
      <div className="mb-2">
        <SettingsBreadcrumb current={title} />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_14rem]">
          <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">{title}</h1>
          <p className="mt-[var(--page-subtitle-gap)] text-[13px] text-gray-500">
            {t("settings.multiProperty.intro")}
          </p>
        </div>
        {actions}
      </div>
    </div>
  );

  if (state !== "ready" || !summary || !draft)
    return (
      <PageLayout>
        <div className="max-w-[880px]">
          {header()}
          <div className="mt-5">
            {state === "loading" ? (
              <div
                className="flex justify-center py-10"
                role="status"
                aria-label={t("common.loading")}
              >
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
              </div>
            ) : (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-white p-5"
              >
                <p className="text-sm text-red-700">
                  {t(
                    state === "noAccess"
                      ? "settings.multiProperty.noAccess"
                      : "settings.feedback.loadError",
                  )}
                </p>
                {state === "failed" && (
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-400"
                  >
                    {t("auth.chooseProperty.retry")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </PageLayout>
    );

  const dirty = JSON.stringify(normalized(draft)) !== baseline;
  const problems = draftProblems(draft);
  // A new page needs two active properties; a saved one can always be kept or switched off.
  const blocked = !summary.canSave && (!summary.saved || draft.live);

  const save = async () => {
    if (saving) return;
    setFeedback(null);
    const { headerImage, ...value } = normalized(draft);
    // Only a changed image is sent, so a save without one works with a next-api that predates it.
    const image = headerImage?.mediaId ?? null;
    const update = parseAccountBookingPageUpdate({
      revision: summary.page.revision,
      ...value,
      ...(image !== (summary.page.headerImage?.mediaId ?? null) && { headerImageMediaId: image }),
    });
    if (problems.size || !update) {
      setShowProblems(true);
      setFeedback({ type: "error", message: t("settings.multiProperty.error.invalid") });
      return;
    }
    setSaving(true);
    try {
      apply(await client.save(update));
      setFeedback({ type: "success", message: t("settings.multiProperty.savedNow") });
    } catch (error) {
      const code = error instanceof ApiErrorResponse ? error.data.code : undefined;
      const known = code ? SAVE_ERRORS[code] : undefined;
      setFeedback({
        type: "error",
        message: t(
          known ??
            (error instanceof ApiErrorResponse && error.status === 403
              ? "settings.multiProperty.noAccess"
              : "settings.multiProperty.error.save"),
        ),
      });
      // Someone saved meanwhile: show their version, so the member edits on top of it.
      if (code === "page_changed") {
        try {
          apply(await client.load());
        } catch {
          // The message already says to reload; the form keeps the member's edits.
        }
      }
    } finally {
      setSaving(false);
    }
  };

  // The address the top bar's Preview opens, on the new system's host (VAY-2483).
  const addressOf = (slug: string) =>
    buildBookingPreviewUrl({
      slug,
      template: process.env.NEXT_PUBLIC_BOOKING_URL_TEMPLATE,
      location: typeof window === "undefined" ? undefined : window.location,
    });
  const sample = addressOf("slug-sample");
  const [addressBefore, addressAfter] = sample?.split("slug-sample") ?? ["https://", ""];
  const props: SectionProps = {
    t,
    draft,
    setDraft: (next) => setDraft(next),
    // For changes that land later (an upload): applied to the draft as it is then.
    updateDraft: (change) => setDraft((current) => (current ? change(current) : current)),
    uploadHeaderImage,
    uploading,
    setUploading,
    summary,
    problems: showProblems ? problems : new Set(),
    disabled: saving,
    dirty,
    status: pageStatus(summary, draft.live),
    address: {
      before: addressBefore ?? "",
      after: addressAfter ?? "",
      url: problems.has("invalidSlug")
        ? null
        : `${addressBefore}${draft.slug.trim()}${addressAfter}`,
      saved: summary.saved ? addressOf(summary.page.slug) : null,
    },
    copyText,
  };

  return (
    <PageLayout>
      <div className="max-w-[880px] pb-16">
        {header(
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-2">
            <span
              data-testid="multi-property-save-note"
              className="text-[13px] text-gray-500"
              aria-live="polite"
            >
              {t(
                dirty
                  ? "settings.multiProperty.unsaved"
                  : summary.saved
                    ? "settings.multiProperty.saved"
                    : "settings.multiProperty.notSaved",
              )}
            </span>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || blocked || uploading}
              className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full bg-primary-500 px-5 text-[14px] font-semibold text-white transition-colors hover:bg-primary-600 disabled:opacity-50"
            >
              {saving && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              {t("settings.multiProperty.save")}
            </button>
          </div>,
        )}
        <div role="status" className="mt-3 empty:hidden">
          {feedback && <FeedbackAlert type={feedback.type} message={feedback.message} />}
        </div>
        {blocked && (
          <p
            role="note"
            className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800"
          >
            {t("settings.multiProperty.error.needsTwo")}
          </p>
        )}
        <nav
          aria-label={t("settings.multiProperty.nav.label")}
          className="mt-5 flex flex-wrap gap-1.5"
        >
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#mp-${id}`}
              className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[13px] font-semibold text-gray-800 hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              {t(label)}
            </a>
          ))}
        </nav>
        <div className="mt-5 flex flex-col gap-5">
          <PageSection {...props} />
          <HeaderSection {...props} />
          <PropertiesSection {...props} />
          <LayoutSection {...props} />
          <ResultsSection {...props} />
          <FiltersSection {...props} />
          <StayPageSection {...props} />
        </div>
      </div>
    </PageLayout>
  );
}
