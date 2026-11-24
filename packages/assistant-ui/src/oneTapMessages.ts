import { assistantMessagesFor, type ChangeMessages } from "./assistantMessages";

/**
 * The one-tap vayada page's words (VAY-2528): an AI app outside vayada (over MCP) asked for a
 * change, and the person answers it on this page, never inside the AI app. The card keeps the
 * in-app card's words (VAY-2519) except where those speak of the chat. English and German; every
 * other language shows English until it is translated.
 */
export type OneTapMessages = {
  title: string;
  intro: string;
  /** The change is for another hotel than the one open: the card stays hidden. */
  otherHotel: string;
  change: ChangeMessages;
};

type OneTapWords = Omit<OneTapMessages, "change"> & {
  /** The card's words that differ from the in-app card's. */
  change: Pick<
    ChangeMessages,
    "footnote" | "doneBody" | "expiredBody" | "changedBody" | "stoppedBody"
  >;
};

const english: OneTapWords = {
  title: "Your AI app asked for a change",
  intro:
    "Check it and answer here. Nothing changes until you say yes, and your AI app can't answer for you.",
  otherHotel:
    "This change is for another of your hotels. Switch to it at the top of the page, or open your AI app's link again.",
  change: {
    footnote:
      "Written by vayada from the stored change. Only this button makes it; nothing your AI app says or does can.",
    doneBody: "You said yes at {time}. You can go back to your AI app.",
    expiredBody:
      "Nothing changed. If you still want it, ask your AI app again: you get a new link with fresh details.",
    changedBody: "Nothing changed. Ask your AI app again to see what's possible now.",
    stoppedBody:
      "AI was switched off for this account, or your AI app's connection to vayada was removed, so vayada didn't make this change.",
  },
};

const german: OneTapWords = {
  title: "Ihre KI-App möchte etwas ändern",
  intro:
    "Prüfen Sie die Änderung und antworten Sie hier. Es ändert sich nichts, bis Sie Ja sagen, und Ihre KI-App kann nicht für Sie antworten.",
  otherHotel:
    "Diese Änderung ist für ein anderes Ihrer Hotels. Wechseln Sie oben auf der Seite zu diesem Hotel oder öffnen Sie den Link Ihrer KI-App nochmal.",
  change: {
    footnote:
      "Von vayada aus der gespeicherten Änderung geschrieben. Nur dieser Knopf führt sie aus; nichts, was Ihre KI-App sagt oder tut, kann das.",
    doneBody: "Sie haben um {time} Ja gesagt. Sie können zu Ihrer KI-App zurückkehren.",
    expiredBody:
      "Es wurde nichts geändert. Wenn Sie es noch möchten, fragen Sie Ihre KI-App nochmal: Sie bekommen einen neuen Link mit aktuellen Angaben.",
    changedBody:
      "Es wurde nichts geändert. Fragen Sie Ihre KI-App nochmal, um zu sehen, was jetzt möglich ist.",
    stoppedBody:
      "KI wurde für dieses Konto ausgeschaltet oder die Verbindung Ihrer KI-App zu vayada wurde entfernt, daher hat vayada diese Änderung nicht ausgeführt.",
  },
};

/** German for "de", English for everything else, as the panel's own words. */
export function oneTapMessagesFor(locale: string): OneTapMessages {
  const words = locale.toLowerCase().startsWith("de") ? german : english;
  return { ...words, change: { ...assistantMessagesFor(locale).change, ...words.change } };
}
