"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { acceptInvitationAction, declineInvitationAction } from "./actions";

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  if (declined) return <Alert variant="success">Convite recusado. Quem convidou não poderá mais usar este link.</Alert>;
  return (
    <>
      <Button
        size="lg"
        className="w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await acceptInvitationAction(token);
            if (r.ok) router.push("/check-in");
            else setError(r.error);
          })
        }
      >
        {pending ? "Aguarde…" : "Aceitar convite"}
      </Button>
      <Button
        variant="ghost"
        className="w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await declineInvitationAction(token);
            if (r.ok) setDeclined(true);
            else setError(r.error);
          })
        }
      >
        Recusar convite
      </Button>
      {error && <Alert variant="danger">{error}</Alert>}
    </>
  );
}
