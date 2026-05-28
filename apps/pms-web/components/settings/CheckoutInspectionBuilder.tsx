"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  Bars3Icon,
  CheckCircleIcon,
  EyeIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { CheckoutInspectionStep, settingsService } from "@/services/settings";

const DRAFT_STORAGE_KEY = "vayada:pms:checkout-inspection-preview";

function newStep(position: number): CheckoutInspectionStep {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `checkout-step-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    label: "",
    okLabel: "OK",
    negativeLabel: "Issue",
    notePrompt: "Add details...",
    required: true,
    position,
  };
}

export function CheckoutInspectionPreview({ steps }: { steps: CheckoutInspectionStep[] }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Inspection preview
        </p>
      </div>
      <div className="max-h-[520px] space-y-2 overflow-y-auto p-4">
        {steps.map((step) => (
          <div key={step.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-gray-950">
                  {step.label.trim() || "(unnamed step)"}
                </p>
                <p className="mt-1 text-xs text-gray-500">{step.notePrompt}</p>
              </div>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-500">
                {step.required ? "Required" : "Optional"}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
                {step.okLabel}
              </span>
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
                {step.negativeLabel}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CheckoutInspectionBuilder() {
  const [steps, setSteps] = useState<CheckoutInspectionStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const nextFocusId = useRef<string | null>(null);

  useEffect(() => {
    settingsService
      .getCheckoutInspection()
      .then((template) => setSteps(template.steps || []))
      .catch((err) => setError(err.message || "Could not load inspection settings"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!nextFocusId.current) return;
    document.querySelector<HTMLInputElement>(`[data-step-label="${nextFocusId.current}"]`)?.focus();
    nextFocusId.current = null;
  }, [steps.length]);

  const normalizedSteps = useMemo(
    () => steps.map((step, index) => ({ ...step, position: index })),
    [steps],
  );

  const updateStep = (id: string, patch: Partial<CheckoutInspectionStep>) => {
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
      if (!step.label.trim()) nextErrors[step.id] = "Add a label.";
      if (!step.okLabel.trim()) nextErrors[`${step.id}-ok`] = "Add an OK label.";
      if (!step.negativeLabel.trim()) nextErrors[`${step.id}-negative`] = "Add a negative label.";
      if (!step.notePrompt.trim()) nextErrors[`${step.id}-prompt`] = "Add a note prompt.";
    });
    setErrors(nextErrors);
    setError("");
    setSuccess("");
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const saved = await settingsService.updateCheckoutInspection(normalizedSteps);
      setSteps(saved.steps || []);
      setSuccess("Inspection steps saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save inspection settings");
    } finally {
      setSaving(false);
    }
  };

  const openPreview = () => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(normalizedSteps));
  };

  if (loading) {
    return <div className="p-4 text-sm text-gray-500">Loading inspection settings...</div>;
  }

  return (
    <main className="min-h-[100dvh] bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500">Settings / Check-out inspection</p>
            <h1 className="mt-1 text-2xl font-semibold text-gray-950">Check-out inspection</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              Customise the room inspection steps your team completes before a guest leaves.
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
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Custom inspection steps
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Required steps warn staff if unresolved; pending charges are the only hard block.
              </p>
            </div>
            <div className="space-y-3 p-4">
              {normalizedSteps.map((step, index) => {
                const previousStep = normalizedSteps[index - 1];
                const nextStep = normalizedSteps[index + 1];
                return (
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
                    <div className="grid gap-3 md:grid-cols-[88px_minmax(0,1fr)_110px_120px_150px_40px] md:items-start">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className="flex h-9 w-9 cursor-grab items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50"
                          aria-label="Drag to reorder"
                        >
                          <Bars3Icon className="h-5 w-5" />
                        </button>
                        <div className="flex flex-col">
                          <button
                            type="button"
                            onClick={() => previousStep && moveStep(step.id, previousStep.id)}
                            disabled={!previousStep}
                            className="flex h-4 w-7 items-center justify-center rounded text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                            aria-label="Move step up"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => nextStep && moveStep(step.id, nextStep.id)}
                            disabled={!nextStep}
                            className="flex h-4 w-7 items-center justify-center rounded text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                            aria-label="Move step down"
                          >
                            ↓
                          </button>
                        </div>
                      </div>
                      <Field
                        value={step.label}
                        placeholder="Label"
                        error={errors[step.id]}
                        dataStepLabel={step.id}
                        onChange={(value) => updateStep(step.id, { label: value })}
                      />
                      <Field
                        value={step.okLabel}
                        placeholder="OK label"
                        error={errors[`${step.id}-ok`]}
                        onChange={(value) => updateStep(step.id, { okLabel: value })}
                      />
                      <Field
                        value={step.negativeLabel}
                        placeholder="Negative"
                        error={errors[`${step.id}-negative`]}
                        onChange={(value) => updateStep(step.id, { negativeLabel: value })}
                      />
                      <Field
                        value={step.notePrompt}
                        placeholder="Note prompt"
                        error={errors[`${step.id}-prompt`]}
                        onChange={(value) => updateStep(step.id, { notePrompt: value })}
                      />
                      <button
                        type="button"
                        onClick={() => removeStep(step.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600"
                        aria-label="Delete step"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                    <label className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-gray-700">
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
                  </div>
                );
              })}

              {normalizedSteps.length === 0 && (
                <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                  No inspection steps yet. Add the first room check below.
                </div>
              )}

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
                href="/settings/checkout-inspection/preview"
                onClick={openPreview}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                <EyeIcon className="h-4 w-4" />
                Preview
              </Link>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
              >
                <CheckCircleIcon className="h-4 w-4" />
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          <CheckoutInspectionPreview steps={normalizedSteps} />
        </section>
      </div>
    </main>
  );
}

function Field({
  value,
  placeholder,
  error,
  dataStepLabel,
  onChange,
}: {
  value: string;
  placeholder: string;
  error?: string;
  dataStepLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <input
        data-step-label={dataStepLabel}
        value={value}
        maxLength={160}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-gray-400 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function readCheckoutInspectionPreviewDraft(): CheckoutInspectionStep[] | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as CheckoutInspectionStep[];
  } catch {
    return null;
  }
}
