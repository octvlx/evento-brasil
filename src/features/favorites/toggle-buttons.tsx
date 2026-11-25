"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Heart, UserCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/errors";
import { setEventFavoriteAction, setOrganizerFollowAction } from "./actions";

type Props = { id: string; initial: boolean; loggedIn: boolean };

function useToggle({ id, initial, loggedIn }: Props, action: (raw: { id: string; on: boolean }) => Promise<ActionResult<unknown>>) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const pathname = usePathname();
  const toLogin = () => router.push(`/entrar?next=${encodeURIComponent(pathname)}`);
  const toggle = () => {
    if (!loggedIn) return toLogin();
    const next = !on;
    setOn(next); // otimista; volta se o servidor recusar
    setError(null);
    start(async () => {
      const res = await action({ id, on: next });
      if (res.ok) return;
      setOn(!next);
      if (res.code === "UNAUTHENTICATED") toLogin();
      else setError(res.error);
    });
  };
  return { on, error, pending, toggle };
}

export function FavoriteEventButton(props: Props) {
  const { on, error, pending, toggle } = useToggle(props, setEventFavoriteAction);
  return (
    <span className="inline-flex flex-col">
      <Button type="button" variant="outline" onClick={toggle} disabled={pending} aria-pressed={on} data-testid="favorite-event">
        <Heart aria-hidden className={on ? "fill-current text-red-600" : undefined} /> {on ? "Salvo nos favoritos" : "Salvar nos favoritos"}
      </Button>
      {error && <span role="alert" className="mt-1 text-xs text-destructive">{error}</span>}
    </span>
  );
}

export function FollowOrganizerButton(props: Props) {
  const { on, error, pending, toggle } = useToggle(props, setOrganizerFollowAction);
  return (
    <span className="inline-flex flex-col">
      <Button type="button" variant={on ? "outline" : "default"} size="sm" onClick={toggle} disabled={pending} aria-pressed={on} data-testid="follow-organizer">
        {on ? <UserCheck aria-hidden /> : <UserPlus aria-hidden />} {on ? "Seguindo" : "Seguir"}
      </Button>
      {error && <span role="alert" className="mt-1 text-xs text-destructive">{error}</span>}
    </span>
  );
}
