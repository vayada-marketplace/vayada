"use client";

import { ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { ApiErrorResponse } from "@/services/api/client";
import {
  getReportCsv,
  requestReportCsv,
  type ReportExportInput,
} from "@/services/finance/financialReports";

// A new scope remounts the request state so old responses cannot publish a link.
export function ReportExportButton(props: {
  propertyId: string;
  input: ReportExportInput;
  disabled?: boolean;
}) {
  return <ScopedExportButton key={JSON.stringify([props.propertyId, props.input])} {...props} />;
}

function ScopedExportButton({
  propertyId,
  input,
  disabled,
}: {
  propertyId: string;
  input: ReportExportInput;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const [notice, setNotice] = useState("");
  const [download, setDownload] = useState<{ url: string; expiresAt: string }>();
  const commandId = useRef<string>();
  const inFlight = useRef(false);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);

  async function exportCsv() {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setDownload(undefined);
    try {
      commandId.current ??= crypto.randomUUID();
      const id =
        jobId ??
        (await requestReportCsv(propertyId, input, commandId.current, controller.signal)).item
          .resourceId;
      if (controller.signal.aborted) return;
      setJobId(id);
      const result = await getReportCsv(propertyId, id, controller.signal);
      if (controller.signal.aborted) return;
      if (result.item.state === "ready" && result.item.download) {
        setDownload(result.item.download);
        setNotice("CSV is ready.");
      } else if (result.item.state === "failed" || result.item.state === "expired") {
        setJobId(undefined);
        commandId.current = undefined;
        setNotice("The CSV is unavailable. Request a new export.");
      } else {
        setNotice("Your CSV is being prepared. Check again shortly.");
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice(
          error instanceof ApiErrorResponse && [401, 403].includes(error.status)
            ? "You do not have permission to export this report."
            : "The export could not be checked. Try again.",
        );
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={exportCsv}
        className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 disabled:opacity-50"
      >
        <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
        {busy ? "Preparing…" : jobId ? "Check export" : "Export CSV"}
      </button>
      {notice && (
        <p role="status" className="text-sm text-gray-600">
          {notice}
        </p>
      )}
      {!disabled && download && Date.parse(download.expiresAt) > Date.now() && (
        <a className="text-sm text-blue-700 underline" href={download.url} rel="noreferrer">
          Download CSV
        </a>
      )}
    </div>
  );
}
