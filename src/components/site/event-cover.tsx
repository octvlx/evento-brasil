import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Capa do evento. As capas vêm do armazenamento de objetos (CDN próprio) ou do
 * gerador local de placeholders SVG em desenvolvimento. Com `sizes` (o pai deve
 * ser `relative` com proporção fixa), usa next/image com srcset responsivo; capa
 * de outro domínio vai sem otimização (sem abrir o otimizador para qualquer host).
 */
export function EventCover({ src, alt, className, priority, sizes }: { src: string | null; alt: string; className?: string; priority?: boolean; sizes?: string }) {
  const url = src ?? "/placeholder/evento.svg";
  if (sizes)
    return (
      <Image
        src={url}
        alt={alt}
        fill
        sizes={sizes}
        loading={priority ? "eager" : "lazy"}
        unoptimized={/^https?:\/\//i.test(url)}
        className={cn("object-cover", className)}
      />
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      className={cn("h-full w-full object-cover", className)}
    />
  );
}
