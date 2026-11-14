// ⚠️ PROVEDOR SIMULADO — SOMENTE DESENVOLVIMENTO E TESTES.
// Mantém um "lado do provedor" próprio (SimulatedProviderPayment) e emite
// webhooks assinados com HMAC que percorrem exatamente o mesmo caminho de
// verificação → consulta → confirmação do provedor real.
// Nada aqui movimenta dinheiro.
import "server-only";
import { createHmac } from "node:crypto";
import type { Db } from "../db";
import { safeEqual, randomToken } from "../crypto";
import type {
  CreatePaymentInput,
  CreatedPayment,
  PaymentProviderAdapter,
  ProviderPaymentSnapshot,
  ProviderPaymentStatus,
  RefundResult,
  WebhookRequest,
  WebhookVerification,
} from "./types";

const SIGNATURE_HEADER = "x-eb-simulated-signature";
const TOLERANCE_S = 300;

const stateToStatus: Record<string, ProviderPaymentStatus> = {
  PENDING: "PENDING",
  APPROVED: "PAID",
  REJECTED: "FAILED",
  EXPIRED: "EXPIRED",
  REFUNDED: "REFUNDED",
  CHARGED_BACK: "CHARGED_BACK",
};

export type SimulatedAction = "approve" | "reject" | "expire" | "chargeback";

export class SimulatedPaymentAdapter implements PaymentProviderAdapter {
  readonly id = "simulated";
  readonly isSimulated = true;
  readonly supportedMethods = ["PIX", "CREDIT_CARD"] as const;

  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    // Idempotência do lado do "provedor".
    const existing = await this.db.simulatedProviderPayment.findFirst({ where: { externalRef: input.idempotencyKey } });
    const row =
      existing ??
      (await this.db.simulatedProviderPayment.create({
        data: { externalRef: input.idempotencyKey, method: input.method, amountCents: input.amountCents, expiresAt: input.expiresAt },
      }));
    if (input.method === "CREDIT_CARD" && input.simulatedCardOutcome && row.state === "PENDING") {
      const state = input.simulatedCardOutcome === "approve" ? "APPROVED" : "REJECTED";
      await this.db.simulatedProviderPayment.update({ where: { id: row.id }, data: { state } });
      return { providerPaymentId: row.id, status: stateToStatus[state], rawStatus: state };
    }
    return {
      providerPaymentId: row.id,
      status: stateToStatus[row.state],
      rawStatus: row.state,
      pixCopyPaste: input.method === "PIX" ? `SIMULADO-NAO-PAGUE-${row.id}` : undefined,
      expiresAt: row.expiresAt,
    };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPaymentSnapshot> {
    const row = await this.db.simulatedProviderPayment.findUniqueOrThrow({ where: { id: providerPaymentId } });
    // Expiração automática do PIX simulado.
    const state = row.state === "PENDING" && row.expiresAt < new Date() ? "EXPIRED" : row.state;
    return {
      providerPaymentId: row.id,
      externalReference: row.externalRef,
      status: stateToStatus[state],
      rawStatus: state,
      amountCents: row.amountCents,
      // O simulado não cobra taxa de processamento.
      processingFeeCents: 0,
      refundedCents: row.refundedCents,
      pixCopyPaste: row.method === "PIX" ? `SIMULADO-NAO-PAGUE-${row.id}` : undefined,
      expiresAt: row.expiresAt,
    };
  }

  async findPaymentByReference(idempotencyKey: string): Promise<ProviderPaymentSnapshot | null> {
    const row = await this.db.simulatedProviderPayment.findFirst({ where: { externalRef: idempotencyKey } });
    return row ? this.getPayment(row.id) : null;
  }

  async refundPayment(input: { providerPaymentId: string; amountCents: number; idempotencyKey: string }): Promise<RefundResult> {
    const row = await this.db.simulatedProviderPayment.findUniqueOrThrow({ where: { id: input.providerPaymentId } });
    const refundId = `sim-refund-${row.id}-${row.refundKeys.length + 1}`;
    // Mesma chave de idempotência: o estorno já foi aplicado.
    if (row.refundKeys.includes(input.idempotencyKey)) return { providerRefundId: `sim-refund-${row.id}-${row.refundKeys.indexOf(input.idempotencyKey) + 1}`, status: "SUCCEEDED" };
    // Estorno integral anterior a este controle (sem chaves registradas).
    if (row.state === "REFUNDED" && !row.refundKeys.length) return { providerRefundId: `sim-refund-${row.id}`, status: "SUCCEEDED" };
    // Aceita estornos parciais (como o Mercado Pago) até o valor pago.
    if (row.state !== "APPROVED" || input.amountCents <= 0 || row.refundedCents + input.amountCents > row.amountCents) {
      return { providerRefundId: refundId, status: "FAILED" };
    }
    const refundedCents = row.refundedCents + input.amountCents;
    const full = refundedCents === row.amountCents;
    await this.db.simulatedProviderPayment.update({
      where: { id: row.id },
      data: { refundedCents, refundKeys: { push: input.idempotencyKey }, ...(full ? { state: "REFUNDED", refundedAt: new Date() } : {}) },
    });
    return { providerRefundId: refundId, status: "SUCCEEDED" };
  }

  async verifyWebhook(req: WebhookRequest): Promise<WebhookVerification> {
    const header = req.headers.get(SIGNATURE_HEADER);
    if (!header) return { valid: false, reason: "assinatura ausente" };
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=") as [string, string]));
    const ts = Number(parts.t);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) return { valid: false, reason: "timestamp fora da tolerância" };
    const expected = createHmac("sha256", this.secret).update(`${ts}.${req.rawBody}`).digest("hex");
    if (!parts.v1 || !safeEqual(parts.v1, expected)) return { valid: false, reason: "assinatura inválida" };
    let payload: { id?: string; type?: string; data?: { id?: string } };
    try {
      payload = JSON.parse(req.rawBody);
    } catch {
      return { valid: false, reason: "corpo inválido" };
    }
    if (!payload.id || !payload.type) return { valid: false, reason: "evento incompleto" };
    return { valid: true, externalEventId: payload.id, eventType: payload.type, providerPaymentId: payload.data?.id ?? null, payload };
  }

  // ── Ferramentas do simulador (não fazem parte do contrato do provedor) ──

  /** Altera o estado no "provedor" e devolve o webhook assinado correspondente. */
  async simulate(providerPaymentId: string, action: SimulatedAction): Promise<WebhookRequest> {
    const next = { approve: "APPROVED", reject: "REJECTED", expire: "EXPIRED", chargeback: "CHARGED_BACK" } as const;
    await this.db.simulatedProviderPayment.update({ where: { id: providerPaymentId }, data: { state: next[action] } });
    return this.buildWebhook(providerPaymentId);
  }

  buildWebhook(providerPaymentId: string, eventId = `sim-evt-${randomToken(9)}`, appUrl = "http://localhost"): WebhookRequest {
    const rawBody = JSON.stringify({ id: eventId, type: "payment.updated", data: { id: providerPaymentId } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", this.secret).update(`${ts}.${rawBody}`).digest("hex");
    return {
      headers: new Headers({ "content-type": "application/json", [SIGNATURE_HEADER]: `t=${ts},v1=${sig}` }),
      rawBody,
      url: new URL("/api/webhooks/simulated", appUrl),
    };
  }
}
