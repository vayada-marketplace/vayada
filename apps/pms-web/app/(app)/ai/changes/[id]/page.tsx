"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { OneTapChange, oneTapMessagesFor } from "@vayada/assistant-ui/OneTapChange";
import { PageHeader } from "@/components/layout/PageHeader";
import { useTranslation } from "@/lib/i18n";
import { pmsOperationsClient } from "@/services/api/pmsOperationsClient";
import { getStoredPmsPropertyId } from "@/services/api/pmsPropertyClient";

/**
 * The one-tap vayada page (VAY-2528): the Yes/No for a change an AI app asked for over MCP, as the
 * person signed in to the PMS. Its link is `/ai/changes/<id>?property=<hotel>`, so the app opens
 * the change's hotel first (VAY-2099). Hidden: nothing links here until AI changes on MCP exist,
 * and with AI changes off the API has no such change, so the card says it can't be shown.
 */
export default function AiChangePage() {
  const { id } = useParams<{ id: string }>();
  const { locale } = useTranslation();
  const m = oneTapMessagesFor(locale);
  // The hotel open now; switching hotels reloads the page.
  const [selectedPropertyId] = useState(getStoredPmsPropertyId);
  return (
    <div className="p-4 md:p-6">
      <PageHeader title={m.title} subtitle={m.intro} />
      <div className="mt-5 max-w-md">
        <OneTapChange
          http={pmsOperationsClient}
          id={id}
          locale={locale}
          selectedPropertyId={selectedPropertyId}
        />
      </div>
    </div>
  );
}
