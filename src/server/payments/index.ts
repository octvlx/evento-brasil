import "server-only";
import { db } from "../db";
import { env } from "../env";
import { MercadoPagoAdapter } from "./mercadopago";
import { SimulatedPaymentAdapter } from "./simulated";
import type { PaymentProviderAdapter } from "./types";

let adapter: PaymentProviderAdapter | undefined;

/** Adaptador configurado em PAYMENT_PROVIDER. */
export function getPaymentAdapter(): PaymentProviderAdapter {
  if (adapter) return adapter;
  const e = env();
  adapter =
    e.PAYMENT_PROVIDER === "mercadopago"
      ? new MercadoPagoAdapter(db, e.MERCADO_PAGO_WEBHOOK_SECRET)
      : new SimulatedPaymentAdapter(db, e.SIMULATED_WEBHOOK_SECRET);
  return adapter;
}

/** Adaptador para um webhook recebido em /api/webhooks/[provider]. */
export function getAdapterById(provider: string): PaymentProviderAdapter | null {
  const a = getPaymentAdapter();
  return a.id === provider ? a : null;
}

export function getSimulatedAdapter(): SimulatedPaymentAdapter | null {
  const a = getPaymentAdapter();
  return a instanceof SimulatedPaymentAdapter ? a : null;
}

export type { PaymentProviderAdapter } from "./types";
