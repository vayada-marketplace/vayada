"use client";

import { useEffect, useState } from "react";

import { Button, FeedbackAlert, Input } from "@/components/ui";
import { integrationsService, type LodgifyConnectionStatus } from "@/services/integrations";
import { ApiErrorResponse } from "@/services/api/client";

/**
 * Phase 1a Lodgify connect / status / disconnect UI.
 *
 * Lives in the Integrations tab of the settings page. The encrypted
 * API key is write-only from the UI's perspective — the backend never
 * returns it, and a reconnect always re-prompts for the key. Same
 * pattern Cloudflare uses for API tokens, and the right default for
 * any per-tenant credential we hold.
 */
export function LodgifyIntegrationPanel() {
  const [status, setStatus] = useState<LodgifyConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  const refresh = async () => {
    try {
      const next = await integrationsService.getLodgifyStatus();
      setStatus(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load Lodgify status";
      setFeedback({ type: "error", message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const next = await integrationsService.connectLodgify({
        api_key: apiKey.trim(),
        lodgify_property_id: propertyId.trim(),
      });
      setStatus(next);
      setApiKey("");
      setPropertyId("");
      setFeedback({
        type: "success",
        message: "Lodgify connected. Rates and rooms will start syncing in a future release.",
      });
    } catch (err) {
      const message =
        err instanceof ApiErrorResponse
          ? err.message
          : err instanceof Error
            ? err.message
            : "Connection failed";
      setFeedback({ type: "error", message });
    } finally {
      setSubmitting(false);
    }
  };

  const onDisconnect = async () => {
    if (
      !confirm(
        "Disconnect Lodgify? Your stored API key will be cleared. You can reconnect anytime.",
      )
    )
      return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await integrationsService.disconnectLodgify();
      setFeedback({ type: "success", message: "Lodgify disconnected." });
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Disconnect failed";
      setFeedback({ type: "error", message });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const isConnected = status?.connected === true;

  return (
    <div className="space-y-4">
      {feedback && <FeedbackAlert type={feedback.type} message={feedback.message} />}

      <section className="border border-gray-200 rounded-lg bg-white p-4 md:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-gray-900">Lodgify</h2>
            <p className="text-[13px] text-gray-500 mt-0.5">
              Connect your Lodgify property so the Vayada Booking Engine can read rooms, rates and
              availability from Lodgify.
            </p>
          </div>
          <StatusBadge status={status} />
        </div>

        {isConnected ? (
          <ConnectedView status={status!} disabled={submitting} onDisconnect={onDisconnect} />
        ) : (
          <ConnectForm
            apiKey={apiKey}
            propertyId={propertyId}
            submitting={submitting}
            onApiKeyChange={setApiKey}
            onPropertyIdChange={setPropertyId}
            onSubmit={onConnect}
          />
        )}
      </section>

      <p className="text-[12px] text-gray-400">
        Phase 1a: connection only. Rates/availability sync and booking write-back ship in follow-up
        releases.
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: LodgifyConnectionStatus | null }) {
  if (!status || !status.connected) {
    return (
      <span className="text-[11px] font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600">
        Not connected
      </span>
    );
  }
  if (status.status === "error") {
    return (
      <span className="text-[11px] font-medium px-2 py-1 rounded-full bg-red-50 text-red-700">
        Error
      </span>
    );
  }
  return (
    <span className="text-[11px] font-medium px-2 py-1 rounded-full bg-green-50 text-green-700">
      Connected
    </span>
  );
}

function ConnectedView({
  status,
  disabled,
  onDisconnect,
}: {
  status: LodgifyConnectionStatus;
  disabled: boolean;
  onDisconnect: () => void;
}) {
  return (
    <div className="mt-4 space-y-3">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-6 text-[13px]">
        <Row label="Lodgify property">
          {status.lodgify_property_name
            ? `${status.lodgify_property_name} (${status.lodgify_property_id})`
            : status.lodgify_property_id}
        </Row>
        <Row label="Last validated">
          {status.last_validated_at ? new Date(status.last_validated_at).toLocaleString() : "—"}
        </Row>
      </dl>

      {status.last_error && (
        <div className="text-[12px] text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          Last error: {status.last_error}
        </div>
      )}

      <div className="pt-1">
        <Button variant="secondary" disabled={disabled} onClick={onDisconnect}>
          Disconnect Lodgify
        </Button>
      </div>
    </div>
  );
}

function ConnectForm({
  apiKey,
  propertyId,
  submitting,
  onApiKeyChange,
  onPropertyIdChange,
  onSubmit,
}: {
  apiKey: string;
  propertyId: string;
  submitting: boolean;
  onApiKeyChange: (v: string) => void;
  onPropertyIdChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const canSubmit = apiKey.trim().length >= 8 && propertyId.trim().length > 0 && !submitting;

  return (
    <form className="mt-4 space-y-3" onSubmit={onSubmit}>
      <Input
        id="lodgify-api-key"
        label="Lodgify API key"
        type="password"
        autoComplete="off"
        placeholder="Paste your Lodgify API key"
        value={apiKey}
        onChange={(e) => onApiKeyChange(e.target.value)}
      />
      <Input
        id="lodgify-property-id"
        label="Lodgify property ID"
        type="text"
        placeholder="e.g. 12345"
        value={propertyId}
        onChange={(e) => onPropertyIdChange(e.target.value)}
      />
      <div className="pt-1">
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? "Validating…" : "Connect Lodgify"}
        </Button>
      </div>
    </form>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900">{children}</dd>
    </>
  );
}
