"use client";

import { useTranslation } from "@/lib/i18n";
import { FeatureHubPage } from "@vayada/feature-hub";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";
import { PageLayout } from "@/components/layout/PageLayout";

export default function BookingFeatureHubRoute() {
  const { t } = useTranslation();
  return (
    // The shared Feature Hub page brings its own padding (16px, 24px from md, the same as the
    // page tokens), so the frame only adds the max width and centring.
    <PageLayout className="p-0">
      <FeatureHubPage
        translate={t}
        activationClient={moduleActivationClient}
        initialProduct="booking_engine"
      />
    </PageLayout>
  );
}
