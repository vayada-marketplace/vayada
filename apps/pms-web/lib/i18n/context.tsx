"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { DEFAULT_LOCALE } from "./languages";
import defaultEnMessages from "../../messages/en.json";

type Messages = Record<string, string>;

interface I18nContextValue {
  locale: string;
  setLocale: (locale: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = "admin_language";

// Cache loaded messages to avoid re-fetching
const messageCache: Record<string, Messages> = {
  en: defaultEnMessages as Messages,
};

async function loadMessages(locale: string): Promise<Messages> {
  if (messageCache[locale]) return messageCache[locale];
  try {
    const messages = (await import(`../../messages/${locale}.json`)).default;
    messageCache[locale] = messages;
    return messages;
  } catch {
    // Fallback to English if locale file not found
    if (locale !== DEFAULT_LOCALE) {
      return loadMessages(DEFAULT_LOCALE);
    }
    return messageCache[DEFAULT_LOCALE] ?? {};
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(DEFAULT_LOCALE);
  const [messages, setMessages] = useState<Messages>(defaultEnMessages as Messages);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored !== DEFAULT_LOCALE) {
      setLocaleState(stored);
      loadMessages(stored).then(setMessages);
    }
  }, []);

  const setLocale = useCallback((newLocale: string) => {
    setLocaleState(newLocale);
    localStorage.setItem(STORAGE_KEY, newLocale);
    document.documentElement.lang = newLocale;
    loadMessages(newLocale).then(setMessages);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let value = messages[key] || key;
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          value = value.replace(`{${k}}`, String(v));
        });
      }
      return value;
    },
    [messages],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useTranslation must be used within a LanguageProvider");
  }
  return context;
}
