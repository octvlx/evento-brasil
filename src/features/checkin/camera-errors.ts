// Mensagens do leitor de QR para cada falha da câmera: a portaria precisa saber o que
// fazer (liberar a permissão, fechar outro app, usar HTTPS) em vez de um erro genérico.
// Em qualquer caso a digitação manual do código continua disponível.

export type CameraProblem = "INSECURE" | "UNSUPPORTED" | "DENIED" | "NOT_FOUND" | "IN_USE" | "ENDED" | "UNKNOWN";

export const CAMERA_MESSAGES: Record<CameraProblem, string> = {
  INSECURE: "A câmera só funciona em página segura (endereço com https). Abra o leitor pelo endereço oficial do site ou digite o código do ingresso abaixo.",
  UNSUPPORTED: "Este navegador não dá acesso à câmera. Use o Chrome ou o Safari atualizados, ou digite o código do ingresso abaixo.",
  DENIED:
    "A permissão da câmera foi negada. Toque no cadeado ao lado do endereço, permita a câmera para este site e toque em “Ativar câmera” de novo. Enquanto isso, digite o código do ingresso abaixo.",
  NOT_FOUND: "Nenhuma câmera foi encontrada neste aparelho. Digite o código do ingresso abaixo.",
  IN_USE: "A câmera está sendo usada por outro aplicativo. Feche o outro app (videochamada, câmera) e toque em “Ativar câmera” de novo.",
  ENDED: "A câmera foi desligada (aparelho bloqueado, outro app ou cabo desconectado). Toque em “Ativar câmera” para voltar a ler.",
  UNKNOWN: "Não foi possível acessar a câmera. Verifique a permissão do navegador ou digite o código do ingresso abaixo.",
};

/** Antes de pedir a câmera: o navegador permite? (fora de HTTPS `mediaDevices` nem existe). */
export function cameraPrecheck(env: { isSecureContext?: boolean; hasGetUserMedia: boolean }): CameraProblem | null {
  if (env.isSecureContext === false) return "INSECURE";
  if (!env.hasGetUserMedia) return "UNSUPPORTED";
  return null;
}

/** Classifica o erro de `getUserMedia`/`play` pelo nome (DOMException). */
export function cameraProblemOf(err: unknown): CameraProblem {
  const name = typeof err === "object" && err && "name" in err ? String((err as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "DENIED";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "NOT_FOUND";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "IN_USE";
    default:
      return "UNKNOWN";
  }
}
