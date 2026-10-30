import { describe, expect, it } from "vitest";
import { ordersPagination } from "@/features/orders/pagination";

describe("buyer order pagination", () => {
  it.each([undefined, "", "1.5", "Infinity", "1e309", "NaN", "-1", "0", "abc", "1e2", "9007199254740993", ["1", "2"]])("normalizes malformed page %j before building Prisma offsets", raw => {
    expect(ordersPagination(raw, 31)).toEqual({ page: 1, pageCount: 3, skip: 0, take: 15 });
  });
  it("retains ordinary pages and clamps oversized integer pages to actual results", () => {
    expect(ordersPagination("2", 31)).toEqual({ page: 2, pageCount: 3, skip: 15, take: 15 });
    expect(ordersPagination("2147483648", 31)).toEqual({ page: 3, pageCount: 3, skip: 30, take: 15 });
    expect(ordersPagination("2", 0)).toEqual({ page: 1, pageCount: 1, skip: 0, take: 15 });
  });
});
