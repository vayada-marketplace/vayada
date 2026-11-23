/**
 * The panel's words (VAY-2519), as on the approved Paper boards (VAY-2517). English and German;
 * every other language the apps offer shows English until it is translated. {placeholders} are
 * filled by `fill`.
 */
export type AssistantMessages = {
  launcher: string;
  title: string;
  aiLabel: string;
  newChat: string;
  yourChats: string;
  close: string;
  back: string;
  noChats: string;
  showMore: string;
  greeting: string;
  greetingNoName: string;
  intro: string;
  tryLabel: string;
  suggestions: [string, string, string, string];
  placeholder: string;
  send: string;
  stop: string;
  disclaimer: string;
  thinking: string;
  toolRunning: string;
  toolDone: string;
  toolFailed: string;
  toolSkipped: string;
  tools: Record<string, { running: string; done: string }>;
  stopped: string;
  allowanceEnded: string;
  cutOffTitle: string;
  cutOffBody: string;
  askAgain: string;
  endedEarly: string;
  reloaded: string;
  readOnlyTitle: string;
  readOnlyBody: string;
  readOnlyTooLong: string;
  startNewChat: string;
  readOnlyPlaceholder: string;
  busyTitle: string;
  busyBody: string;
  restartingTitle: string;
  restartingBody: string;
  tryAgain: string;
  offTitle: string;
  offBody: string;
  offPlaceholder: string;
  allowanceTitle: string;
  allowanceBody: string;
  allowancePlaceholder: string;
  contactVayada: string;
  failedTitle: string;
  failedBody: string;
  notFound: string;
  loadFailed: string;
  /** vayada's Yes/No card for a change the AI asked for (VAY-2524), boards 03, 04 and 07. */
  change: ChangeMessages;
};

export type ChangeMessages = {
  needsAnswer: string;
  answerBy: string;
  whatElse: string;
  no: string;
  footnote: string;
  running: string;
  done: string;
  doneBody: string;
  declined: string;
  declinedBody: string;
  expired: string;
  expiredBody: string;
  changed: string;
  changedBody: string;
  notAllowed: string;
  notAllowedBody: string;
  stopped: string;
  stoppedBody: string;
  failed: string;
  failedBody: string;
  unsure: string;
  unsureBody: string;
  askAgain: string;
  loading: string;
  unavailable: string;
  gone: string;
  answerFailed: string;
  waiting: string;
  until: string;
  show: string;
};

export const assistantEnglish: AssistantMessages = {
  launcher: "Ask AI",
  title: "Assistant",
  aiLabel: "AI",
  newChat: "New chat",
  yourChats: "Your chats",
  close: "Close",
  back: "Back",
  noChats: "No chats yet for {property}.",
  showMore: "Show more",
  greeting: "Hi {name}, what do you need?",
  greetingNoName: "What do you need?",
  intro:
    "Ask about bookings, rooms, prices or guests at {property}. I can also draft replies. If I want to change something, I ask you first.",
  tryLabel: "Try",
  suggestions: [
    "What arrives today?",
    "Who still has to pay before arrival this week?",
    "Why can't guests book the Garden Suite on 6 March?",
    "How full are we in January compared with last year?",
  ],
  placeholder: "Ask anything about {property}...",
  send: "Send",
  stop: "Stop",
  disclaimer: "AI can make mistakes. It sees only what you can see in vayada.",
  thinking: "Thinking...",
  toolRunning: "Looking something up...",
  toolDone: "Looked something up",
  toolFailed: "Couldn't look this up",
  toolSkipped: "Didn't get to this",
  tools: {
    properties_list: {
      running: "Looking at your properties...",
      done: "Looked at your properties",
    },
    rooms_list: { running: "Looking at the rooms...", done: "Looked at the rooms" },
    calendar_days: { running: "Looking at the calendar...", done: "Looked at the calendar" },
  },
  stopped: "You stopped this answer.",
  allowanceEnded: "Not answered: the AI allowance was used up.",
  cutOffTitle: "This answer was cut off",
  cutOffBody:
    "vayada restarted while the AI was writing. Nothing was changed. Above is what it had looked at.",
  askAgain: "Ask again",
  endedEarly: "The AI stopped before finishing this answer.",
  reloaded:
    "The connection dropped, so we reloaded this chat from vayada. You see everything that was saved.",
  readOnlyTitle: "This chat can't continue",
  readOnlyBody:
    "vayada was updated or your access changed, so this chat is read-only now. Start a new chat to keep going.",
  readOnlyTooLong: "This chat is too long to continue. Start a new chat to keep going.",
  startNewChat: "Start a new chat",
  readOnlyPlaceholder: "Start a new chat to continue",
  busyTitle: "The assistant is busy right now",
  busyBody: "Too many answers are running right now. Try again in a moment.",
  restartingTitle: "vayada is restarting",
  restartingBody: "Ask again in a moment.",
  tryAgain: "Try again",
  offTitle: "AI is switched off for this account",
  offBody: "You can still read your old chats until they are deleted.",
  offPlaceholder: "AI is switched off",
  allowanceTitle: "Your AI allowance for {month} is used up",
  allowanceBody:
    "The assistant is paused. If you need it before the allowance resets on {resetDate}, ask vayada to raise it. Everything else in vayada works as usual.",
  allowancePlaceholder: "Paused until vayada raises it or {resetDate}",
  contactVayada: "Contact vayada",
  failedTitle: "Something went wrong",
  failedBody: "The AI couldn't answer this time. Nothing was changed. Try again in a moment.",
  notFound: "That chat is gone: chats are deleted 30 days after their last message.",
  loadFailed: "The chat couldn't be loaded. Try again in a moment.",
  change: {
    needsAnswer: "Needs your answer",
    answerBy: "Answer by {time}",
    whatElse: "What else happens",
    no: "No",
    footnote:
      'Written by vayada from the stored change. Only this button makes it; typing "yes" in the chat does nothing.',
    running: "Making the change...",
    done: "Done",
    doneBody: "You said yes at {time}.",
    declined: "Not done",
    declinedBody: "You said no at {time}. Nothing changed.",
    expired: "Expired",
    expiredBody:
      "Nothing changed. If you still want it, ask again and you get a new card with fresh details.",
    changed: "This changed since",
    changedBody: "Nothing changed. Ask me again to see what's possible now.",
    notAllowed: "Not allowed anymore",
    notAllowedBody: "Your role no longer allows this change, so vayada didn't make it.",
    stopped: "Stopped",
    stoppedBody: "AI was switched off for this account, so vayada didn't make this change.",
    failed: "Couldn't finish",
    failedBody:
      "vayada couldn't make this change. Nothing changed. Try again, or make it yourself in vayada.",
    unsure: "Not sure it happened",
    unsureBody:
      "vayada tried several times and can't tell whether this change happened. Check it in vayada before you ask again.",
    askAgain: "Ask again",
    loading: "Loading the change...",
    unavailable: "This change can't be shown right now.",
    gone: "Something this change names is gone or hidden from you now, so it can't be answered here.",
    answerFailed: "Your answer didn't get through. Nothing changed. Try again.",
    waiting: "Waiting for your answer:",
    until: "until {time}",
    show: "Show",
  },
};

export const assistantGerman: AssistantMessages = {
  launcher: "KI fragen",
  title: "Assistent",
  aiLabel: "KI",
  newChat: "Neuer Chat",
  yourChats: "Ihre Chats",
  close: "Schließen",
  back: "Zurück",
  noChats: "Noch keine Chats für {property}.",
  showMore: "Mehr anzeigen",
  greeting: "Hallo {name}, was brauchen Sie?",
  greetingNoName: "Was brauchen Sie?",
  intro:
    "Fragen Sie nach Buchungen, Zimmern, Preisen oder Gästen von {property}. Ich kann auch Antworten entwerfen. Wenn ich etwas ändern möchte, frage ich Sie vorher.",
  tryLabel: "Zum Beispiel",
  suggestions: [
    "Wer reist heute an?",
    "Wer muss diese Woche noch vor der Anreise zahlen?",
    "Warum kann die Garden Suite am 6. März nicht gebucht werden?",
    "Wie voll sind wir im Januar im Vergleich zum Vorjahr?",
  ],
  placeholder: "Fragen Sie etwas zu {property}...",
  send: "Senden",
  stop: "Stopp",
  disclaimer: "KI kann Fehler machen. Sie sieht nur, was Sie in vayada sehen dürfen.",
  thinking: "Denkt nach...",
  toolRunning: "Schaut etwas nach...",
  toolDone: "Etwas nachgeschaut",
  toolFailed: "Konnte das nicht nachschauen",
  toolSkipped: "Nicht mehr dazu gekommen",
  tools: {
    properties_list: {
      running: "Schaut Ihre Unterkünfte an...",
      done: "Ihre Unterkünfte angeschaut",
    },
    rooms_list: { running: "Schaut die Zimmer an...", done: "Die Zimmer angeschaut" },
    calendar_days: { running: "Schaut in den Kalender...", done: "In den Kalender geschaut" },
  },
  stopped: "Sie haben diese Antwort gestoppt.",
  allowanceEnded: "Nicht beantwortet: das KI-Kontingent war aufgebraucht.",
  cutOffTitle: "Diese Antwort wurde unterbrochen",
  cutOffBody:
    "vayada wurde neu gestartet, während die KI schrieb. Es wurde nichts geändert. Oben steht, was sie nachgeschaut hatte.",
  askAgain: "Nochmal fragen",
  endedEarly: "Die KI hat vor dem Ende dieser Antwort aufgehört.",
  reloaded:
    "Die Verbindung ist abgebrochen, daher haben wir diesen Chat neu aus vayada geladen. Sie sehen alles, was gespeichert wurde.",
  readOnlyTitle: "Dieser Chat kann nicht weitergehen",
  readOnlyBody:
    "vayada wurde aktualisiert oder Ihre Rechte haben sich geändert, daher ist dieser Chat jetzt nur lesbar. Starten Sie einen neuen Chat, um weiterzumachen.",
  readOnlyTooLong: "Dieser Chat ist zu lang, um weiterzugehen. Starten Sie einen neuen Chat.",
  startNewChat: "Neuen Chat starten",
  readOnlyPlaceholder: "Starten Sie einen neuen Chat, um weiterzumachen",
  busyTitle: "Der Assistent ist gerade beschäftigt",
  busyBody: "Gerade laufen zu viele Antworten. Versuchen Sie es gleich nochmal.",
  restartingTitle: "vayada startet neu",
  restartingBody: "Fragen Sie gleich nochmal.",
  tryAgain: "Nochmal versuchen",
  offTitle: "KI ist für dieses Konto ausgeschaltet",
  offBody: "Ihre bisherigen Chats können Sie weiter lesen, bis sie gelöscht werden.",
  offPlaceholder: "KI ist ausgeschaltet",
  allowanceTitle: "Ihr KI-Kontingent für {month} ist aufgebraucht",
  allowanceBody:
    "Der Assistent pausiert. Wenn Sie ihn vor dem {resetDate} brauchen, bitten Sie vayada, das Kontingent zu erhöhen. Alles andere in vayada funktioniert wie gewohnt.",
  allowancePlaceholder: "Pausiert, bis vayada erhöht oder bis {resetDate}",
  contactVayada: "vayada kontaktieren",
  failedTitle: "Etwas ist schiefgelaufen",
  failedBody:
    "Die KI konnte diesmal nicht antworten. Es wurde nichts geändert. Versuchen Sie es gleich nochmal.",
  notFound: "Dieser Chat ist weg: Chats werden 30 Tage nach der letzten Nachricht gelöscht.",
  loadFailed: "Der Chat konnte nicht geladen werden. Versuchen Sie es gleich nochmal.",
  change: {
    needsAnswer: "Braucht Ihre Antwort",
    answerBy: "Antwort bis {time}",
    whatElse: "Was sonst passiert",
    no: "Nein",
    footnote:
      'Von vayada aus der gespeicherten Änderung geschrieben. Nur dieser Knopf führt sie aus; "ja" im Chat zu schreiben bewirkt nichts.',
    running: "Die Änderung wird ausgeführt...",
    done: "Erledigt",
    doneBody: "Sie haben um {time} Ja gesagt.",
    declined: "Nicht ausgeführt",
    declinedBody: "Sie haben um {time} Nein gesagt. Es wurde nichts geändert.",
    expired: "Abgelaufen",
    expiredBody:
      "Es wurde nichts geändert. Wenn Sie es noch möchten, fragen Sie nochmal und Sie bekommen eine neue Karte mit aktuellen Angaben.",
    changed: "Hat sich inzwischen geändert",
    changedBody:
      "Es wurde nichts geändert. Fragen Sie mich nochmal, um zu sehen, was jetzt möglich ist.",
    notAllowed: "Nicht mehr erlaubt",
    notAllowedBody:
      "Ihre Rolle erlaubt diese Änderung nicht mehr, daher hat vayada sie nicht ausgeführt.",
    stopped: "Gestoppt",
    stoppedBody:
      "KI wurde für dieses Konto ausgeschaltet, daher hat vayada diese Änderung nicht ausgeführt.",
    failed: "Konnte nicht abgeschlossen werden",
    failedBody:
      "vayada konnte diese Änderung nicht ausführen. Es wurde nichts geändert. Versuchen Sie es nochmal oder ändern Sie es selbst in vayada.",
    unsure: "Unklar, ob es geklappt hat",
    unsureBody:
      "vayada hat es mehrmals versucht und kann nicht sagen, ob die Änderung ausgeführt wurde. Prüfen Sie es in vayada, bevor Sie nochmal fragen.",
    askAgain: "Nochmal fragen",
    loading: "Die Änderung wird geladen...",
    unavailable: "Diese Änderung kann gerade nicht angezeigt werden.",
    gone: "Etwas, das diese Änderung nennt, ist weg oder für Sie nicht mehr sichtbar, daher kann sie hier nicht beantwortet werden.",
    answerFailed:
      "Ihre Antwort ist nicht angekommen. Es wurde nichts geändert. Versuchen Sie es nochmal.",
    waiting: "Wartet auf Ihre Antwort:",
    until: "bis {time}",
    show: "Anzeigen",
  },
};

/** German for "de", English for everything else (until more languages are translated). */
export function assistantMessagesFor(locale: string): AssistantMessages {
  return locale.toLowerCase().startsWith("de") ? assistantGerman : assistantEnglish;
}

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** Dates and times as the panel's language writes them: "09:41", "1 January" / "1. Januar". */
export function dateLocale(locale: string): string {
  return locale.toLowerCase().startsWith("de") ? "de-DE" : "en-GB";
}

/** "December" and "1 January": the month whose allowance is used up and when the next one starts. */
export function allowanceDates(locale: string, now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    month: new Intl.DateTimeFormat(dateLocale(locale), { month: "long" }).format(now),
    resetDate: new Intl.DateTimeFormat(dateLocale(locale), {
      day: "numeric",
      month: "long",
    }).format(next),
  };
}
