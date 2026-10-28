import Link from "next/link";

/** Aceite da versão vigente dos termos na compra (R10), exibido quando o servidor pede. */
export function TermsReaccept({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="space-y-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm" role="group" aria-labelledby="terms-reaccept-title">
      <p id="terms-reaccept-title" className="font-semibold">
        Atualizamos os termos de uso e a política de privacidade
      </p>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="acceptTerms" className="mt-0.5 size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>
          Li e aceito a versão atual dos{" "}
          <Link href="/termos" target="_blank" className="text-secondary underline">
            termos de uso
          </Link>{" "}
          e da{" "}
          <Link href="/privacidade" target="_blank" className="text-secondary underline">
            política de privacidade
          </Link>
          .
        </span>
      </label>
    </div>
  );
}
