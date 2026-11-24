"use client";

import { useCallback, useMemo, useState } from "react";

import { createAssistantApi, type AssistantHttp } from "./assistantApi";
import { ChangeCard, type CardStatus } from "./ChangeCard";
import { oneTapMessagesFor } from "./oneTapMessages";

export { oneTapMessagesFor, type OneTapMessages } from "./oneTapMessages";

/**
 * The one-tap vayada page's card (VAY-2528, D4a): a change an AI app outside vayada asked for over
 * MCP, answered here with one tap, on the same Yes/No card the in-app assistant shows (VAY-2519).
 * The app's own sign-in answers it (the API takes only the person the AI asked, in a vayada app),
 * and the apps never let another site frame a page. The page around it gives the title
 * (`oneTapMessagesFor`). Nothing links here until AI changes on MCP exist.
 */
export function OneTapChange({
  http,
  id,
  locale,
  selectedPropertyId,
}: {
  /** The app's API client, with its own sign-in. */
  http: AssistantHttp;
  /** The change's id, as the AI app's link names it. */
  id: string;
  locale: string;
  /** The hotel open in the app. A change for another one is not shown under its name. */
  selectedPropertyId: string | null;
}) {
  const api = useMemo(() => createAssistantApi(http), [http]);
  const m = useMemo(() => oneTapMessagesFor(locale), [locale]);
  const [view, setView] = useState<CardStatus>(undefined);
  // No waiting bar and no "Ask again" here: the AI app asks again, not this page.
  const onView = useCallback((_id: string, next: CardStatus) => setView(next), []);
  // The card names rooms, not the hotel: under another hotel's name its Yes would read as that
  // one's. Only while it can be answered; an answered one only reports.
  const otherHotel = view?.state === "needs_answer" && view.propertyId !== selectedPropertyId;
  return (
    <>
      {otherHotel && (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {m.otherHotel}
        </p>
      )}
      {view === undefined && <p className="text-[13px] text-gray-500">{m.change.loading}</p>}
      {/* Hidden until it is known whose hotel it is: no Yes flashes under another's name. */}
      <div hidden={view === undefined || otherHotel}>
        <ChangeCard api={api} id={id} m={m.change} locale={locale} onView={onView} />
      </div>
    </>
  );
}
