import { Wallet } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/**
 * Links "Apple Wallet" e "Google Wallet" (só as carteiras configuradas; ver
 * docs/wallet.md). `ticketCode` = um ingresso; `orderId` = todos os ingressos do
 * pedido que estão com o comprador.
 */
export function WalletLinks({
  apple,
  google,
  ticketCode,
  orderId,
  compact = false,
}: {
  apple: boolean;
  google: boolean;
  ticketCode?: string;
  orderId?: string;
  compact?: boolean;
}) {
  if (!apple && !google) return null;
  const base = ticketCode ? `/api/tickets/${ticketCode}/wallet` : `/api/orders/${orderId}/wallet`;
  const all = !ticketCode;
  const cls = buttonVariants({ variant: "outline", size: "sm" });
  return (
    <span className="flex flex-wrap gap-2" data-testid="wallet-links">
      {apple && (
        <a href={`${base}/apple`} className={cls}>
          <Wallet aria-hidden /> {compact ? "Apple Wallet" : all ? "Adicionar todos à Apple Wallet" : "Adicionar à Apple Wallet"}
        </a>
      )}
      {google && (
        <a href={`${base}/google`} className={cls}>
          <Wallet aria-hidden /> {compact ? "Google Wallet" : all ? "Salvar todos no Google Wallet" : "Salvar no Google Wallet"}
        </a>
      )}
    </span>
  );
}
