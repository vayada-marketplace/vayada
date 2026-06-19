"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  PaperAirplaneIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import {
  askIntelligence,
  AskIntelligenceClientError,
  type AskAnswer,
} from "@/services/api/askIntelligenceClient";

const SAMPLE_QUESTIONS = [
  "Why did my direct booking share change this month?",
  "What setup gaps should I fix first?",
  "Which booking source needs attention?",
];
const SELECTED_HOTEL_CHANGED_EVENT = "booking-admin:selected-hotel-changed";
const OWNER_VISIBLE_BLOCK_FIELDS = [
  "value",
  "unit",
  "current",
  "previous",
  "change",
  "delta",
  "count",
  "total",
  "rate",
  "score",
  "period",
  "category",
  "source",
];

const STATUS_LABELS: Record<AskAnswer["status"], string> = {
  answered: "Answered",
  partial: "Partial",
  unavailable: "Unavailable",
  needs_clarification: "Needs clarification",
  external_data_needed: "Unavailable",
  not_authorized: "Not available",
};

export default function AskIntelligencePage() {
  const [question, setQuestion] = useState("");
  const [selectedHotelId, setSelectedHotelId] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);

  useEffect(() => {
    const readSelectedHotel = () =>
      setSelectedHotelId(localStorage.getItem("selectedHotelId") || "");
    readSelectedHotel();
    window.addEventListener("focus", readSelectedHotel);
    window.addEventListener("storage", readSelectedHotel);
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, readSelectedHotel);
    return () => {
      window.removeEventListener("focus", readSelectedHotel);
      window.removeEventListener("storage", readSelectedHotel);
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, readSelectedHotel);
    };
  }, []);

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const nextAnswer = await askIntelligence(question, selectedHotelId);
      setAnswer(nextAnswer);
    } catch (caught) {
      const clientError =
        caught instanceof AskIntelligenceClientError
          ? caught
          : new AskIntelligenceClientError(
              "Ask Intelligence could not answer right now. Try again.",
              {
                retryable: true,
              },
            );
      setError({ message: clientError.message, retryable: clientError.retryable });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">Ask Intelligence</h1>
        </div>
        {answer && <StatusBadge status={answer.status} />}
      </div>

      <form
        onSubmit={submit}
        className="bg-white border border-gray-200 rounded-lg p-4 md:p-5 space-y-3"
      >
        <label htmlFor="ask-question" className="block text-sm font-semibold text-gray-900">
          Question
        </label>
        <textarea
          id="ask-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={4}
          placeholder="Why did my direct booking share change this month?"
          className="w-full resize-none rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
        />
        <div className="flex flex-wrap gap-2">
          {SAMPLE_QUESTIONS.map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => setQuestion(sample)}
              className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition hover:border-gray-300 hover:bg-white"
            >
              {sample}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-gray-500">
            Scope: {selectedHotelId ? "selected property" : "select a property in the header"}
          </p>
          <button
            type="submit"
            disabled={loading || !question.trim() || !selectedHotelId}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary-600 px-4 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {loading ? (
              <ArrowPathIcon className="h-4 w-4 animate-spin" />
            ) : (
              <PaperAirplaneIcon className="h-4 w-4" />
            )}
            Ask
          </button>
        </div>
      </form>

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex gap-3">
            <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="min-w-0 space-y-3">
              <p className="text-sm font-medium text-amber-900">{error.message}</p>
              {error.retryable && (
                <button
                  type="button"
                  onClick={() => submit()}
                  disabled={loading}
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
                >
                  <ArrowPathIcon className="h-3.5 w-3.5" />
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && !answer && <LoadingPanel />}
      {answer && <AnswerView answer={answer} />}
    </div>
  );
}

function AnswerView({ answer }: { answer: AskAnswer }) {
  const summary =
    answer.status === "not_authorized"
      ? "Ask Intelligence is not available for this property with your current access."
      : answer.summary;

  return (
    <div className="space-y-4">
      <section className="bg-white border border-gray-200 rounded-lg p-4 md:p-5 space-y-3">
        <div className="flex items-center gap-2">
          <SparklesIcon className="h-5 w-5 text-primary-600" />
          <h2 className="text-base font-semibold text-gray-900">Answer</h2>
        </div>
        <p className="text-sm leading-6 text-gray-700">{summary || "No summary returned."}</p>
        {answer.confidence?.level && (
          <p className="text-xs font-medium text-gray-500">
            Confidence: {humanize(String(answer.confidence.level))}
          </p>
        )}
      </section>

      {answer.blocks.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-900">Details</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {answer.blocks.map((block, index) => (
              <StructuredBlock key={blockKey(block, index)} block={block} index={index} />
            ))}
          </div>
        </section>
      )}

      <AnswerList title="Unavailable Data" items={answer.unavailableData.map(unavailableText)} />
      <AnswerList title="Caveats" items={answer.caveats.map(caveatText)} />
      <AnswerList title="Suggested Actions" items={answer.suggestedActions.map(actionText)} />
      <AnswerList title="Follow-up Questions" items={answer.followUpQuestions} />
    </div>
  );
}

function StructuredBlock({ block, index }: { block: Record<string, unknown>; index: number }) {
  const title = text(block.title) || text(block.label) || text(block.type) || `Detail ${index + 1}`;
  const description = text(block.text) || text(block.summary) || text(block.description);
  const rows = OWNER_VISIBLE_BLOCK_FIELDS.flatMap((key) => {
    if (!(key in block)) return [];
    const formatted = formatValue(block[key]);
    return formatted ? [{ key, value: formatted }] : [];
  });

  return (
    <article className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">{humanize(title)}</h3>
      {description && <p className="mt-1 text-sm leading-5 text-gray-600">{description}</p>}
      {rows.length > 0 && (
        <dl className="mt-3 space-y-2">
          {rows.map(({ key, value }) => (
            <div key={key} className="flex justify-between gap-3 text-sm">
              <dt className="text-gray-500">{humanize(key)}</dt>
              <dd className="min-w-0 text-right font-medium text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function AnswerList({ title, items }: { title: string; items: string[] }) {
  const filtered = items.filter(Boolean);
  if (filtered.length === 0) return null;

  return (
    <section className="bg-white border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      <ul className="mt-2 space-y-1.5 text-sm leading-5 text-gray-700">
        {filtered.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LoadingPanel() {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 md:p-5 space-y-3">
      <div className="h-4 w-36 rounded bg-gray-200" />
      <div className="space-y-2">
        <div className="h-3 w-full rounded bg-gray-100" />
        <div className="h-3 w-10/12 rounded bg-gray-100" />
        <div className="h-3 w-7/12 rounded bg-gray-100" />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AskAnswer["status"] }) {
  const colors =
    status === "answered"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "partial" || status === "needs_clarification"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-gray-200 bg-gray-100 text-gray-700";
  return (
    <span
      className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${colors}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function unavailableText(item: Record<string, unknown>): string {
  const reason = text(item.reason);
  const retry = item.canRetry === true ? " Try again later." : "";
  const reasonCopy: Record<string, string> = {
    inactive_entitlement: "Ask Intelligence is not active for this property.",
    missing_entitlement: "Ask Intelligence is not enabled for this property.",
    missing_permission: "Your account does not have Ask access for this property.",
    missing_scope: "Ask needs a selected property scope.",
    not_linked_resource: "This property is not linked to your account.",
    source_unavailable: "Required evidence is not loaded yet.",
  };
  const copy = reasonCopy[reason || ""] || humanize(reason || "Data unavailable");
  return `${copy}${copy.endsWith(".") ? "" : "."}${retry}`;
}

function caveatText(item: Record<string, unknown>): string {
  return (
    text(item.message) ||
    text(item.summary) ||
    text(item.description) ||
    humanize(text(item.code) || "Caveat")
  );
}

function actionText(item: Record<string, unknown>): string {
  return (
    text(item.label) ||
    text(item.message) ||
    text(item.title) ||
    text(item.description) ||
    humanize(text(item.type) || "Suggested action")
  );
}

function blockKey(block: Record<string, unknown>, index: number): string {
  return `${text(block.metricKey) || text(block.type) || "block"}-${index}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Intl.NumberFormat().format(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(", ") || null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}
