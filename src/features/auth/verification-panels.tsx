"use client";
import Link from "next/link";
import { useState, useTransition, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import {
  confirmEmailAction,
  resendEmailConfirmationAction,
  googleSignupAction,
} from "./actions";

export function GoogleAuthLink({
  enabled,
  next,
}: {
  enabled: boolean;
  next?: string;
}) {
  return enabled ? (
    <Link
      prefetch={false}
      href={`/auth/google?next=${encodeURIComponent(next ?? "/")}`}
      className="block rounded-xl border border-border p-3 text-center text-sm font-semibold"
    >
      Continuar com Google
    </Link>
  ) : (
    <Button type="button" variant="outline" className="w-full" disabled>
      Google indisponível no momento
    </Button>
  );
}

function subscribeHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}
export function EmailConfirmationPanel({
  next,
  email,
  emailVerified,
}: {
  next: string;
  email: string | null;
  emailVerified: boolean;
}) {
  const fragment = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
  const token = new URLSearchParams(fragment.slice(1)).get("token");
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const alreadyVerified = confirmed || (emailVerified && !token);
  const router = useRouter();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {alreadyVerified
          ? "Seu e-mail está confirmado."
          : token
            ? "Confirme o e-mail associado ao link recebido. Essa confirmação não troca a conta conectada."
            : email
              ? `Confirme o acesso a ${email} para continuar sua compra. Seu carrinho permanece salvo.`
              : "Confirme seu e-mail pelo link recebido. Depois, entre na sua conta para continuar."}
      </p>
      {token && !alreadyVerified && (
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError("");
              const result = await confirmEmailAction(token);
              if (result.ok) {
                setConfirmed(true);
                setMessage("E-mail confirmado com sucesso.");
                window.history.replaceState(
                  null,
                  "",
                  window.location.pathname + window.location.search,
                );
                router.refresh();
              } else setError(result.error);
            })
          }
        >
          Confirmar meu e-mail
        </Button>
      )}
      {email && !alreadyVerified && (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError("");
              const result = await resendEmailConfirmationAction(next);
              if (result.ok)
                setMessage(
                  "Se este endereço estiver associado a uma conta que precisa de confirmação, enviaremos um novo link. Confira também a caixa de spam.",
                );
              else setError(result.error);
            })
          }
        >
          Reenviar e-mail de confirmação
        </Button>
      )}
      {error && (
        <div role="alert">
          <Alert variant="danger">{error}</Alert>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <a
        href={email ? next : `/entrar?next=${encodeURIComponent(next)}`}
        className="block font-semibold text-secondary underline"
      >
        {email ? "Voltar e continuar" : "Entrar e continuar"}
      </a>
    </div>
  );
}

export function GoogleSignupConsent({
  name,
  email,
}: {
  name: string;
  email: string;
}) {
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        start(async () => {
          setError("");
          const result = await googleSignupAction(terms, privacy);
          if (result.ok) {
            window.location.assign(result.data.redirectTo);
          } else setError(result.error);
        });
      }}
    >
      <p className="text-sm">
        Criar conta para {name} ({email}). Seu e-mail já foi confirmado pelo
        Google.
      </p>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={terms}
          onChange={(e) => setTerms(e.target.checked)}
        />{" "}
        <span>
          Li e aceito os{" "}
          <Link href="/termos" target="_blank" className="underline">
            termos de uso
          </Link>
          .
        </span>
      </label>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={privacy}
          onChange={(e) => setPrivacy(e.target.checked)}
        />{" "}
        <span>
          Li e estou ciente da{" "}
          <Link href="/privacidade" target="_blank" className="underline">
            política de privacidade
          </Link>
          .
        </span>
      </label>
      {error && (
        <div role="alert">
          <Alert variant="danger">{error}</Alert>
        </div>
      )}
      <Button className="w-full" disabled={pending || !terms || !privacy}>
        {pending ? "Criando conta…" : "Criar conta com Google"}
      </Button>
    </form>
  );
}
