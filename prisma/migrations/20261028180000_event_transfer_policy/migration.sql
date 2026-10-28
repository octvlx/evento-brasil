-- Defaults intentionally apply to existing events. Accepted transfer history is
-- preserved even when its historical count exceeds the new event limit.
ALTER TABLE "Event"
  ADD COLUMN "transferDeadlineHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "transferMaxTransfers" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "transferAllowReturn" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Event"
  ADD CONSTRAINT "Event_transfer_deadline_hours_range"
    CHECK ("transferDeadlineHours" BETWEEN 0 AND 8760),
  ADD CONSTRAINT "Event_transfer_max_transfers_range"
    CHECK ("transferMaxTransfers" BETWEEN 1 AND 10);
