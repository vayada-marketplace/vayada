"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheckIcon, KeyIcon, ClockIcon } from "@heroicons/react/24/outline";
import { authService } from "@/services/auth";

type Step = "idle" | "setup" | "confirm" | "recovery" | "regen";

interface LoginEntry {
  id: string;
  success: boolean;
  auth_method: string | null;
  failure_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

function Feedback({ type, message }: { type: "success" | "error"; message: string }) {
  return (
    <div
      className={`px-3 py-2.5 rounded-lg text-[13px] border ${
        type === "success"
          ? "bg-green-50 text-green-800 border-green-200"
          : "bg-red-50 text-red-800 border-red-200"
      }`}
    >
      {message}
    </div>
  );
}

export function TotpSettings() {
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [codeCount, setCodeCount] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [secret, setSecret] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [regenCode, setRegenCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const [history, setHistory] = useState<LoginEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const [statusRes, countRes] = await Promise.all([
        authService.totpStatus(),
        authService.totpCodeCount().catch(() => ({ count: 0 })),
      ]);
      setEnrolled(statusRes.enrolled);
      setCodeCount(countRes.count);
    } catch {
      setEnrolled(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await authService.loginHistory();
      setHistory(res.entries);
    } catch {
      // non-critical
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadHistory();
  }, [loadStatus, loadHistory]);

  const handleEnable = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await authService.totpSetup();
      setOtpauthUri(res.otpauth_uri);
      setSecret(res.secret);
      setConfirmCode("");
      setStep("setup");
    } catch {
      setFeedback({ type: "error", message: "Failed to start 2FA setup. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setFeedback(null);
    try {
      const res = await authService.totpConfirm(confirmCode.trim());
      setRecoveryCodes(res.recovery_codes);
      setEnrolled(true);
      setCodeCount(res.recovery_codes.length);
      setStep("recovery");
    } catch {
      setFeedback({ type: "error", message: "Invalid code. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  const handleRegen = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setFeedback(null);
    try {
      const res = await authService.totpRegenerateCodes(regenCode.trim());
      setRecoveryCodes(res.recovery_codes);
      setCodeCount(res.recovery_codes.length);
      setStep("recovery");
    } catch {
      setFeedback({ type: "error", message: "Invalid code. Recovery codes not changed." });
    } finally {
      setLoading(false);
    }
  };

  const copyAllCodes = () => {
    navigator.clipboard.writeText(recoveryCodes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* TOTP card */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
        <div className="flex items-center gap-1.5 mb-0.5">
          <ShieldCheckIcon className="w-4 h-4 text-gray-700" />
          <h2 className="text-sm font-semibold text-gray-900">Two-factor authentication</h2>
          {enrolled === true && (
            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-100 text-green-800">
              Enabled
            </span>
          )}
        </div>
        <p className="text-[13px] text-gray-500 mb-4">
          Add an extra layer of security to your account with an authenticator app.
        </p>

        {feedback && <Feedback type={feedback.type} message={feedback.message} />}

        {enrolled === false && step === "idle" && (
          <button
            onClick={handleEnable}
            disabled={loading}
            className="mt-3 px-3 py-1.5 bg-primary-600 text-white text-[13px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {loading ? "Setting up..." : "Enable 2FA"}
          </button>
        )}

        {step === "setup" && (
          <div className="space-y-4 max-w-sm mt-3">
            <p className="text-[13px] text-gray-700">
              Open your authenticator app (Google Authenticator, Authy, 1Password, etc.) and scan
              the link below, or enter the key manually.
            </p>
            <a
              href={otpauthUri}
              className="inline-block text-[13px] text-primary-600 hover:underline break-all"
            >
              Open in authenticator app
            </a>
            <div>
              <p className="text-[13px] text-gray-600 mb-1">Or enter this key manually:</p>
              <code className="block bg-gray-100 rounded px-3 py-2 text-sm font-mono tracking-widest break-all select-all">
                {secret}
              </code>
            </div>
            <form onSubmit={handleConfirm} className="space-y-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                  Enter the 6-digit code from your app to confirm setup
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 tracking-widest text-center"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={loading || confirmCode.trim().length === 0}
                  className="px-3 py-1.5 bg-primary-600 text-white text-[13px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {loading ? "Verifying..." : "Confirm & Enable"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep("idle")}
                  className="px-3 py-1.5 text-[13px] text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {step === "recovery" && recoveryCodes.length > 0 && (
          <div className="space-y-3 max-w-sm mt-3">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-[13px] text-yellow-800 font-medium">
                Save these recovery codes somewhere safe. Each can be used once if you lose access
                to your authenticator.
              </p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 grid grid-cols-2 gap-1.5">
              {recoveryCodes.map((code) => (
                <code key={code} className="text-[12px] font-mono text-gray-700">
                  {code}
                </code>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={copyAllCodes}
                className="px-3 py-1.5 border border-gray-300 text-[13px] text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {copied ? "Copied!" : "Copy all"}
              </button>
              <button
                onClick={() => {
                  setRecoveryCodes([]);
                  setStep("idle");
                }}
                className="px-3 py-1.5 bg-primary-600 text-white text-[13px] font-medium rounded-lg hover:bg-primary-700 transition-colors"
              >
                {"I've saved them"}
              </button>
            </div>
          </div>
        )}

        {enrolled === true && step === "idle" && (
          <div className="space-y-3 mt-3">
            <div className="flex items-center gap-2">
              <KeyIcon className="w-4 h-4 text-gray-500" />
              <span className="text-[13px] text-gray-700">
                {codeCount ?? 0} recovery codes remaining
              </span>
            </div>
            <button
              onClick={() => {
                setRegenCode("");
                setFeedback(null);
                setStep("regen");
              }}
              className="px-3 py-1.5 border border-gray-300 text-[13px] text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Regenerate recovery codes
            </button>
          </div>
        )}

        {step === "regen" && (
          <form onSubmit={handleRegen} className="space-y-3 max-w-sm mt-3">
            <p className="text-[13px] text-gray-700">
              Enter your current 6-digit TOTP code to generate new recovery codes. Your old codes
              will be invalidated.
            </p>
            <input
              type="text"
              inputMode="numeric"
              value={regenCode}
              onChange={(e) => setRegenCode(e.target.value)}
              placeholder="000000"
              autoComplete="one-time-code"
              autoFocus
              className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 tracking-widest text-center"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={loading || regenCode.trim().length === 0}
                className="px-3 py-1.5 bg-primary-600 text-white text-[13px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {loading ? "Regenerating..." : "Generate new codes"}
              </button>
              <button
                type="button"
                onClick={() => setStep("idle")}
                className="px-3 py-1.5 text-[13px] text-gray-600 hover:text-gray-900 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Login history */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
        <div className="flex items-center gap-1.5 mb-0.5">
          <ClockIcon className="w-4 h-4 text-gray-700" />
          <h2 className="text-sm font-semibold text-gray-900">Login history</h2>
        </div>
        <p className="text-[13px] text-gray-500 mb-4">Your 20 most recent login events.</p>

        {historyLoading ? (
          <p className="text-[13px] text-gray-500">Loading...</p>
        ) : history.length === 0 ? (
          <p className="text-[13px] text-gray-500">No login events recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left font-medium text-gray-500 pb-2 pr-3">Date</th>
                  <th className="text-left font-medium text-gray-500 pb-2 pr-3">Result</th>
                  <th className="text-left font-medium text-gray-500 pb-2 pr-3">Method</th>
                  <th className="text-left font-medium text-gray-500 pb-2">IP address</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id} className="border-b border-gray-50">
                    <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">
                      {new Date(entry.created_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">
                      {entry.success ? (
                        <span className="text-green-700 font-medium">Success</span>
                      ) : (
                        <span className="text-red-600 font-medium">Failed</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-gray-600">{entry.auth_method ?? "—"}</td>
                    <td className="py-2 text-gray-600">{entry.ip_address ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
