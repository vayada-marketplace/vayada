import { cspReportResponse } from "@vayada/web-security/csp";

// VAY-2516: browsers report Content-Security-Policy violations here (report-uri).
export function POST(request: Request) {
  return cspReportResponse(request, "pms-web");
}
