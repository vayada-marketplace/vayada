import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import { inboxHiddenNotice, InboxHiddenNoticeView } from "./InboxHiddenNotice";

const t = (key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    (en as Record<string, string>)[key] ?? key,
  );

describe("inboxHiddenNotice", () => {
  it("is due only while Inbox is known to be off and guests are waiting", () => {
    const off = { activeModules: ["reviews"], canManage: true };
    expect(inboxHiddenNotice(off, 3)).toEqual({ unread: 3, canManage: true });
    expect(inboxHiddenNotice({ ...off, activeModules: ["inbox"] }, 3)).toBeNull();
    // Unreadable switches keep Inbox in the sidebar, so there is nothing to warn about.
    expect(inboxHiddenNotice(null, 3)).toBeNull();
    expect(inboxHiddenNotice(off, 0)).toBeNull();
    expect(inboxHiddenNotice(off, null)).toBeNull();
  });
});

describe("InboxHiddenNoticeView", () => {
  it("gives owners and operators the Feature Hub switch", () => {
    const markup = renderToStaticMarkup(
      <InboxHiddenNoticeView notice={{ unread: 3, canManage: true }} t={t} />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("You have 3 unread guest messages.");
    expect(markup).toContain('href="/settings/feature-hub"');
    expect(markup).toContain(">Turn on Inbox</a>");
  });

  it("tells front desk staff who can turn Inbox on, without a switch", () => {
    const markup = renderToStaticMarkup(
      <InboxHiddenNoticeView notice={{ unread: 1, canManage: false }} t={t} />,
    );
    expect(markup).toContain("You have 1 unread guest message.");
    expect(markup).toContain("An owner or operator can turn on Inbox in the Feature Hub.");
    expect(markup).not.toContain("<a ");
  });
});
