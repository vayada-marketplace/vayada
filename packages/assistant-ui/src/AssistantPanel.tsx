"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  LightBulbIcon,
  LockClosedIcon,
  MinusCircleIcon,
  PlusIcon,
  PowerIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { SparklesIcon, StopIcon } from "@heroicons/react/20/solid";
import { PlainText, toPlainText } from "@vayada/web-security/plain-text";

import {
  createAssistantApi,
  type AssistantApi,
  type AssistantApp,
  type AssistantHttp,
  type AssistantScope,
  type ConversationSummary,
} from "./assistantApi";
import {
  allowanceDates,
  assistantMessagesFor,
  dateLocale,
  fill,
  type AssistantMessages,
} from "./assistantMessages";
import { useAssistantChat, type AssistantChat, type LiveTurn } from "./useAssistantChat";
import { ChangeCard, WaitingBar, type CardStatus } from "./ChangeCard";
import type { ToolLineStatus, TranscriptItem } from "./transcript";

/**
 * The in-app assistant (VAY-2519), as on the approved Paper boards (VAY-2517): an "Ask AI" button
 * in the header opens a 420 px panel beside the page (it pushes the page aside) or, on a phone, a
 * full-screen sheet. It shows only while the API has the assistant switched on: while
 * AI_ASSISTANT_ENABLED is off its routes are not there (404) and nothing appears.
 */

export const MAX_QUESTION_CHARS = 4_000;
const PANEL_ID = "vayada-assistant";

type PanelProperty = { id: string; name: string };
type Setup = { property: PanelProperty | null; userName: string; canContact: boolean };

type PanelState = {
  api: AssistantApi;
  app: AssistantApp;
  locale: string;
  messages: AssistantMessages;
  setup: Setup;
  setSetup: (setup: Setup) => void;
  contact: { current: (() => void) | undefined };
  /** Set by the "Ask AI" button, so the panel's question box takes the focus (not after a reload). */
  openedByButton: { current: boolean };
  available: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
};

const PanelContext = createContext<PanelState | null>(null);

function usePanel(): PanelState {
  const state = useContext(PanelContext);
  if (!state) throw new Error("The assistant's parts need an AssistantProvider around them.");
  return state;
}

const openKey = (app: AssistantApp) => `vayada.assistant.open.${app}`;

export function AssistantProvider({
  app,
  http,
  locale,
  children,
}: {
  app: AssistantApp;
  http: AssistantHttp;
  locale: string;
  children: ReactNode;
}) {
  const api = useMemo(() => createAssistantApi(http), [http]);
  const messages = useMemo(() => assistantMessagesFor(locale), [locale]);
  const [setup, setSetup] = useState<Setup>({ property: null, userName: "", canContact: false });
  const contact = useRef<(() => void) | undefined>(undefined);
  const openedByButton = useRef(false);
  const [available, setAvailable] = useState(false);
  const [open, setOpenState] = useState(false);
  const propertyId = setup.property?.id;

  useEffect(() => {
    try {
      setOpenState(window.sessionStorage.getItem(openKey(app)) === "1");
    } catch {
      // Private mode: the panel starts closed.
    }
  }, [app]);

  // Is the assistant there for this property? One small read; a 404 means it is switched off.
  useEffect(() => {
    setAvailable(false);
    if (!propertyId) return;
    let current = true;
    api
      .list({ propertyId, app }, undefined, 1)
      .then(() => current && setAvailable(true))
      // Off (404), not for this person and property (403), or no answer: no button, no panel.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api, app, propertyId]);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      try {
        if (next) window.sessionStorage.setItem(openKey(app), "1");
        else window.sessionStorage.removeItem(openKey(app));
      } catch {
        // Private mode: only this page remembers it.
      }
    },
    [app],
  );

  const state = useMemo<PanelState>(
    () => ({
      api,
      app,
      locale,
      messages,
      setup,
      setSetup,
      contact,
      openedByButton,
      available,
      open: open && available,
      setOpen,
    }),
    [api, app, locale, messages, setup, available, open, setOpen],
  );
  return <PanelContext.Provider value={state}>{children}</PanelContext.Provider>;
}

/**
 * The header's "Ask AI" button. It also tells the panel which property it is about, the person's
 * name for the greeting and how to contact vayada (the header's support form).
 */
export function AssistantLauncher({
  property,
  userName,
  onContact,
}: {
  property: PanelProperty | null;
  userName?: string;
  onContact?: () => void;
}) {
  const { messages, available, open, setOpen, setSetup, contact, openedByButton } = usePanel();
  contact.current = onContact;
  const propertyId = property?.id;
  const propertyName = property?.name;
  const canContact = Boolean(onContact);

  useEffect(() => {
    setSetup({
      property: propertyId ? { id: propertyId, name: propertyName ?? "" } : null,
      userName: userName ?? "",
      canContact,
    });
  }, [setSetup, propertyId, propertyName, userName, canContact]);

  if (!available) return null;
  return (
    <button
      type="button"
      id={`${PANEL_ID}-launcher`}
      onClick={() => {
        openedByButton.current = !open;
        setOpen(!open);
      }}
      aria-expanded={open}
      aria-controls={PANEL_ID}
      className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md bg-primary-600 px-2.5 text-sm font-semibold text-white hover:bg-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600 sm:px-3"
    >
      <SparklesIcon className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">{messages.launcher}</span>
    </button>
  );
}

/** The panel itself: put it beside the page's <main>, in a row under the header. */
export function AssistantDrawer() {
  const panel = usePanel();
  const { property } = panel.setup;
  const propertyId = property?.id;
  // By id: the header sends the same property again when the person's name loads.
  const scope = useMemo<AssistantScope | null>(
    () => (propertyId ? { propertyId, app: panel.app } : null),
    [propertyId, panel.app],
  );
  if (!panel.open || !scope || !property) return null;
  return <OpenDrawer panel={panel} scope={scope} propertyName={property.name} />;
}

const ICON_BUTTON =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-transparent";
const SECONDARY_BUTTON =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-[13px] font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-white";

function OpenDrawer({
  panel,
  scope,
  propertyName,
}: {
  panel: PanelState;
  scope: AssistantScope;
  propertyName: string;
}) {
  const m = panel.messages;
  const chat = useAssistantChat(panel.api, scope);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const refocus = useRef(false);
  const phone = usePhone();
  const paused = chat.blocker?.kind === "off" || chat.blocker?.kind === "allowance";
  // How each change card in the chat stands (VAY-2524): the first one waiting gets the bar.
  const [cards, setCards] = useState<Record<string, CardStatus>>({});
  const onCardView = useCallback((id: string, status: CardStatus) => {
    setCards((current) => {
      if (current[id] === status) return current;
      const next = { ...current };
      if (status === undefined) delete next[id];
      else next[id] = status;
      return next;
    });
  }, []);
  // The first card in the chat that still waits gets the bar.
  const waiting = chat.items
    .map((item) => (item.kind === "change" ? cards[item.pendingActionId] : undefined))
    .find((card) => card?.state === "needs_answer");

  // Stop disappears when the answer ends: the question box takes the focus it had.
  useEffect(() => {
    if (chat.answering || !refocus.current) return;
    refocus.current = false;
    input.current?.focus();
  }, [chat.answering]);

  // Opened with the button: straight into the question. (Reopened by a reload: focus stays put.)
  useEffect(() => {
    if (!panel.openedByButton.current) return;
    panel.openedByButton.current = false;
    input.current?.focus();
  }, [panel.openedByButton]);

  const close = () => {
    panel.setOpen(false);
    document.getElementById(`${PANEL_ID}-launcher`)?.focus();
  };

  const send = (question: string) => {
    if (!question.trim() || chat.answering || chat.blocker) return;
    setView("chat");
    setDraft("");
    void chat.ask(question);
  };

  return (
    <aside
      ref={sheet}
      id={PANEL_ID}
      aria-label={m.title}
      // On a phone the panel covers the page: a modal sheet that keeps the keyboard inside.
      role={phone ? "dialog" : undefined}
      aria-modal={phone ? true : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) close();
        if (event.key === "Tab" && phone && sheet.current) keepTabInside(event, sheet.current);
      }}
      className="fixed inset-0 z-50 flex flex-col bg-white md:static md:inset-auto md:z-auto md:w-[420px] md:shrink-0 md:border-l md:border-gray-200"
    >
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">{m.title}</h2>
            <AiBadge label={m.aiLabel} />
          </div>
          <p className="truncate text-[13px] text-gray-500">{propertyName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={paused}
            onClick={() => {
              setView("chat");
              chat.newChat();
              input.current?.focus();
            }}
          >
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
            {m.newChat}
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={m.yourChats}
            aria-pressed={view === "history"}
            onClick={() => setView(view === "history" ? "chat" : "history")}
          >
            <ClockIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <button type="button" className={ICON_BUTTON} aria-label={m.close} onClick={close}>
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {view === "history" ? (
        <History
          panel={panel}
          scope={scope}
          propertyName={propertyName}
          current={chat.conversationId}
          onBack={() => setView("chat")}
          onOpen={(id) => {
            chat.open(id);
            setView("chat");
          }}
        />
      ) : chat.blocker?.kind === "off" ? (
        <Centred
          icon={<PowerIcon className="h-5 w-5 text-gray-500" aria-hidden="true" />}
          tile="bg-gray-100"
        >
          <p className="font-semibold text-gray-900">{m.offTitle}</p>
          <p className="mt-2 text-sm text-gray-600">{m.offBody}</p>
        </Centred>
      ) : chat.blocker?.kind === "allowance" ? (
        <Allowance panel={panel} />
      ) : chat.items.length === 0 && !chat.live ? (
        <Welcome
          messages={m}
          userName={panel.setup.userName}
          propertyName={propertyName}
          onPick={send}
          notice={chat.notice ? <Notice chat={chat} messages={m} onRetry={send} /> : null}
        />
      ) : (
        <Transcript
          chat={chat}
          api={panel.api}
          messages={m}
          locale={panel.locale}
          onRetry={send}
          onNewChat={chat.newChat}
          onCardView={onCardView}
        />
      )}

      <form
        className="border-t border-gray-200 px-4 pb-3 pt-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          send(draft);
        }}
      >
        {waiting && view === "chat" && (
          <WaitingBar view={waiting} m={m.change} locale={panel.locale} />
        )}
        <div className="flex items-end gap-2 rounded-xl border border-gray-300 bg-white py-2 pl-3.5 pr-2 focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            maxLength={MAX_QUESTION_CHARS}
            disabled={Boolean(chat.blocker)}
            aria-label={fill(m.placeholder, { property: propertyName })}
            placeholder={placeholderOf(chat, m, propertyName, panel.locale)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send(draft);
              }
            }}
            className="max-h-36 min-h-[36px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 text-gray-900 outline-none [field-sizing:content] placeholder:truncate placeholder:text-gray-400 disabled:cursor-default"
          />
          {chat.answering ? (
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => {
                refocus.current = true;
                void chat.stop();
              }}
            >
              <StopIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {m.stop}
            </button>
          ) : (
            <button
              type="submit"
              aria-label={m.send}
              disabled={!draft.trim() || Boolean(chat.blocker)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:bg-gray-100 disabled:text-gray-400"
            >
              <ArrowUpIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-500">{m.disclaimer}</p>
      </form>
    </aside>
  );
}

/** Below Tailwind's md breakpoint the panel is a full-screen sheet. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function keepTabInside(event: KeyboardEvent<HTMLElement>, container: HTMLElement) {
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function placeholderOf(
  chat: AssistantChat,
  m: AssistantMessages,
  propertyName: string,
  locale: string,
) {
  if (chat.blocker?.kind === "off") return m.offPlaceholder;
  if (chat.blocker?.kind === "allowance")
    return fill(m.allowancePlaceholder, allowanceDates(locale));
  if (chat.blocker?.kind === "read_only") return m.readOnlyPlaceholder;
  return fill(m.placeholder, { property: propertyName });
}

function AiBadge({ label }: { label: string }) {
  return (
    <span className="rounded bg-primary-50 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-primary-700">
      {label}
    </span>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600"
    />
  );
}

function Centred({ icon, tile, children }: { icon: ReactNode; tile: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8 text-center">
      <div className={`mb-4 flex h-10 w-10 items-center justify-center rounded-full ${tile}`}>
        {icon}
      </div>
      {children}
    </div>
  );
}

function Allowance({ panel }: { panel: PanelState }) {
  const m = panel.messages;
  const dates = allowanceDates(panel.locale);
  return (
    <Centred
      icon={<LightBulbIcon className="h-5 w-5 text-amber-600" aria-hidden="true" />}
      tile="bg-amber-50"
    >
      <p className="font-semibold text-gray-900">{fill(m.allowanceTitle, dates)}</p>
      <p className="mt-2 text-sm text-gray-600">{fill(m.allowanceBody, dates)}</p>
      {panel.setup.canContact && (
        <button
          type="button"
          className={`${SECONDARY_BUTTON} mt-4`}
          onClick={() => panel.contact.current?.()}
        >
          <EnvelopeIcon className="h-4 w-4" aria-hidden="true" />
          {m.contactVayada}
        </button>
      )}
    </Centred>
  );
}

function Welcome({
  messages: m,
  userName,
  propertyName,
  onPick,
  notice,
}: {
  messages: AssistantMessages;
  userName: string;
  propertyName: string;
  onPick: (question: string) => void;
  notice: ReactNode;
}) {
  const firstName = userName.trim().split(/\s+/)[0] ?? "";
  return (
    <div className="flex flex-1 flex-col justify-end overflow-y-auto px-5 pb-5">
      <h3 className="text-xl font-semibold text-gray-900">
        {firstName ? fill(m.greeting, { name: firstName }) : m.greetingNoName}
      </h3>
      <p className="mt-2 text-[15px] leading-6 text-gray-600">
        {fill(m.intro, { property: propertyName })}
      </p>
      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-gray-500">
        {m.tryLabel}
      </p>
      <ul className="mt-2 space-y-2">
        {m.suggestions.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onPick(suggestion)}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-left text-sm text-gray-900 hover:border-gray-300 hover:bg-gray-50"
            >
              {suggestion}
              <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {notice && <div className="mt-4">{notice}</div>}
    </div>
  );
}

function toolLabel(m: AssistantMessages, tool: string, status: ToolLineStatus) {
  if (status === "failed") return m.toolFailed;
  if (status === "skipped") return m.toolSkipped;
  const known = m.tools[tool];
  if (status === "running") return known?.running ?? m.toolRunning;
  return known?.done ?? m.toolDone;
}

function ProgressLine({
  m,
  tool,
  status,
}: {
  m: AssistantMessages;
  tool: string;
  status: ToolLineStatus;
}) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-gray-500">
      <span className="flex w-4 shrink-0 justify-center">
        {status === "running" ? (
          <Spinner />
        ) : status === "ok" ? (
          <CheckIcon className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
        ) : status === "failed" ? (
          <ExclamationTriangleIcon className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
        ) : (
          <MinusCircleIcon className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
        )}
      </span>
      {toolLabel(m, tool, status)}
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-gray-100 px-3.5 py-2.5 text-[15px] leading-6 text-gray-900">
        <PlainText text={text} />
      </div>
    </div>
  );
}

function Answer({
  m,
  text,
  at,
  locale,
}: {
  m: AssistantMessages;
  text: string;
  at: Date;
  locale: string;
}) {
  const time = new Intl.DateTimeFormat(dateLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  return (
    <div>
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <AiBadge label={m.aiLabel} />
        <time dateTime={at.toISOString()}>{time}</time>
      </div>
      <PlainText text={text} className="mt-1.5 text-[15px] leading-6 text-gray-900" />
    </div>
  );
}

function Box({
  tone,
  title,
  body,
  icon,
  action,
}: {
  tone: "amber" | "gray";
  title: string;
  body: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  const colours =
    tone === "amber"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-gray-200 bg-gray-50 text-gray-900";
  return (
    <div className={`rounded-lg border px-3.5 py-3 ${colours}`} role="status">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {title}
      </p>
      <p className={`mt-1 text-[13px] ${tone === "amber" ? "text-amber-800" : "text-gray-600"}`}>
        {body}
      </p>
      {action && <div className="mt-2.5">{action}</div>}
    </div>
  );
}

function Notice({
  chat,
  messages: m,
  onRetry,
}: {
  chat: AssistantChat;
  messages: AssistantMessages;
  onRetry: (question: string) => void;
}) {
  const retry = (
    <button type="button" className={SECONDARY_BUTTON} onClick={() => onRetry(chat.lastQuestion)}>
      {m.tryAgain}
    </button>
  );
  switch (chat.notice) {
    case "reloaded":
      return (
        <p
          className="flex gap-2 rounded-lg border border-primary-100 bg-primary-50 px-3.5 py-2.5 text-[13px] text-primary-700"
          role="status"
        >
          <ArrowPathIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {m.reloaded}
        </p>
      );
    case "busy":
      return <Box tone="gray" title={m.busyTitle} body={m.busyBody} action={retry} />;
    case "restarting":
      return <Box tone="gray" title={m.restartingTitle} body={m.restartingBody} action={retry} />;
    case "failed":
      return <Box tone="gray" title={m.failedTitle} body={m.failedBody} action={retry} />;
    case "not_found":
      return (
        <p className="text-[13px] text-gray-500" role="status">
          {m.notFound}
        </p>
      );
    case "load_failed":
      return (
        <p className="text-[13px] text-gray-500" role="status">
          {m.loadFailed}
        </p>
      );
    default:
      return null;
  }
}

type Ended = Extract<TranscriptItem, { kind: "ended" }>;

function EndedNote({
  item,
  m,
  retry,
}: {
  item: Ended;
  m: AssistantMessages;
  /** The turn's question, when it can be asked again here (the chat's last turn). */
  retry?: () => void;
}) {
  const again = retry && (
    <button type="button" className={SECONDARY_BUTTON} onClick={retry}>
      {item.status === "interrupted" ? m.askAgain : m.tryAgain}
    </button>
  );
  if (item.status === "interrupted")
    return (
      <Box
        tone="amber"
        title={m.cutOffTitle}
        body={m.cutOffBody}
        icon={<ExclamationTriangleIcon className="h-4 w-4" aria-hidden="true" />}
        action={again}
      />
    );
  if (item.status === "failed") {
    if (item.reason === "allowance_used_up")
      return <p className="text-[13px] text-gray-500">{m.allowanceEnded}</p>;
    if (item.reason === "unavailable")
      return <p className="text-[13px] text-gray-500">{m.offTitle}</p>;
    if (item.reason === "busy")
      return <Box tone="gray" title={m.busyTitle} body={m.busyBody} action={again} />;
    return <Box tone="gray" title={m.failedTitle} body={m.failedBody} action={again} />;
  }
  if (item.status === "stopped")
    return (
      <p className="text-[13px] text-gray-500">
        {item.reason === "user_stopped" ? m.stopped : m.endedEarly}
      </p>
    );
  return null; // waiting_for_answer: the Yes/No card (VAY-2519 part 2)
}

function LiveTurnView({
  live,
  answering,
  m,
  locale,
}: {
  live: LiveTurn;
  /** False once the question was refused or failed: no spinner, the notice follows. */
  answering: boolean;
  m: AssistantMessages;
  locale: string;
}) {
  const started = useMemo(() => new Date(), []);
  const looking = live.tools.some((tool) => tool.status === "running");
  return (
    <>
      <Question text={live.question} />
      {live.tools.length > 0 && (
        <div className="space-y-1.5">
          {live.tools.map((tool) => (
            <ProgressLine key={tool.id} m={m} tool={tool.name} status={tool.status} />
          ))}
        </div>
      )}
      {live.text ? (
        <Answer m={m} text={live.text} at={started} locale={locale} />
      ) : (
        answering &&
        !looking && (
          <div className="flex items-center gap-2 text-[13px] text-gray-500">
            <span className="flex w-4 justify-center">
              <Spinner />
            </span>
            {m.thinking}
          </div>
        )
      )}
    </>
  );
}

/** Consecutive progress lines sit together; everything else gets its own row. */
function grouped(items: TranscriptItem[]) {
  const rows: (TranscriptItem | Extract<TranscriptItem, { kind: "progress" }>[])[] = [];
  for (const item of items) {
    const last = rows[rows.length - 1];
    if (item.kind === "progress" && Array.isArray(last)) last.push(item);
    else rows.push(item.kind === "progress" ? [item] : item);
  }
  return rows;
}

function Transcript({
  chat,
  api,
  messages: m,
  locale,
  onRetry,
  onNewChat,
  onCardView,
}: {
  chat: AssistantChat;
  api: AssistantApi;
  messages: AssistantMessages;
  locale: string;
  onRetry: (question: string) => void;
  onNewChat: () => void;
  onCardView: (id: string, status: CardStatus) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const lastItem = chat.items[chat.items.length - 1];
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [chat.items.length, chat.live?.text, chat.live?.tools.length, chat.notice, chat.blocker]);

  let question = "";
  const canRetry = !chat.answering && !chat.blocker && !chat.notice;
  // Only the chat's latest card offers "Ask again" (an older one would ask an old question).
  const lastCard = [...chat.items].reverse().find((item) => item.kind === "change");
  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      <div
        className="flex min-h-full flex-col justify-end gap-4"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {grouped(chat.items).map((row) => {
          if (Array.isArray(row))
            return (
              <div key={row[0]!.key} className="space-y-1.5">
                {row.map((line) => (
                  <ProgressLine key={line.key} m={m} tool={line.tool} status={line.status} />
                ))}
              </div>
            );
          if (row.kind === "question") {
            question = row.text;
            return <Question key={row.key} text={row.text} />;
          }
          if (row.kind === "answer")
            return (
              <Answer key={row.key} m={m} text={row.text} at={new Date(row.at)} locale={locale} />
            );
          if (row.kind === "change") {
            const asked = question;
            return (
              <ChangeCard
                key={row.key}
                api={api}
                id={row.pendingActionId}
                m={m.change}
                locale={locale}
                onView={onCardView}
                onAskAgain={
                  row === lastCard && canRetry && asked ? () => onRetry(asked) : undefined
                }
              />
            );
          }
          if (row.kind === "ended") {
            const asked = question;
            return (
              <EndedNote
                key={row.key}
                item={row}
                m={m}
                retry={row === lastItem && canRetry && asked ? () => onRetry(asked) : undefined}
              />
            );
          }
          return null;
        })}
        {chat.live && (
          <LiveTurnView live={chat.live} answering={chat.answering} m={m} locale={locale} />
        )}
        {chat.notice && <Notice chat={chat} messages={m} onRetry={onRetry} />}
        {chat.blocker?.kind === "read_only" && (
          <Box
            tone="gray"
            title={m.readOnlyTitle}
            body={chat.blocker.reason === "too_long" ? m.readOnlyTooLong : m.readOnlyBody}
            action={
              <button
                type="button"
                onClick={onNewChat}
                className="inline-flex h-8 items-center rounded-md bg-primary-600 px-3 text-[13px] font-semibold text-white hover:bg-primary-700"
              >
                {m.startNewChat}
              </button>
            }
          />
        )}
        <div ref={end} />
      </div>
    </div>
  );
}

function History({
  panel,
  scope,
  propertyName,
  current,
  onBack,
  onOpen,
}: {
  panel: PanelState;
  scope: AssistantScope;
  propertyName: string;
  current: string | undefined;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const m = panel.messages;
  const [chats, setChats] = useState<ConversationSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const headingId = useId();

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await panel.api.list(scope, cursor);
        setChats((shown) => [...(cursor ? (shown ?? []) : []), ...page.items]);
        setNext(page.nextCursor);
        setFailed(false);
      } catch {
        setFailed(true);
      }
    },
    [panel.api, scope],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const dateOf = (value: string) =>
    new Intl.DateTimeFormat(dateLocale(panel.locale), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));

  return (
    <section aria-labelledby={headingId} className="flex flex-1 flex-col overflow-y-auto px-3 py-3">
      <div className="mb-2 flex items-center gap-1 px-1">
        <button type="button" className={ICON_BUTTON} aria-label={m.back} onClick={onBack}>
          <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        </button>
        <h3 id={headingId} className="text-sm font-semibold text-gray-900">
          {m.yourChats}
        </h3>
      </div>
      {failed && <p className="px-2 text-[13px] text-gray-500">{m.loadFailed}</p>}
      {chats?.length === 0 && (
        <p className="px-2 text-[13px] text-gray-500">
          {fill(m.noChats, { property: propertyName })}
        </p>
      )}
      <ul className="space-y-1">
        {chats?.map((summary) => (
          <li key={summary.id}>
            <button
              type="button"
              onClick={() => onOpen(summary.id)}
              aria-current={summary.id === current ? "true" : undefined}
              className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-gray-50 aria-[current=true]:bg-primary-50"
            >
              <span dir="auto" className="line-clamp-2 text-sm text-gray-900">
                {toPlainText(summary.preview)}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                {summary.readOnlyReason && (
                  <LockClosedIcon className="h-3 w-3" aria-hidden="true" />
                )}
                {dateOf(summary.lastActivityAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {next && (
        <button
          type="button"
          className={`${SECONDARY_BUTTON} mx-auto mt-3`}
          onClick={() => void load(next)}
        >
          {m.showMore}
        </button>
      )}
    </section>
  );
}
