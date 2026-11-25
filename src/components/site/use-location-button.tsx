"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { nearestCityAction } from "@/features/location/actions";

const MESSAGES = {
  unsupported: "Seu navegador não informa a localização. Escolha a cidade na busca.",
  denied: "Sem permissão para usar a localização. Libere nas configurações do navegador ou escolha a cidade na busca.",
  unavailable: "Não foi possível obter sua localização agora. Tente de novo ou escolha a cidade na busca.",
  far: "Ainda não há eventos perto de você. Escolha outra cidade na busca.",
  invalid: "Não foi possível obter sua localização agora. Tente de novo ou escolha a cidade na busca.",
} as const;

/**
 * Pede a posição ao navegador (só ao clicar) e troca a cidade de "Perto de você" pela
 * cidade com eventos mais próxima. Manda a posição arredondada (~1 km), sem guardá-la.
 */
export function UseLocationButton({ className }: { className?: string }) {
  const router = useRouter();
  const [locating, setLocating] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const busy = locating || pending;

  function locate() {
    setMessage(null);
    if (!("geolocation" in navigator)) return setMessage(MESSAGES.unsupported);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const round = (n: number) => Math.round(n * 100) / 100;
        // Distância só quando é outra cidade: o centro geográfico de municípios grandes fica
        // longe do centro urbano (no Rio, ~30 km), então valores baixos confundem.
        startTransition(async () => {
          const res = await nearestCityAction({ lat: round(pos.coords.latitude), lng: round(pos.coords.longitude) });
          if (!res.ok) return setMessage(MESSAGES[res.reason]);
          setMessage(`Mostrando eventos em ${res.name} – ${res.state}${res.km >= 50 ? `, a cerca de ${res.km} km de você` : ""}.`);
          router.refresh();
        });
      },
      (err) => {
        setLocating(false);
        setMessage(err.code === err.PERMISSION_DENIED ? MESSAGES.denied : MESSAGES.unavailable);
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 },
    );
  }

  return (
    <div className={className}>
      <Button type="button" variant="outline" size="sm" onClick={locate} disabled={busy} data-testid="use-location">
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <LocateFixed aria-hidden />}
        {busy ? "Localizando…" : "Usar minha localização"}
      </Button>
      <p role="status" aria-live="polite" className="mt-1.5 text-xs text-muted-foreground empty:hidden">
        {message}
      </p>
    </div>
  );
}
