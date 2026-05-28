"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  ArrowsUpDownIcon,
  BanknotesIcon,
  Bars3Icon,
  CheckIcon,
  ClipboardDocumentCheckIcon,
  EyeIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  CheckinChecklistStep,
  CheckinChecklistStepType,
  settingsService,
} from "@/services/settings";

const DRAFT_STORAGE_KEY = "vayada:pms:checkin-checklist-preview";

export const SYSTEM_CHECKLIST_STEPS: CheckinChecklistStep[] = [
  {
    id: "system-booker-id",
    label: "Booker ID / passport",
    type: "checkbox",
    required: true,
    system: true,
    position: 0,
  },
  {
    id: "system-payment",
    label: "Payment collected",
    type: "amount",
    required: true,
    system: true,
    position: 1,
  },
];

function newStep(position: number): CheckinChecklistStep {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `step-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id, label: "", type: "checkbox", required: false, system: false, position };
}

function typeLabel(type: CheckinChecklistStepType) {
  if (type === "text") return "Text input";
  if (type === "amount") return "Amount";
  return "Checkbox";
}

function StepTypeIcon({ type }: { type: CheckinChecklistStepType }) {
  if (type === "amount") return <BanknotesIcon className="h-4 w-4" />;
  if (type === "text") return <ClipboardDocumentCheckIcon className="h-4 w-4" />;
  return <CheckIcon className="h-4 w-4" />;
}

export function checklistPreviewSteps(customSteps: CheckinChecklistStep[]) {
  return [
    SYSTEM_CHECKLIST_STEPS[0],
    {
      id: "system-additional-guests",
      label: "Guest 2+ ID / passport (generated per booking)",
      type: "checkbox" as const,
      required: true,
      system: true,
      position: 1,
    },
    { ...SYSTEM_CHECKLIST_STEPS[1], position: 2 },
    {
      id: "system-room",
      label: "Room assignment",
      type: "checkbox" as const,
      required: true,
      system: true,
      position: 3,
    },
    ...customSteps.map((step, idx) => ({ ...step, position: idx + 4 })),
  ];
}

export function CheckinChecklistPreview({ steps }: { steps: CheckinChecklistStep[] }) {
  const previewSteps = checklistPreviewSteps(steps);

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Preview checklist
        </p>
      </div>
      <div className="max-h-[520px] space-y-2 overflow-y-auto p-4">
        {previewSteps.map((step) => (
          <div
            key={step.id}
            className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-3"
          >
            <span
              className={`mt-1 h-2.5 w-2.5 rounded-full ${
                step.required ? "bg-red-500" : "bg-gray-300"
              }`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold text-gray-950">
                {step.label.trim() || "(unnamed step)"}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                  <StepTypeIcon type={step.type} />
                  {typeLabel(step.type)}
                </span>
                {step.system && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                    system
                  </span>
                )}
                <span className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-500">
                  {step.required ? "Required" : "Optional"}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CheckinChecklistBuilder() {
  const [steps, setSteps] = useState<CheckinChecklistStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const nextFocusId = useRef<string | null>(null);

  useEffect(() => {
    settingsService
      .getCheckinChecklist()
      .then((template) => setSteps(template.steps || []))
      .catch((err) => setError(err.message || "Could not load checklist"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!nextFocusId.current) return;
    const input = document.querySelector<HTMLInputElement>(
      `[data-step-label="${nextFocusId.current}"]`,
    );
    input?.focus();
    nextFocusId.current = null;
  }, [steps.length]);

  const normalizedSteps = useMemo(
    () => steps.map((step, index) => ({ ...step, position: index, system: false })),
    [steps],
  );

  const updateStep = (id: string, patch: Partial<CheckinChecklistStep>) => {
    setSuccess("");
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSteps((prev) => prev.map((step) => (step.id === id ? { ...step, ...patch } : step)));
  };

  const addStep = () => {
    const step = newStep(steps.length);
    nextFocusId.current = step.id;
    setSteps((prev) => [...prev, step]);
  };

  const removeStep = (id: string) => {
    setSuccess("");
    setSteps((prev) => prev.filter((step) => step.id !== id));
  };

  const moveStep = (fromId: string, toId: string) => {
    setSteps((prev) => {
      const from = prev.findIndex((step) => step.id === fromId);
      const to = prev.findIndex((step) => step.id === toId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const save = async () => {
    const nextErrors: Record<string, string> = {};
    normalizedSteps.forEach((step) => {
      if (!step.label.trim()) nextErrors[step.id] = "Please add a label for this step.";
    });
    setErrors(nextErrors);
    setError("");
    setSuccess("");
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const saved = await settingsService.updateCheckinChecklist(normalizedSteps);
      setSteps(saved.steps || []);
      setSuccess("Checklist saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save checklist");
    } finally {
      setSaving(false);
    }
  };

  const openPreview = () => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(normalizedSteps));
  };

  if (loading) {
    return <div className="p-4 text-sm text-gray-500">Loading checklist...</div>;
  }

  return (
    <main className="min-h-[100dvh] bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500">Settings / Check-in checklist</p>
            <h1 className="mt-1 text-2xl font-semibold text-gray-950">Check-in checklist</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              Customise the steps your team completes during every guest check-in. Drag to reorder.
              System steps are always included and cannot be removed.
            </p>
          </div>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Settings
          </Link>
        </header>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        {success && (
          <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            {success}
          </p>
        )}

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="border-b border-gray-100 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  System · Always included
                </p>
              </div>
              <div className="space-y-2 p-4">
                {SYSTEM_CHECKLIST_STEPS.map((step) => (
                  <div
                    key={step.id}
                    className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-gray-400">
                      <CheckIcon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">{step.label}</p>
                      <p className="text-xs text-gray-500">{typeLabel(step.type)}</p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      system
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="border-b border-gray-100 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Property steps · Drag to reorder
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Steps marked required will show a warning if skipped. No steps block check-in.
                </p>
              </div>

              <div className="space-y-3 p-4">
                {normalizedSteps.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                    No custom steps yet — add your first step below.
                  </div>
                )}

                {normalizedSteps.map((step) => (
                  <div
                    key={step.id}
                    draggable
                    onDragStart={() => setDraggingId(step.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (draggingId) moveStep(draggingId, step.id);
                      setDraggingId(null);
                    }}
                    className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm"
                  >
                    <div className="grid gap-3 md:grid-cols-[32px_96px_minmax(0,1fr)_150px_40px] md:items-start">
                      <button
                        type="button"
                        className="flex h-9 w-9 cursor-grab items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50"
                        aria-label="Drag to reorder"
                      >
                        <Bars3Icon className="h-5 w-5" />
                      </button>
                      <label className="flex items-center gap-2 pt-2 text-sm font-medium text-gray-700">
                        <input
                          type="checkbox"
                          checked={step.required}
                          onChange={(event) =>
                            updateStep(step.id, { required: event.target.checked })
                          }
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        Required
                      </label>
                      <div>
                        <input
                          data-step-label={step.id}
                          value={step.label}
                          maxLength={120}
                          onChange={(event) => updateStep(step.id, { label: event.target.value })}
                          placeholder="Step label"
                          className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-gray-400 ${
                            errors[step.id] ? "border-red-300 bg-red-50" : "border-gray-200"
                          }`}
                        />
                        {errors[step.id] && (
                          <p className="mt-1 text-xs text-red-600">{errors[step.id]}</p>
                        )}
                      </div>
                      <select
                        value={step.type}
                        onChange={(event) =>
                          updateStep(step.id, {
                            type: event.target.value as CheckinChecklistStepType,
                          })
                        }
                        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="checkbox">Checkbox</option>
                        <option value="text">Text input</option>
                        <option value="amount">Amount</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => removeStep(step.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600"
                        aria-label="Delete step"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addStep}
                  className="inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-semibold text-gray-600 hover:border-gray-400 hover:text-gray-900"
                >
                  <PlusIcon className="h-4 w-4" />
                  Add step
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3">
                <Link
                  href="/settings/checkin-checklist/preview"
                  onClick={openPreview}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  <EyeIcon className="h-4 w-4" />
                  Preview checklist
                </Link>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
                >
                  <ArrowsUpDownIcon className="h-4 w-4" />
                  {saving ? "Saving..." : "Save checklist"}
                </button>
              </div>
            </div>
          </div>

          <CheckinChecklistPreview steps={normalizedSteps} />
        </section>
      </div>
    </main>
  );
}

export function readChecklistPreviewDraft(): CheckinChecklistStep[] | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
