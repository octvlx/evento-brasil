/** Política de transferência do evento, compartilhada entre servidor e interface. */
export interface TransferPolicy {
  transferDeadlineHours: number;
  transferMaxTransfers: number;
  transferAllowReturn: boolean;
}

export const DEFAULT_TRANSFER_POLICY: Readonly<TransferPolicy> = {
  transferDeadlineHours: 24,
  transferMaxTransfers: 1,
  transferAllowReturn: false,
};

export const TRANSFER_ACCEPT_WINDOW_HOURS = 48;

/** Campos ausentes usam o padrão apenas para formulários novos, antes de existir evento. */
export function normalizeTransferPolicy(policy: Partial<TransferPolicy>): TransferPolicy {
  return {
    transferDeadlineHours: policy.transferDeadlineHours ?? DEFAULT_TRANSFER_POLICY.transferDeadlineHours,
    transferMaxTransfers: policy.transferMaxTransfers ?? DEFAULT_TRANSFER_POLICY.transferMaxTransfers,
    transferAllowReturn: policy.transferAllowReturn ?? DEFAULT_TRANSFER_POLICY.transferAllowReturn,
  };
}

/** O prazo é exclusivo: no instante de corte não se pode pedir nem aceitar. */
export function transferCutoff(startsAt: Date | string, policy: Partial<TransferPolicy>): Date {
  return new Date(new Date(startsAt).getTime() - normalizeTransferPolicy(policy).transferDeadlineHours * 3_600_000);
}
