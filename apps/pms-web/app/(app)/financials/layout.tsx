"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { verifyFinancialsAccess } from "@/services/finance/financialReports";

export default function FinancialsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setAllowed(false);
      void resolveSelectedPmsPropertyId("checking Financials access")
        .then((propertyId) => verifyFinancialsAccess(propertyId, signal))
        .then(() => {
          if (!signal.aborted) setAllowed(true);
        })
        .catch(() => {
          if (!signal.aborted) router.replace("/dashboard");
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("vayada-feature-modules-changed", refresh);
    return () => {
      controller?.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("vayada-feature-modules-changed", refresh);
    };
  }, [router]);

  return allowed ? children : null;
}
