"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import {
  analyticsChoice,
  clearAnalyticsSession,
  onAnalyticsChoicesOpened,
  saveAnalyticsChoice,
} from "@/services/api/analyticsConsent";

// The guest section of Vayada's privacy policy (English only).
const PRIVACY_NOTICE_URL = "https://vayada.com/privacy#booking-guests";

export default function AnalyticsConsent() {
  const { slug } = useSlug();
  const { hotel } = useHotel();
  const t = useTranslations("analyticsConsent");
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  // What opened the prompt (the footer's "Privacy choices" link) gets focus back when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const sync = () => {
      const saved = analyticsChoice(slug);
      setChoice(saved);
      setOpen(saved === null);
      if (saved !== true) clearAnalyticsSession(slug);
    };
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [slug]);
  useEffect(
    () =>
      onAnalyticsChoicesOpened((from) => {
        opener.current = from;
        setOpen(true);
        // Already open (it opens by itself until answered): focus moves into it.
        panel.current?.focus({ preventScroll: true });
      }),
    [],
  );
  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        opener.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  if (!slug || !open) return null;
  const save = (enabled: boolean) => {
    const saved = saveAnalyticsChoice(slug, enabled);
    setError(!saved);
    setChoice(saved ? enabled : false);
    if (saved) {
      setOpen(false);
      opener.current?.focus();
    }
  };
  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-labelledby="booking-analytics-title"
      className="fixed bottom-[calc(0.75rem+var(--fixed-bottom-bar,0px))] left-3 right-3 z-50 max-h-[75dvh] max-w-md overflow-auto rounded-xl border bg-white p-5 text-gray-900 shadow-xl"
    >
      <h2 id="booking-analytics-title" className="font-semibold">
        {t("title")}
      </h2>
      <p className="mt-3 text-sm">{t("description")}</p>
      <p className="mb-3 mt-2 text-sm">
        {t.rich("controller", {
          hotel: hotel?.name ?? "",
          policy: (chunks) => (
            <a
              href={PRIVACY_NOTICE_URL}
              hrefLang="en"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {chunks}
            </a>
          ),
        })}
      </p>
      {choice !== null && <p className="mb-3 text-sm">{t(choice ? "enabled" : "disabled")}</p>}
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {t("saveError")}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => save(false)}
          className="flex-1 rounded-lg border px-3 py-2 text-sm"
        >
          {t("reject")}
        </button>
        <button
          type="button"
          onClick={() => save(true)}
          className="flex-1 rounded-lg border px-3 py-2 text-sm"
        >
          {t("accept")}
        </button>
      </div>
      {choice !== null && (
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            opener.current?.focus();
          }}
          className="mt-3 text-sm underline"
        >
          {t("close")}
        </button>
      )}
    </section>
  );
}
