"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { disconnectMercadoPagoAction } from "./actions";

/**
 * Configurações: desconecta a conta Mercado Pago da organização. Mostra antes o que muda e,
 * se houver dinheiro em andamento que depende da conta, os impedimentos (o servidor decide).
 */
export function MercadoPagoDisconnectPanel({ blockers, needsPassword }: { blockers: string[]; needsPassword: boolean }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="mp-disconnect">
      <h3 className="font-semibold">Desconectar Mercado Pago</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>A venda de ingressos pagos para na hora em todos os eventos: o checkout recusa a compra e nada é cobrado em outra conta. Ingressos gratuitos continuam.</li>
        <li>Vendas já pagas continuam válidas, mas reembolsos e estornos delas só podem ser feitos reconectando <strong>a mesma conta</strong> Mercado Pago. Outra conta não reembolsa vendas antigas.</li>
        <li>Para voltar a vender, conecte de novo (a mesma ou outra conta).</li>
        <li>O TICKET24 apaga os tokens de acesso guardados. Para retirar também a permissão do lado do Mercado Pago, remova o TICKET24 dos aplicativos conectados na sua conta Mercado Pago.</li>
      </ul>

      {blockers.length > 0 ? (
        <Alert variant="warning" data-testid="mp-disconnect-blockers">
          <p className="font-semibold">Ainda não dá para desconectar:</p>
          <ul className="list-disc pl-4">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Alert>
      ) : !open ? (
        <Button type="button" variant="outline" size="sm" onClick={() => { setOpen(true); setMsg(null); }}>
          Desconectar conta Mercado Pago
        </Button>
      ) : (
        <form
          className="space-y-3 rounded-2xl border border-destructive/50 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setMsg(null);
            start(async () => {
              const r = await disconnectMercadoPagoAction(password);
              setPassword("");
              if (r.ok) {
                setOpen(false);
                setUnderstood(false);
                setMsg({ ok: true, text: "Conta Mercado Pago desconectada. A venda de ingressos pagos está pausada até uma nova conexão." });
              } else setMsg({ ok: false, text: r.error });
            });
          }}
        >
          <p className="text-sm font-semibold">Desconectar a conta Mercado Pago desta organização?</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} disabled={busy} />
            <span>Entendo que a venda de ingressos pagos para e que reembolsos de vendas antigas exigem reconectar a mesma conta.</span>
          </label>
          <div className="space-y-1">
            <Label htmlFor="mp-disconnect-password">{needsPassword ? "Sua senha, para confirmar" : "Sua senha (opcional: conta Google)"}</Label>
            <Input id="mp-disconnect-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required={needsPassword} disabled={busy} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" size="sm" disabled={busy || !understood}>
              {busy ? "Desconectando…" : "Desconectar"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Voltar
            </Button>
          </div>
        </form>
      )}

      {msg && (
        <p role="status" className={msg.ok ? "whitespace-pre-line text-sm text-success" : "whitespace-pre-line text-sm text-destructive"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
