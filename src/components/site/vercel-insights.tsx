"use client";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { redactAnalyticsEvent } from "@/lib/analytics-redact";

// Componente cliente: o beforeSend é função e não atravessa do layout (servidor).
export function VercelInsights() {
  return (
    <>
      <Analytics beforeSend={redactAnalyticsEvent} />
      <SpeedInsights beforeSend={redactAnalyticsEvent} />
    </>
  );
}
