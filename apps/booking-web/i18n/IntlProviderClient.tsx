"use client";

import { ReactNode } from "react";
import { NextIntlClientProvider, IntlErrorCode } from "next-intl";
import type { AbstractIntlMessages, IntlError } from "next-intl";

// Wraps NextIntlClientProvider with safe defaults: a missing translation key
// must never crash the page. Components rely on the `t('key') || 'fallback'`
// pattern, so an empty-string fallback is what makes those `||` branches fire.
export default function IntlProviderClient({
  locale,
  messages,
  children,
}: {
  locale: string;
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      getMessageFallback={() => ""}
      onError={(error: IntlError) => {
        if (error.code === IntlErrorCode.MISSING_MESSAGE) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(error.message);
          }
          return;
        }
        console.error(error);
      }}
    >
      {children}
    </NextIntlClientProvider>
  );
}
