"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { GuestAutomation, MessageTemplate, messagingService } from "@/services/messaging";

const TRIGGERS = [
  { value: "before_check_in", label: "Days before check-in" },
  { value: "day_of_check_in", label: "Day of check-in" },
  { value: "after_check_out", label: "Days after check-out" },
  { value: "day_of_check_out", label: "Day of check-out" },
] as const;

const AUDIENCES = [
  { value: "all", label: "All bookings" },
  { value: "direct", label: "Direct bookings only" },
  { value: "ota", label: "OTA bookings only" },
  { value: "booking.com", label: "Booking.com only" },
  { value: "airbnb", label: "Airbnb only" },
] as const;

const DELIVERY = [
  {
    value: "smart",
    title: "Smart route",
    body: "OTA chat for Booking.com/Airbnb, email for direct.",
  },
  {
    value: "ota_only",
    title: "OTA chat only",
    body: "Skip when no OTA channel is available.",
  },
  {
    value: "email_only",
    title: "Email only",
    body: "Always send via email.",
  },
] as const;

const emptyAutomation: Partial<GuestAutomation> = {
  name: "New automation",
  icon: "calendar",
  description: "",
  triggerEvent: "before_check_in",
  daysOffset: 1,
  sendTime: "10:00",
  audience: "all",
  deliveryChannel: "smart",
  isActive: true,
  sortOrder: 100,
};

function triggerSummary(automation: Partial<GuestAutomation>) {
  const time = automation.sendTime?.slice(0, 5) || "10:00";
  if (automation.triggerEvent === "before_check_in")
    return `T-${automation.daysOffset || 0}D · ${time}`;
  if (automation.triggerEvent === "day_of_check_in") return `T-0 · ${time}`;
  if (automation.triggerEvent === "after_check_out")
    return `T+${automation.daysOffset || 0}D · ${time}`;
  return `Checkout day · ${time}`;
}

export default function InboxAutomationsPage() {
  const [automations, setAutomations] = useState<GuestAutomation[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | "new">("new");
  const [draft, setDraft] = useState<Partial<GuestAutomation>>(emptyAutomation);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const load = async () => {
    const [automationRes, templateRes] = await Promise.all([
      messagingService.listAutomations(),
      messagingService.listTemplates(),
    ]);
    setAutomations(automationRes.automations);
    setTemplates(templateRes.templates);
    if (automationRes.automations.length && selectedId === "new") {
      setSelectedId(automationRes.automations[0].id);
      setDraft(automationRes.automations[0]);
    }
  };

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === draft.templateId),
    [templates, draft.templateId],
  );

  const save = async () => {
    setSaving(true);
    setNotice("");
    try {
      if (selectedId === "new") {
        const created = await messagingService.createAutomation({
          name: draft.name || "New automation",
          icon: draft.icon || "calendar",
          description: draft.description || "",
          triggerEvent: draft.triggerEvent || "before_check_in",
          daysOffset: draft.daysOffset ?? 1,
          sendTime: draft.sendTime || "10:00",
          audience: draft.audience || "all",
          deliveryChannel: draft.deliveryChannel || "smart",
          templateId: draft.templateId || templates[0]?.id || null,
          isActive: draft.isActive ?? true,
          sortOrder: draft.sortOrder || 100,
        });
        setAutomations((prev) => [...prev, created]);
        setSelectedId(created.id);
        setDraft(created);
      } else {
        const updated = await messagingService.updateAutomation(selectedId, draft);
        setAutomations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        setDraft(updated);
      }
      setNotice("Automation saved");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (automation: GuestAutomation, isActive: boolean) => {
    const updated = await messagingService.updateAutomation(automation.id, { isActive });
    setAutomations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    if (selectedId === updated.id) setDraft(updated);
  };

  const duplicate = () => {
    setSelectedId("new");
    setDraft({
      ...draft,
      name: `${draft.name || "Automation"} copy`,
      sortOrder: (draft.sortOrder || 0) + 1,
    });
  };

  const remove = async () => {
    if (selectedId === "new") return;
    await messagingService.deleteAutomation(selectedId);
    const next = automations.filter((item) => item.id !== selectedId);
    setAutomations(next);
    setSelectedId(next[0]?.id || "new");
    setDraft(next[0] || emptyAutomation);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-50">
      <header className="border-b border-gray-200 bg-white px-5 py-4">
        <Link href="/inbox" className="text-sm font-medium text-gray-500 hover:text-gray-900">
          ← Back to inbox
        </Link>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Guest journey automation</h1>
            <p className="text-sm text-gray-500">Pre-arrival, in-stay and post-stay sequences.</p>
          </div>
          <button
            onClick={() => {
              setSelectedId("new");
              setDraft({ ...emptyAutomation, templateId: templates[0]?.id || null });
            }}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            + New
          </button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 xl:grid-cols-[360px_1fr]">
        <aside className="space-y-3">
          {automations.map((automation) => (
            <button
              key={automation.id}
              onClick={() => {
                setSelectedId(automation.id);
                setDraft(automation);
                setNotice("");
              }}
              className={`block w-full rounded-xl border p-4 text-left hover:bg-white ${
                selectedId === automation.id
                  ? "border-emerald-200 bg-white shadow-sm"
                  : "border-gray-200 bg-white/70"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{automation.name}</p>
                  <p className="mt-1 text-xs text-gray-500">{triggerSummary(automation)}</p>
                  <p className="mt-1 text-xs text-gray-400">{automation.templateName}</p>
                </div>
                <span
                  className={`mt-1 h-2.5 w-2.5 rounded-full ${
                    automation.isActive ? "bg-emerald-500" : "bg-gray-300"
                  }`}
                />
              </div>
            </button>
          ))}
        </aside>

        <section className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {automations.map((automation) => (
              <div key={automation.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{automation.name}</p>
                    <p className="mt-1 text-xs uppercase tracking-wide text-emerald-700">
                      {triggerSummary(automation)}
                    </p>
                    <p className="mt-2 text-xs text-gray-500">{automation.description}</p>
                    <p className="mt-2 text-[11px] text-gray-400">
                      {automation.deliveryChannel === "smart"
                        ? "Auto-route: OTA chat / Email"
                        : automation.deliveryChannel === "ota_only"
                          ? "OTA chat only"
                          : "Email only"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(automation, !automation.isActive)}
                    className={`h-6 w-11 rounded-full p-0.5 transition ${
                      automation.isActive ? "bg-emerald-600" : "bg-gray-300"
                    }`}
                    aria-label="Toggle automation"
                  >
                    <span
                      className={`block h-5 w-5 rounded-full bg-white transition ${
                        automation.isActive ? "translate-x-5" : ""
                      }`}
                    />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-gray-900">Automation editor</h2>
              <div className="flex gap-2">
                <button
                  onClick={duplicate}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600"
                >
                  Duplicate
                </button>
                {selectedId !== "new" && (
                  <button
                    onClick={remove}
                    className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600"
                  >
                    Delete
                  </button>
                )}
                <button
                  onClick={save}
                  disabled={saving}
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-semibold text-gray-700">Name</span>
                <input
                  value={draft.name || ""}
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-gray-700">Icon</span>
                <input
                  value={draft.icon || ""}
                  onChange={(e) => setDraft((prev) => ({ ...prev, icon: e.target.value }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </label>
              <label className="space-y-1 md:col-span-2">
                <span className="text-xs font-semibold text-gray-700">Description</span>
                <input
                  value={draft.description || ""}
                  onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-gray-700">When to send</span>
                <select
                  value={draft.triggerEvent || "before_check_in"}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      triggerEvent: e.target.value as GuestAutomation["triggerEvent"],
                    }))
                  }
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                >
                  {TRIGGERS.map((trigger) => (
                    <option key={trigger.value} value={trigger.value}>
                      {trigger.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-gray-700">Days offset</span>
                <input
                  type="number"
                  min={0}
                  value={draft.daysOffset ?? 0}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, daysOffset: Number(e.target.value) }))
                  }
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-gray-700">Send at local time</span>
                <input
                  type="time"
                  value={draft.sendTime?.slice(0, 5) || "10:00"}
                  onChange={(e) => setDraft((prev) => ({ ...prev, sendTime: e.target.value }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-gray-700">Audience</span>
                <select
                  value={draft.audience || "all"}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      audience: e.target.value as GuestAutomation["audience"],
                    }))
                  }
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                >
                  {AUDIENCES.map((audience) => (
                    <option key={audience.value} value={audience.value}>
                      {audience.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-5">
              <p className="mb-2 text-xs font-semibold text-gray-700">Delivery channel</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {DELIVERY.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        deliveryChannel: option.value as GuestAutomation["deliveryChannel"],
                      }))
                    }
                    className={`rounded-xl border p-3 text-left ${
                      draft.deliveryChannel === option.value
                        ? "border-emerald-300 bg-emerald-50"
                        : "border-gray-200 bg-white hover:bg-gray-50"
                    }`}
                  >
                    <span className="block text-sm font-semibold text-gray-900">
                      {option.title}
                    </span>
                    <span className="mt-1 block text-xs text-gray-500">{option.body}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-semibold text-gray-700">Message template</span>
                <select
                  value={draft.templateId || ""}
                  onChange={(e) => setDraft((prev) => ({ ...prev, templateId: e.target.value }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                <p className="text-xs font-semibold text-gray-700">Next scheduled send</p>
                <p className="mt-1 text-sm text-gray-900">
                  {triggerSummary(draft)} ·{" "}
                  {draft.deliveryChannel === "smart" ? "via Smart route" : draft.deliveryChannel}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Template: {selectedTemplate?.name || "No template selected"}
                </p>
              </div>
            </div>
            {notice && <p className="mt-3 text-sm text-emerald-700">{notice}</p>}
          </div>
        </section>
      </main>
    </div>
  );
}
