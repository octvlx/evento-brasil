"use client";

import { useId, useState, type ComponentProps } from "react";
import { Check, Circle, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { PASSWORD_MAX_LENGTH, PASSWORD_REQUIREMENTS, passwordStrength } from "@/lib/password-policy";

/** Campo de senha com botão de mostrar/ocultar acessível (teclado e leitor de tela). */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={cn("relative", className)}>
      <Input {...props} type={visible ? "text" : "password"} maxLength={props.maxLength ?? PASSWORD_MAX_LENGTH} className="pr-11" />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
        aria-pressed={visible}
        aria-controls={props.id}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-secondary"
      >
        {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}

const STRENGTH_STYLE = ["", "bg-destructive", "bg-warning", "bg-success"] as const;

/** Requisitos da política (atualizados enquanto digita) e força estimada localmente. */
export function PasswordChecklist({ password, id }: { password: string; id?: string }) {
  const fallbackId = useId();
  const strength = passwordStrength(password);
  return (
    <div id={id ?? fallbackId} className="mt-2 space-y-2 text-xs">
      <ul className="grid gap-1 sm:grid-cols-2" aria-label="Requisitos da senha">
        {PASSWORD_REQUIREMENTS.map((r) => {
          const ok = r.test(password);
          return (
            <li key={r.id} className={cn("flex items-center gap-1.5", ok ? "text-success" : "text-muted-foreground")}>
              {ok ? <Check className="size-3.5" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
              <span>
                {r.label}
                <span className="sr-only">{ok ? " — atendido" : " — pendente"}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {password && (
        <div className="flex items-center gap-2" aria-live="polite">
          <div className="flex h-1.5 flex-1 gap-1" aria-hidden>
            {[1, 2, 3].map((level) => (
              <span key={level} className={cn("flex-1 rounded-full", strength.level >= level ? STRENGTH_STYLE[strength.level] : "bg-muted")} />
            ))}
          </div>
          <span className="min-w-12 text-right font-semibold">
            <span className="sr-only">Força da senha: </span>
            {strength.label}
          </span>
        </div>
      )}
    </div>
  );
}
