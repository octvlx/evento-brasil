const PAGE_SIZE = 15;

/** Reject malformed search values and clamp valid pages to the buyer's result set. */
export function ordersPagination(raw: string | string[] | undefined, total: number, pageSize = PAGE_SIZE) {
  const requested = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 1;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Number.isSafeInteger(requested) && requested > 0 ? requested : 1, pageCount);
  return { page, pageCount, skip: (page - 1) * pageSize, take: pageSize };
}
