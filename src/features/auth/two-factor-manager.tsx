"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import {
  confirmTotpEnrollmentAction,
  disableTotpAction,
  regenerateRecoveryCodesAction,
  startTotpEnrollmentAction,
} from "./two-factor-actions";

export interface TwoFactorView {
  enabled: boolean;
  enabledAtLabel: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
  privileged: boolean;
  hasPassword: boolean;
}

function CodeInput({ id, value, onChange, label = "Código de 6 dígitos" }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d ]/g, "").slice(0, 7))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        required
        className="mt-1.5 max-w-48 text-center font-mono text-lg tracking-widest"
      />
    </div>
  );
}

/** Mostra os códigos de recuperação uma única vez, com cópia e download. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `QQPega — códigos de recuperação da verificação em duas etapas\nCada código vale uma única vez.\n\n${codes.join("\n")}\n`;
  return (
    <div className="space-y-4" data-testid="recovery-codes">
      <Alert variant="warning">
        Guarde estes códigos num lugar seguro (gerenciador de senhas ou papel). Eles permitem entrar se você perder o celular e <strong>não serão mostrados de novo</strong>.
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-4 font-mono text-sm sm:grid-cols-3" aria-label="Códigos de recuperação">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard?.writeText(text).catch(() => {});
            setCopied(true);
          }}
        >
          {copied ? "Copiados" : "Copiar códigos"}
        </Button>
        <a
          className="inline-flex h-10 items-center rounded-full border px-4 text-sm font-semibold"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
          download="evento-brasil-codigos-de-recuperacao.txt"
        >
          Baixar .txt
        </a>
        <Button type="button" onClick={onDone}>
          Já guardei os códigos
        </Button>
      </div>
    </div>
  );
}

export function TwoFactorManager({ view }: { view: TwoFactorView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"idle" | "regenerate" | "disable">("idle");

  const run = (fn: () => Promise<void>) => {
    setError(null);
    startTransition(fn);
  };
  const finish = () => {
    setCodes(null);
    setSetup(null);
    setMode("idle");
    setCode("");
    setPassword("");
    router.refresh();
  };

  if (codes) return <RecoveryCodes codes={codes} onDone={finish} />;

  if (!view.enabled) {
    if (!setup)
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Além da senha, o login pede um código que muda a cada 30 segundos no seu celular (Google Authenticator, Microsoft Authenticator, 1Password, Authy ou similar).
          </p>
          {error && <Alert variant="danger">{error}</Alert>}
          <Button
            disabled={pending}
            onClick={() =>
              run(async () => {
                const r = await startTotpEnrollmentAction();
                if (r.ok) setSetup(r.data);
                else setError(r.error);
              })
            }
          >
            {pending ? "Preparando…" : "Ativar verificação em duas etapas"}
          </Button>
        </div>
      );
    return (
      <form
        className="space-y-4"
        aria-busy={pending}
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await confirmTotpEnrollmentAction(code);
            if (r.ok) setCodes(r.data.recoveryCodes);
            else setError(r.error);
          });
        }}
      >
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            No aplicativo autenticador, escolha adicionar conta e escaneie o QR code.
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL gerada no servidor */}
            <img src={setup.qrDataUrl} alt="QR code para configurar o aplicativo autenticador" width={220} height={220} className="mt-3 rounded-xl border bg-white p-2" />
          </li>
          <li>
            Sem câmera? Digite esta chave no aplicativo:
            <code className="mt-1 block break-all rounded-lg bg-muted px-3 py-2 font-mono text-sm" data-testid="totp-secret">
              {setup.secret.match(/.{1,4}/g)?.join(" ")}
            </code>
          </li>
          <li>Digite o código de 6 dígitos que o aplicativo mostrar.</li>
        </ol>
        <CodeInput id="totp-confirm" value={code} onChange={setCode} />
        {error && <Alert variant="danger">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending || code.replace(/\s/g, "").length !== 6}>{pending ? "Confirmando…" : "Confirmar e ativar"}</Button>
          <Button type="button" variant="outline" onClick={finish} disabled={pending}>
            Cancelar
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <Alert variant="success">
        Verificação em duas etapas ativa{view.enabledAtLabel ? ` desde ${view.enabledAtLabel}` : ""}. Códigos de recuperação restantes: {view.recoveryCodesRemaining}.
      </Alert>
      {view.recoveryCodesRemaining <= 2 && <Alert variant="warning">Restam poucos códigos de recuperação. Gere novos para não ficar sem acesso.</Alert>}
      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setMode("regenerate")}>
            Gerar novos códigos de recuperação
          </Button>
          {!view.required && (
            <Button variant="outline" onClick={() => setMode("disable")}>
              Desativar
            </Button>
          )}
        </div>
      )}
      {view.required && mode === "idle" && (
        <p className="text-sm text-muted-foreground">Obrigatória para administradores e donos de organização: não pode ser desativada.</p>
      )}
      {mode !== "idle" && (
        <form
          className="space-y-4"
          aria-busy={pending}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (mode === "regenerate") {
                const r = await regenerateRecoveryCodesAction(code);
                if (r.ok) setCodes(r.data.recoveryCodes);
                else setError(r.error);
              } else {
                const r = await disableTotpAction({ code, password: password || undefined });
                if (r.ok) finish();
                else setError(r.error);
              }
            });
          }}
        >
          <p className="text-sm text-muted-foreground">
            {mode === "regenerate"
              ? "Os códigos atuais deixam de valer. Confirme com um código do aplicativo."
              : "Sem a verificação em duas etapas, só a senha protege sua conta."}
          </p>
          {mode === "disable" && view.hasPassword && (
            <div>
              <Label htmlFor="mfa-disable-password">Senha atual</Label>
              <Input id="mfa-disable-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1.5 max-w-sm" />
            </div>
          )}
          <CodeInput id="mfa-manage-code" value={code} onChange={setCode} />
          {error && <Alert variant="danger">{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button variant={mode === "disable" ? "destructive" : "default"} disabled={pending || code.replace(/\s/g, "").length !== 6}>
              {pending ? "Confirmando…" : mode === "regenerate" ? "Gerar novos códigos" : "Desativar verificação"}
            </Button>
            <Button type="button" variant="outline" onClick={finish} disabled={pending}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
