// Alteração relevante de evento com vendas (R8, Decreto 13.108/2026).
// Compartilhado entre o formulário (mostrar o campo "motivo") e o servidor (que decide).
//
// PADRÕES PROVISÓRIOS — decisão jurídica D2 em aberto (docs/conformidade-decreto-13108.md):
// o que conta como alteração relevante e quanto dura a janela de reembolso integral.
// Ajustar aqui quando a assessoria decidir; os testes em
// tests/integration/z-event-relevant-change.test.ts citam estas constantes.

import { formatDateTimeShort } from "@/lib/datetime";

/** Mudança mínima do início, em minutos, para ser relevante. 0 = qualquer mudança (D2 provisório). */
export const RELEVANT_START_SHIFT_MINUTES = 0;

/** Janela de reembolso integral após a alteração, em dias, limitada ao novo início (D2 provisório). */
export const REFUND_WINDOW_DAYS_AFTER_CHANGE = 30;

export const CHANGE_REASON_MIN = 10;
export const CHANGE_REASON_MAX = 2000;

/** Mensagem do servidor quando falta o motivo; o formulário a usa para mostrar o campo. */
export const CHANGE_REASON_REQUIRED = "Informe o motivo da alteração: ele será enviado aos compradores junto com o prazo de reembolso.";

export type RelevantField = "startsAt" | "venue" | "city" | "locationType";

export const RELEVANT_FIELD_LABELS: Record<RelevantField, string> = {
  startsAt: "Data e horário de início",
  venue: "Local",
  city: "Cidade",
  locationType: "Formato (presencial/online)",
};

export interface LocationSnapshot {
  startsAt: Date;
  locationType: "VENUE" | "ONLINE";
  venueId: string | null;
  cityId: string | null;
}

/** Campos relevantes que mudaram entre o estado atual e o novo (vazio = edição comum). */
export function relevantChangedFields(before: LocationSnapshot, after: LocationSnapshot): RelevantField[] {
  const fields: RelevantField[] = [];
  if (Math.abs(after.startsAt.getTime() - before.startsAt.getTime()) > RELEVANT_START_SHIFT_MINUTES * 60_000) fields.push("startsAt");
  if (before.venueId !== after.venueId) fields.push("venue");
  if (before.cityId !== after.cityId) fields.push("city");
  if (before.locationType !== after.locationType) fields.push("locationType");
  return fields;
}

/** Fim da janela de reembolso: N dias após a alteração, mas nunca depois do novo início. */
export function refundUntilFor(changedAt: Date, newStartsAt: Date): Date {
  const byDays = new Date(changedAt.getTime() + REFUND_WINDOW_DAYS_AFTER_CHANGE * 86_400_000);
  return byDays < newStartsAt ? byDays : newStartsAt;
}

/** Retrato gravado em `EventChange.before/after` (ver event-changes.ts). */
export interface ChangeSnapshotJson {
  startsAt?: string;
  locationType?: string;
  venueName?: string | null;
  cityName?: string | null;
  refundUntil?: string;
}

/** Texto de um campo do retrato, para e-mail e histórico (horário no fuso do evento). */
export function describeChangeValue(field: RelevantField, snap: ChangeSnapshotJson, timeZone: string): string {
  switch (field) {
    case "startsAt":
      return snap.startsAt ? formatDateTimeShort(new Date(snap.startsAt), timeZone) : "—";
    case "venue":
      return snap.locationType === "ONLINE" ? "Online" : (snap.venueName ?? "—");
    case "city":
      return snap.cityName ?? "—";
    case "locationType":
      return snap.locationType === "ONLINE" ? "Online" : "Presencial";
  }
}

export function isRelevantField(f: string): f is RelevantField {
  return f in RELEVANT_FIELD_LABELS;
}
