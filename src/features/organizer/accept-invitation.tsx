"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { acceptInvitationAction } from "./actions";

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
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
        {pending ? "Aceitando…" : "Aceitar convite"}
      </Button>
      {error && <Alert variant="danger">{error}</Alert>}
    </>
  );
}
