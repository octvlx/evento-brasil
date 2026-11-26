"use client";

// Medição de anúncios do organizador (Meta Pixel, Google Analytics 4, Google Ads) nas
// páginas do evento, do pagamento e do pedido. Nada carrega sem o aceite do comprador
// (LGPD): sem escolha, aparece o aviso; recusado, nada é carregado. Os scripts vêm só
// de connect.facebook.net e www.googletagmanager.com (CSP em next.config.ts). Nenhum
// dado pessoal é enviado: só o id do evento, o valor e o código do pedido.
import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CONSENT_COOKIE, CONSENT_MAX_AGE, hasAdTracking, type AdTrackingIds, type ConsentChoice } from "@/lib/ad-tracking";

export type AdStage =
  | { kind: "view"; eventId: string; valueCents: number | null }
  | { kind: "checkout"; eventId: string; valueCents: number }
  | { kind: "purchase"; eventId: string; orderId: string; publicCode: string; valueCents: number };

type Fn = ((...args: unknown[]) => void) & Record<string, unknown>;
declare global {
  interface Window {
    fbq?: Fn;
    _fbq?: Fn;
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

export function readConsent(cookie = typeof document === "undefined" ? "" : document.cookie): ConsentChoice | null {
  const v = cookie.split("; ").find((c) => c.startsWith(`${CONSENT_COOKIE}=`))?.split("=")[1];
  return v === "aceito" || v === "recusado" ? v : null;
}

const CONSENT_EVENT = "eb-consent";

function writeConsent(choice: ConsentChoice) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CONSENT_COOKIE}=${choice}; Path=/; Max-Age=${CONSENT_MAX_AGE}; SameSite=Lax${secure}`;
  window.dispatchEvent(new Event(CONSENT_EVENT));
}

const subscribe = (cb: () => void) => {
  window.addEventListener(CONSENT_EVENT, cb);
  return () => window.removeEventListener(CONSENT_EVENT, cb);
};
// No servidor (e na hidratação) a escolha é desconhecida: nem aviso nem medição.
const useConsent = () => useSyncExternalStore<ConsentChoice | null | "desconhecido">(subscribe, () => readConsent(), () => "desconhecido");

function inject(src: string) {
  if (document.querySelector(`script[src="${src}"]`)) return;
  const s = document.createElement("script");
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

const metaInit = new Set<string>();
const googleInit = new Set<string>();

/** Carrega os scripts (uma vez por página) e registra cada ID uma vez. */
export function loadTrackers(ids: AdTrackingIds) {
  if (ids.metaPixelId) {
    if (!window.fbq) {
      // Mesmo efeito do snippet oficial do Meta, sem script inline (CSP).
      const q: unknown[][] = [];
      const fbq = ((...args: unknown[]) => {
        if (typeof fbq.callMethod === "function") (fbq.callMethod as (...a: unknown[]) => void)(...args);
        else q.push(args);
      }) as Fn;
      Object.assign(fbq, { push: fbq, loaded: true, version: "2.0", queue: q });
      window.fbq = window._fbq = fbq;
      inject("https://connect.facebook.net/en_US/fbevents.js");
    }
    if (!metaInit.has(ids.metaPixelId)) {
      metaInit.add(ids.metaPixelId);
      window.fbq("init", ids.metaPixelId);
    }
  }
  const google = [ids.ga4MeasurementId, ids.googleAdsTag?.split("/")[0]].filter((v): v is string => !!v);
  if (google.length) {
    if (!window.gtag) {
      window.dataLayer = window.dataLayer ?? [];
      // gtag espera o objeto `arguments`, não um array.
      window.gtag = function gtag() {
        // eslint-disable-next-line prefer-rest-params
        window.dataLayer!.push(arguments);
      };
      window.gtag("js", new Date());
      inject(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(google[0])}`);
    }
    for (const id of google)
      if (!googleInit.has(id)) {
        googleInit.add(id);
        window.gtag("config", id);
      }
  }
}

/** Dispara o evento da etapa. A compra conta uma vez por pedido neste navegador. */
export function fireStage(ids: AdTrackingIds, stage: AdStage, storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()) {
  const value = stage.valueCents == null ? undefined : stage.valueCents / 100;
  const base = { currency: "BRL", value };
  const items = [{ item_id: stage.eventId }];
  if (stage.kind === "purchase") {
    const key = `eb_px_compra_${stage.orderId}`;
    if (storage?.getItem(key)) return false;
    storage?.setItem(key, "1");
  }
  const fbq = ids.metaPixelId ? window.fbq : undefined;
  const gtag = ids.ga4MeasurementId || ids.googleAdsTag ? window.gtag : undefined;
  if (stage.kind === "view") {
    fbq?.("track", "PageView");
    fbq?.("track", "ViewContent", { ...base, content_ids: [stage.eventId], content_type: "product" });
    gtag?.("event", "view_item", { ...base, items });
  } else if (stage.kind === "checkout") {
    fbq?.("track", "PageView");
    fbq?.("track", "InitiateCheckout", { ...base, content_ids: [stage.eventId], content_type: "product" });
    gtag?.("event", "begin_checkout", { ...base, items });
  } else {
    fbq?.("track", "PageView");
    // eventID: o Meta descarta repetições do mesmo pedido.
    fbq?.("track", "Purchase", { ...base, content_ids: [stage.eventId], content_type: "product" }, { eventID: stage.orderId });
    gtag?.("event", "purchase", { ...base, transaction_id: stage.publicCode, items });
    if (ids.googleAdsTag?.includes("/")) gtag?.("event", "conversion", { ...base, send_to: ids.googleAdsTag, transaction_id: stage.publicCode });
  }
  return true;
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Aviso de consentimento + medição da etapa. Só é renderizado em evento com algum ID configurado. */
export function AdTracking({ ids, stage }: { ids: AdTrackingIds; stage: AdStage }) {
  const consent = useConsent();
  useEffect(() => {
    if (consent !== "aceito" || !hasAdTracking(ids)) return;
    loadTrackers(ids);
    fireStage(ids, stage);
    // O estágio é fixo por página; o id do evento/pedido identifica a medição.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consent, ids.metaPixelId, ids.ga4MeasurementId, ids.googleAdsTag, stage.kind, stage.eventId]);
  if (consent !== null || !hasAdTracking(ids)) return null;
  const choose = (c: ConsentChoice) => writeConsent(c);
  return (
    <div role="region" aria-label="Aviso de cookies" className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4" data-testid="consent-banner">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-lg sm:flex-row sm:items-center">
        <p className="text-sm">
          O organizador deste evento usa ferramentas de medição de anúncios (Meta e Google), que gravam cookies no seu navegador. Elas não recebem seu nome,
          e-mail ou CPF.{" "}
          <Link href="/privacidade" className="font-semibold text-secondary underline">
            Saiba mais
          </Link>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => choose("recusado")}>
            Recusar
          </Button>
          <Button type="button" size="sm" onClick={() => choose("aceito")}>
            Aceitar
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Rodapé: apaga a escolha e recarrega, para o aviso aparecer de novo. */
export function ConsentPreferencesButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        document.cookie = `${CONSENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
        location.reload();
      }}
    >
      Preferências de cookies
    </button>
  );
}
