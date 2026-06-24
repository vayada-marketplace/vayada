"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { messagingService, MessageTemplate } from "@/services/messaging";

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "pre_arrival", label: "Pre-arrival" },
  { id: "in_stay", label: "In-stay" },
  { id: "post_stay", label: "Post-stay" },
  { id: "general", label: "General" },
] as const;

const VARIABLES = [
  ["guest", "Guest first name"],
  ["guest_full", "Guest full name"],
  ["property", "Property name"],
  ["checkin_date", "Check-in date"],
  ["checkout_date", "Check-out date"],
  ["checkin_time", "Check-in time"],
  ["nights", "Night count"],
  ["wifi", "WiFi password"],
  ["address", "Property address"],
  ["host", "Host/contact name"],
  ["review_link", "Google review link"],
  ["referral_link", "Referral link"],
];

const emptyTemplate: Partial<MessageTemplate> = {
  name: "New template",
  category: "general",
  icon: "chat",
  content: "",
  sortOrder: 100,
};

export default function InboxTemplatesPage() {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [activeCategory, setActiveCategory] = useState<(typeof CATEGORIES)[number]["id"]>("all");
  const [selectedId, setSelectedId] = useState<string | "new">("new");
  const [draft, setDraft] = useState<Partial<MessageTemplate>>(emptyTemplate);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const load = async () => {
    const [templateRes, variableRes] = await Promise.all([
      messagingService.listTemplates(),
      messagingService.variablePreview(),
    ]);
    setTemplates(templateRes.templates);
    setVariables(variableRes.variables);
    if (templateRes.templates.length && selectedId === "new") {
      setSelectedId(templateRes.templates[0].id);
      setDraft(templateRes.templates[0]);
    }
  };

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = templates.filter(
    (template) => activeCategory === "all" || template.category === activeCategory,
  );

  const variablesInUse = useMemo(() => {
    const matches = Array.from((draft.content || "").matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g));
    return Array.from(new Set(matches.map((match) => match[1])));
  }, [draft.content]);

  const selectTemplate = (template: MessageTemplate) => {
    setSelectedId(template.id);
    setDraft(template);
    setNotice("");
  };

  const insertVariable = (key: string) => {
    const tag = `{{${key}}}`;
    const node = editorRef.current;
    const content = draft.content || "";
    if (!node) {
      setDraft((prev) => ({ ...prev, content: `${content}${tag}` }));
      return;
    }
    const start = node.selectionStart;
    const end = node.selectionEnd;
    const next = `${content.slice(0, start)}${tag}${content.slice(end)}`;
    setDraft((prev) => ({ ...prev, content: next }));
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + tag.length, start + tag.length);
    });
  };

  const save = async () => {
    setSaving(true);
    setNotice("");
    try {
      if (selectedId === "new") {
        const created = await messagingService.createTemplate({
          name: draft.name || "New template",
          category: draft.category || "general",
          icon: draft.icon || "chat",
          content: draft.content || "",
          sortOrder: draft.sortOrder || 100,
        });
        setTemplates((prev) => [...prev, created]);
        setSelectedId(created.id);
        setDraft(created);
      } else {
        const updated = await messagingService.updateTemplate(selectedId, draft);
        setTemplates((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        setDraft(updated);
      }
      setNotice("Template saved");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (selectedId === "new") return;
    await messagingService.deleteTemplate(selectedId);
    const next = templates.filter((item) => item.id !== selectedId);
    setTemplates(next);
    setSelectedId(next[0]?.id || "new");
    setDraft(next[0] || emptyTemplate);
  };

  const duplicate = () => {
    setSelectedId("new");
    setDraft({
      ...draft,
      name: `${draft.name || "Template"} copy`,
      isDefault: false,
      sortOrder: (draft.sortOrder || 0) + 1,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-50">
      <header className="border-b border-gray-200 bg-white px-5 py-4">
        <Link href="/inbox" className="text-sm font-medium text-gray-500 hover:text-gray-900">
          ← Back to Inbox
        </Link>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Templates</h1>
            <p className="text-sm text-gray-500">{templates.length} reusable replies</p>
          </div>
          <button
            onClick={() => {
              setSelectedId("new");
              setDraft(emptyTemplate);
            }}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            + New
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-gray-200 bg-white">
          <div className="flex gap-2 overflow-x-auto border-b border-gray-100 p-3">
            {CATEGORIES.map((category) => (
              <button
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
                  activeCategory === category.id
                    ? "bg-emerald-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {category.label}
              </button>
            ))}
          </div>
          {filtered.map((template) => (
            <button
              key={template.id}
              onClick={() => selectTemplate(template)}
              className={`block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 ${
                selectedId === template.id ? "bg-emerald-50" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{template.icon}</span>
                <span className="text-sm font-semibold text-gray-900">{template.name}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-gray-500">{template.content}</p>
              <p className="mt-2 text-[11px] uppercase tracking-wide text-gray-400">
                {template.category.replace("_", " ")}
              </p>
            </button>
          ))}
        </aside>

        <main className="grid min-w-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 xl:grid-cols-[1fr_280px]">
          <section className="space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_120px]">
                <input
                  value={draft.name || ""}
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-900 outline-none focus:border-emerald-500"
                />
                <select
                  value={draft.category || "general"}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      category: e.target.value as MessageTemplate["category"],
                    }))
                  }
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none focus:border-emerald-500"
                >
                  {CATEGORIES.filter((item) => item.id !== "all").map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </select>
                <input
                  value={draft.icon || ""}
                  onChange={(e) => setDraft((prev) => ({ ...prev, icon: e.target.value }))}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none focus:border-emerald-500"
                  placeholder="Icon"
                />
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-3 text-xs font-semibold text-gray-700">
                Message content
              </div>
              <textarea
                ref={editorRef}
                value={draft.content || ""}
                onChange={(e) => setDraft((prev) => ({ ...prev, content: e.target.value }))}
                rows={16}
                className="w-full resize-none rounded-b-xl px-4 py-3 text-sm leading-6 text-gray-900 outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
              <div className="flex flex-wrap gap-2">
                {variablesInUse.length === 0 ? (
                  <span className="text-xs text-gray-400">No variables in use</span>
                ) : (
                  variablesInUse.map((key) => (
                    <button
                      key={key}
                      onClick={() => insertVariable(key)}
                      className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                    >
                      {`{{${key}}}`}
                    </button>
                  ))
                )}
              </div>
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
            {notice && <p className="text-sm text-emerald-700">{notice}</p>}
          </section>

          <aside className="space-y-3">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-gray-900">Insert variable</h2>
              <div className="mt-3 space-y-2">
                {VARIABLES.map(([key, description]) => (
                  <button
                    key={key}
                    onClick={() => insertVariable(key)}
                    className="block w-full rounded-lg border border-gray-100 px-3 py-2 text-left hover:bg-gray-50"
                  >
                    <span className="block text-xs font-semibold text-emerald-700">{`{{${key}}}`}</span>
                    <span className="block text-[11px] text-gray-500">{description}</span>
                    <span className="mt-1 block truncate text-[11px] text-gray-400">
                      {variables[key] || `{{${key}}}`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}
