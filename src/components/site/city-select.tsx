"use client";

import { MapPin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

const COOKIE = "eb_city";

const noopSubscribe = () => () => {};

function readCookie(): string {
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
}

/** Seleção de cidade sem exigir geolocalização. A preferência fica num cookie não sensível. */
export function CitySelect({ cities, className, variant = "pill" }: { cities: { slug: string; label: string }[]; className?: string; variant?: "pill" | "hero" }) {
  const router = useRouter();
  // Cookie lido só no cliente; no servidor o valor inicial é "Todas as cidades".
  const saved = useSyncExternalStore(noopSubscribe, readCookie, () => "");
  const [chosen, setValue] = useState<string | null>(null);
  const value = chosen ?? saved;

  return (
    <label className={cn("relative", className)}>
      <span className="sr-only">Selecionar cidade</span>
      <MapPin className={cn("pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2", variant === "hero" ? "text-white/80" : "text-secondary")} aria-hidden />
      <select
        value={value}
        onChange={(e) => {
          const slug = e.target.value;
          setValue(slug);
          document.cookie = `${COOKIE}=${encodeURIComponent(slug)}; path=/; max-age=31536000; samesite=lax`;
          router.push(slug ? `/cidades/${slug}` : "/eventos");
        }}
        className={cn(
          "appearance-none rounded-full pl-9 pr-8 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          variant === "hero" ? "h-12 w-full border border-white/25 bg-white/10 text-white backdrop-blur [&>option]:text-black" : "h-10 border border-border bg-card",
        )}
      >
        <option value="">Todas as cidades</option>
        {cities.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
