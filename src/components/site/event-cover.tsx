import { cn } from "@/lib/utils";

/**
 * Capa do evento. Usa <img> simples: as capas vêm do armazenamento de objetos
 * (CDN próprio) ou do gerador local de placeholders SVG em desenvolvimento.
 */
export function EventCover({ src, alt, className, priority }: { src: string | null; alt: string; className?: string; priority?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src ?? "/placeholder/evento.svg"}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      className={cn("h-full w-full object-cover", className)}
    />
  );
}
