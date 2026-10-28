"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { acceptTransferAction, declineTransferAction } from "./transfer-actions";

/** Aceitar ou recusar uma transferência recebida (página /transferencia/[token]). */
export function TransferResponse({ token, allowAccept = true }: { token: string; allowAccept?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (msg?.ok) return <Alert variant="success">{msg.text}</Alert>;
  return (
    <div className="space-y-3">
      {msg && <Alert variant="danger">{msg.text}</Alert>}
      <div className="flex flex-wrap gap-2">
        {allowAccept && <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await acceptTransferAction(token);
              if (r.ok) {
                setMsg({ ok: true, text: "Ingresso aceito! Ele já está no seu nome, com um novo QR code. Abrindo o ingresso…" });
                router.push(`/ingressos/${r.data.ticketCode}`);
              } else setMsg({ ok: false, text: r.error });
            })
          }
        >
          {pending ? "Processando…" : "Aceitar ingresso"}
        </Button>}
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await declineTransferAction(token);
              setMsg(r.ok ? { ok: true, text: "Transferência recusada. O ingresso continua com quem enviou." } : { ok: false, text: r.error });
            })
          }
        >
          Recusar
        </Button>
      </div>
    </div>
  );
}
