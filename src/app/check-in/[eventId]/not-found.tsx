import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { ForgetOfflineCheckinEvent } from "@/features/checkin/offline-cleanup";

// Leitor de um evento que não existe ou a que a conta não tem (mais) acesso.
export default function CheckinNotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <ForgetOfflineCheckinEvent />
      <h1 className="font-display text-2xl font-bold">Leitor indisponível</h1>
      <p className="mt-2 text-muted-foreground">Este evento não existe ou sua conta não tem acesso ao check-in dele. A lista offline deste evento foi apagada deste aparelho.</p>
      <Link href="/check-in" className={buttonVariants({ variant: "accent", className: "mt-6" })}>
        Voltar aos eventos
      </Link>
    </div>
  );
}
