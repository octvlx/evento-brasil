// Sem "server-only": o formulário público e o painel usam os mesmos rótulos.
export const EVENT_REPORT_REASONS = {
  FRAUD: "Golpe ou fraude",
  MISLEADING: "Informações falsas ou enganosas",
  INAPPROPRIATE: "Conteúdo impróprio ou ofensivo",
  RIGHTS_VIOLATION: "Uso indevido de marca, imagem ou direitos autorais",
  OTHER: "Outro motivo",
} as const;

export type EventReportReasonKey = keyof typeof EVENT_REPORT_REASONS;
