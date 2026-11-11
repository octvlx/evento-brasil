"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { clearOfflineCheckinData, forgetOfflineEvent, hasOfflineCheckinData } from "./offline-store";

/**
 * Página carregada sem sessão (expirou, ou saiu por outro caminho, ex.: "sair de todos os
 * dispositivos"): apaga do aparelho a lista offline com nomes de titulares e a cópia do
 * leitor. Leituras ainda não enviadas ficam guardadas até alguém da equipe entrar de novo.
 */
export function ClearOfflineCheckinWhenSignedOut() {
  useEffect(() => {
    void hasOfflineCheckinData().then((has) => (has ? clearOfflineCheckinData({ keepPendingQueues: true }) : undefined));
  }, []);
  return null;
}

/** Leitor de um evento sem acesso (ou inexistente): esquece esse evento neste aparelho. */
export function ForgetOfflineCheckinEvent() {
  const { eventId } = useParams<{ eventId: string }>();
  useEffect(() => {
    if (eventId) void forgetOfflineEvent(eventId);
  }, [eventId]);
  return null;
}
