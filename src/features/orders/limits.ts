// Limites contra compras abusivas (Decreto 13.108, R4; tarefa L4a).
// Contam toda chamada de criação de pedido e de início de pagamento, por
// conta e por cliente (IP), com janela fixa. Valores e justificativa em
// docs/areas/financeiro.md ("Limites de pedido e pagamento").
import "server-only";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";

const TEN_MINUTES = 10 * 60_000;

export const ORDER_RATE_LIMITS = {
  createOrder: {
    perUser: { limit: 10, windowMs: TEN_MINUTES },
    perClient: { limit: 30, windowMs: TEN_MINUTES },
    message: "Você criou muitos pedidos em pouco tempo. Aguarde alguns minutos e tente novamente.",
  },
  startPayment: {
    perUser: { limit: 15, windowMs: TEN_MINUTES },
    perClient: { limit: 40, windowMs: TEN_MINUTES },
    message: "Muitas tentativas de pagamento em pouco tempo. Aguarde alguns minutos e tente novamente.",
  },
} as const;

type LimitedAction = keyof typeof ORDER_RATE_LIMITS;

async function enforce(action: LimitedAction, userId: string, clientKey: string) {
  const cfg = ORDER_RATE_LIMITS[action];
  try {
    await rateLimit(`${action}:user:${userId}`, cfg.perUser.limit, cfg.perUser.windowMs);
    await rateLimit(`${action}:client:${clientKey}`, cfg.perClient.limit, cfg.perClient.windowMs);
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") throw new AppError("RATE_LIMITED", cfg.message);
    throw err;
  }
}

export async function assertCanCreateOrder(userId: string, clientKey: string) {
  await enforce("createOrder", userId, clientKey);
}

export async function assertCanStartPayment(userId: string, clientKey: string) {
  await enforce("startPayment", userId, clientKey);
}
