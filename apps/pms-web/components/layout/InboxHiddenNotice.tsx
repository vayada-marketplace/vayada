"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";

import { useTranslation } from "@/lib/i18n";
import { pmsNavigationModuleClient } from "@/services/api/pmsNavigationModuleClient";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { messagingService } from "@/services/messaging";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type NavigationModules = { activeModules: readonly string[]; canManage: boolean };
export type InboxHiddenNoticeState = { unread: number; canManage: boolean };

/** A notice is due only when Inbox is known to be off and guests are waiting (VAY-2078). */
export function inboxHiddenNotice(
  modules: NavigationModules | null,
  unread: number | null,
): InboxHiddenNoticeState | null {
  if (!modules || modules.activeModules.includes("inbox") || !unread || unread < 1) return null;
  return { unread, canManage: modules.canManage };
}

export function InboxHiddenNoticeView({
  notice,
  t,
}: {
  notice: InboxHiddenNoticeState;
  t: Translate;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[13px] text-amber-900"
    >
      <ChatBubbleLeftRightIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        {notice.unread === 1
          ? t("layout.inboxNotice.unreadOne")
          : t("layout.inboxNotice.unreadMany", { count: notice.unread })}
      </span>
      {notice.canManage ? (
        // A full navigation, because /pricing runs outside the client router.
        <a
          href="/settings/feature-hub"
          className="font-semibold underline underline-offset-2 hover:text-amber-950"
        >
          {t("layout.inboxNotice.turnOn")}
        </a>
      ) : (
        <span className="text-amber-800">{t("layout.inboxNotice.askManager")}</span>
      )}
    </div>
  );
}

/** While Inbox is switched off, unread guest messages (OTA or email) still get noticed. */
export default function InboxHiddenNotice({ permissions }: { permissions: readonly string[] }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  // The unread count is a pms.inbox.read endpoint; members without it never call it.
  const canReadInbox = permissions.includes("pms.inbox.read");
  const [modules, setModules] = useState<NavigationModules | null>(null);
  const [unread, setUnread] = useState<number | null>(null);
  const inboxOff = modules !== null && !modules.activeModules.includes("inbox");

  useEffect(() => {
    if (!canReadInbox) {
      setModules(null);
      return;
    }
    let sequence = 0;
    const refresh = () => {
      const current = ++sequence;
      void pmsNavigationModuleClient
        .list()
        .then((response) => {
          if (current !== sequence) return;
          // A malformed read counts as unknown rather than breaking every PMS page.
          setModules(Array.isArray(response?.activeModules) ? response : null);
        })
        .catch(() => {
          // Unknown switches keep Inbox in the sidebar, so no notice is needed.
          if (current === sequence) setModules(null);
        });
    };
    refresh();
    window.addEventListener("vayada-feature-modules-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      sequence += 1;
      window.removeEventListener("vayada-feature-modules-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [canReadInbox]);

  useEffect(() => {
    if (!inboxOff) {
      setUnread(null);
      return;
    }
    let cancelled = false;
    const loadUnread = async () => {
      try {
        const propertyId = await resolveSelectedPmsPropertyId("loading the Inbox unread count");
        const count = await messagingService.unreadCount(propertyId);
        if (!cancelled) setUnread(count.messageCount);
      } catch {
        if (!cancelled) setUnread(null);
      }
    };
    void loadUnread();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadUnread();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [inboxOff]);

  // On the Inbox page itself the messages are already in view (it stays reachable by link).
  const notice = pathname?.startsWith("/inbox") ? null : inboxHiddenNotice(modules, unread);
  return notice ? <InboxHiddenNoticeView notice={notice} t={t} /> : null;
}
