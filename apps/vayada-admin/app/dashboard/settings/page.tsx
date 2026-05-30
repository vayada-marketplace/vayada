"use client";

import { EnvelopeIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { TotpSettings } from "@/components/settings/TotpSettings";

export default function SettingsPage() {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold text-gray-900 mb-6">Account security</h1>

      <div className="space-y-4">
        {/* Two-factor authentication + login history */}
        <TotpSettings />
      </div>
    </div>
  );
}
