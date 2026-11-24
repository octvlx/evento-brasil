// Exclusão de organização: regras puras (bloqueios, confirmação, transições do pedido),
// permissão só de superadmin conferida no servidor e o ciclo do pedido (cancelar,
// recusar, aprovar) contra um banco falso em memória. O fluxo completo com Postgres
// está em tests/integration/zv-organization-deletion.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminRole, OrganizationDeletionRequestStatus } from "@/generated/prisma/client";

const mocks = vi.hoisted(() => ({ enqueueEmail: vi.fn(), assertCurrentTotp: vi.fn(), receivable: vi.fn() }));
vi.mock("@/server/env", () => ({ env: () => ({ APP_URL: "http://localhost:3000" }) }));
vi.mock("@/server/email/outbox", () => ({ enqueueEmail: mocks.enqueueEmail }));
vi.mock("@/server/services/two-factor", () => ({ assertCurrentTotp: mocks.assertCurrentTotp }));
vi.mock("@/server/services/ledger", () => ({ organizerReceivableCents: mocks.receivable }));

import {
  canTransitionDeletionRequest,
  deletionConfirmationMatches,
  normalizeDeletionReason,
  orgDeletionBlockedMessage,
  orgDeletionBlockers,
  type OrgDeletionCounts,
} from "@/lib/organization-deletion";
import { adminHas } from "@/server/auth/admin-roles";
import {
  adminDeleteOrganization,
  cancelOrganizationDeletionRequest,
  listPendingOrganizationDeletionRequests,
  rejectOrganizationDeletionRequest,
  requestOrganizationDeletion,
} from "@/server/services/organization-deletion";
import type { Actor } from "@/server/auth/permissions";
import type { Db } from "@/server/db";

const ZERO: OrgDeletionCounts = {
  activeEvents: 0,
  validTickets: 0,
  paidOrdersUpcoming: 0,
  openOrders: 0,
  pendingRefunds: 0,
  pendingSettlements: 0,
  organizerDebtCents: 0,
  openCancellations: 0,
};

const admin = (roles: AdminRole[]): Actor => ({ id: "admin-" + roles.join("-"), platformRole: "ADMIN", status: "ACTIVE", adminRoles: roles, totpEnabledAt: new Date() });
const owner: Actor = { id: "owner", platformRole: "USER", status: "ACTIVE" };

/** Banco que falha se for tocado: prova que a permissão é negada antes de qualquer leitura. */
const untouchable = new Proxy({}, { get: () => { throw new Error("o banco não deveria ser acessado"); } }) as unknown as Db;

describe("bloqueios", () => {
  it("nenhuma pendência: pode excluir", () => {
    expect(orgDeletionBlockers(ZERO)).toEqual([]);
  });

  it("cada pendência financeira ou de comprador vira um bloqueio, na ordem fixa", () => {
    const all: OrgDeletionCounts = {
      activeEvents: 1,
      validTickets: 3,
      paidOrdersUpcoming: 2,
      openOrders: 1,
      pendingRefunds: 1,
      pendingSettlements: 1,
      organizerDebtCents: 150,
      openCancellations: 1,
    };
    expect(orgDeletionBlockers(all)).toEqual([
      "ACTIVE_EVENTS",
      "VALID_TICKETS",
      "PAID_ORDERS_UPCOMING",
      "OPEN_ORDERS",
      "PENDING_REFUNDS",
      "PENDING_SETTLEMENT",
      "ORGANIZER_DEBT",
      "OPEN_CANCELLATIONS",
    ]);
    expect(orgDeletionBlockers({ ...ZERO, pendingRefunds: 2 })).toEqual(["PENDING_REFUNDS"]);
    expect(orgDeletionBlockers({ ...ZERO, pendingSettlements: 1 })).toEqual(["PENDING_SETTLEMENT"]);
  });

  it("saldo devedor só bloqueia quando o organizador deve (crédito a favor dele não bloqueia)", () => {
    expect(orgDeletionBlockers({ ...ZERO, organizerDebtCents: 1 })).toEqual(["ORGANIZER_DEBT"]);
    expect(orgDeletionBlockers({ ...ZERO, organizerDebtCents: -500 })).toEqual([]);
  });

  it("a mensagem traz todos os motivos, um por linha", () => {
    const msg = orgDeletionBlockedMessage(["ACTIVE_EVENTS", "PENDING_REFUNDS"]);
    expect(msg.split("\n")).toHaveLength(3);
    expect(msg).toMatch(/eventos publicados/);
    expect(msg).toMatch(/reembolsos/);
  });
});

describe("confirmação e motivo", () => {
  it("o nome digitado precisa bater (ignora maiúsculas e espaços extras)", () => {
    expect(deletionConfirmationMatches("Festa Boa Ltda", "Festa Boa Ltda")).toBe(true);
    expect(deletionConfirmationMatches("  festa   boa LTDA ", "Festa Boa Ltda")).toBe(true);
    expect(deletionConfirmationMatches("Festa Boa", "Festa Boa Ltda")).toBe(false);
    expect(deletionConfirmationMatches("", "")).toBe(false);
    expect(deletionConfirmationMatches("EXCLUIR", "Festa Boa Ltda")).toBe(false);
  });

  it("motivo do superadmin: obrigatório, de 5 a 500 caracteres; do organizador, opcional", () => {
    expect(() => normalizeDeletionReason("  ", { required: true })).toThrow(RangeError);
    expect(() => normalizeDeletionReason("abc", { required: true })).toThrow(RangeError);
    expect(() => normalizeDeletionReason("x".repeat(501), { required: true })).toThrow(RangeError);
    expect(normalizeDeletionReason("  Pedido do responsável  ", { required: true })).toBe("Pedido do responsável");
    expect(normalizeDeletionReason("", { required: false })).toBeNull();
  });
});

describe("transições do pedido", () => {
  it("só um pedido pendente é aprovado, recusado ou cancelado; decisões são finais", () => {
    for (const to of ["APPROVED", "REJECTED", "CANCELLED"] as const) expect(canTransitionDeletionRequest("PENDING", to)).toBe(true);
    for (const from of ["APPROVED", "REJECTED", "CANCELLED"] as const) {
      for (const to of ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const) expect(canTransitionDeletionRequest(from, to)).toBe(false);
    }
  });
});

describe("permissão: só superadmin, conferida no servidor", () => {
  it("apenas SUPER_ADMIN tem organizers:delete", () => {
    expect(adminHas(["SUPER_ADMIN"], "organizers:delete")).toBe(true);
    for (const role of ["FINANCE", "MODERATION", "SUPPORT"] as const) expect(adminHas([role], "organizers:delete")).toBe(false);
    expect(adminHas(["FINANCE", "MODERATION", "SUPPORT"], "organizers:delete")).toBe(false);
  });

  it("outros papéis de admin, usuário comum e admin suspenso são barrados antes de tocar no banco", async () => {
    const input = { confirmName: "Org", reason: "Pedido do responsável", adminCode: "123456" };
    for (const actor of [admin(["MODERATION"]), admin(["FINANCE"]), admin(["SUPPORT"]), owner, { ...admin(["SUPER_ADMIN"]), status: "SUSPENDED" as const }]) {
      await expect(adminDeleteOrganization(untouchable, actor, "org-1", input)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(rejectOrganizationDeletionRequest(untouchable, actor, "req-1", "Motivo da recusa")).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listPendingOrganizationDeletionRequests(untouchable, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

// ── Banco falso: o suficiente para o ciclo do pedido ──

type Req = { id: string; organizationId: string; requestedById: string; status: OrganizationDeletionRequestStatus; reason: string | null; decidedById?: string; decisionNote?: string | null; decidedAt?: Date };

function fakeDb(opts: { role?: "OWNER" | "ADMIN"; orgName?: string; counts?: Partial<OrgDeletionCounts>; googleSubject?: string | null } = {}) {
  const state = { requests: [] as Req[], audits: [] as { action: string; metadata?: unknown }[], orgDeleted: false };
  const counts = { ...ZERO, ...opts.counts };
  const matches = (r: Req, where: Partial<Req>) => Object.entries(where).every(([k, v]) => r[k as keyof Req] === v);
  const client = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
    $queryRaw: async () => [],
    organization: {
      findUnique: async () => ({ id: "org-1", name: opts.orgName ?? "Org Teste", status: "APPROVED", deletedAt: state.orgDeleted ? new Date() : null }),
    },
    organizationMember: {
      findUnique: async () => (opts.role ? { role: opts.role, organization: { status: "APPROVED" } } : null),
      findMany: async () => [],
    },
    user: {
      findUniqueOrThrow: async () => ({ passwordHash: "x", googleSubject: opts.googleSubject === undefined ? "google-sub" : opts.googleSubject, totpEnabledAt: new Date() }),
    },
    organizationDeletionRequest: {
      findFirst: async ({ where }: { where: Partial<Req> }) => state.requests.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: { where: Partial<Req> }) => state.requests.filter((r) => matches(r, where)),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = state.requests.find((x) => x.id === where.id);
        return r ? { ...r, organization: { name: opts.orgName ?? "Org Teste" }, requestedBy: { email: "dono@test.local" } } : null;
      },
      create: async ({ data }: { data: Omit<Req, "id" | "status"> }) => {
        const r: Req = { id: `req-${state.requests.length + 1}`, status: "PENDING", ...data };
        state.requests.push(r);
        return r;
      },
      updateMany: async ({ where, data }: { where: Partial<Req>; data: Partial<Req> }) => {
        const hit = state.requests.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    auditLog: { create: async ({ data }: { data: { action: string; metadata?: unknown } }) => void state.audits.push(data) },
    event: { count: async ({ where }: { where: { status?: unknown } }) => (where.status ? counts.activeEvents : 0) },
    issuedTicket: { count: async () => counts.validTickets },
    order: { count: async ({ where }: { where: { status: unknown } }) => (where.status === "PAID" ? counts.paidOrdersUpcoming : counts.openOrders) },
    refund: { count: async () => counts.pendingRefunds },
    organizerSettlement: { count: async () => counts.pendingSettlements },
    cancellationRequest: { count: async () => counts.openCancellations },
  };
  mocks.receivable.mockResolvedValue(counts.organizerDebtCents);
  return { db: client as unknown as Db, state };
}

beforeEach(() => {
  mocks.enqueueEmail.mockReset();
  mocks.assertCurrentTotp.mockReset();
  mocks.receivable.mockReset();
});

describe("pedido do organizador", () => {
  it("só o responsável (OWNER) pede; administrador da organização não", async () => {
    const { db } = fakeDb({ role: "ADMIN" });
    await expect(requestOrganizationDeletion(db, owner, "org-1", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const outsider = fakeDb({});
    await expect(requestOrganizationDeletion(outsider.db, owner, "org-1", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("com impedimento, o pedido não é criado e os motivos voltam", async () => {
    const { db, state } = fakeDb({ role: "OWNER", counts: { activeEvents: 1, pendingSettlements: 1 } });
    await expect(requestOrganizationDeletion(db, owner, "org-1", {})).rejects.toThrow(/eventos publicados[\s\S]*repasse/);
    expect(state.requests).toHaveLength(0);
  });

  it("cria um pedido pendente auditado; um segundo pedido é recusado enquanto o primeiro estiver pendente", async () => {
    const { db, state } = fakeDb({ role: "OWNER" });
    await requestOrganizationDeletion(db, owner, "org-1", { reason: "Encerramos as atividades" });
    expect(state.requests).toMatchObject([{ status: "PENDING", requestedById: "owner", reason: "Encerramos as atividades" }]);
    expect(state.audits.map((a) => a.action)).toEqual(["organization.deletion_requested"]);
    await expect(requestOrganizationDeletion(db, owner, "org-1", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(state.requests).toHaveLength(1);
  });

  it("conta com senha exige a senha correta", async () => {
    const { db, state } = fakeDb({ role: "OWNER", googleSubject: null });
    await expect(requestOrganizationDeletion(db, owner, "org-1", {})).rejects.toThrow(/Senha incorreta/);
    expect(state.requests).toHaveLength(0);
  });

  it("cancelamento: só enquanto pendente; depois de cancelado não há o que cancelar nem decidir", async () => {
    const { db, state } = fakeDb({ role: "OWNER" });
    await requestOrganizationDeletion(db, owner, "org-1", {});
    await cancelOrganizationDeletionRequest(db, owner, "org-1");
    expect(state.requests[0].status).toBe("CANCELLED");
    await expect(cancelOrganizationDeletionRequest(db, owner, "org-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rejectOrganizationDeletionRequest(db, admin(["SUPER_ADMIN"]), "req-1", "Motivo da recusa")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(state.audits.map((a) => a.action)).toEqual(["organization.deletion_requested", "organization.deletion_request_cancelled"]);
  });

  it("depois de cancelado, um novo pedido pode ser feito", async () => {
    const { db, state } = fakeDb({ role: "OWNER" });
    await requestOrganizationDeletion(db, owner, "org-1", {});
    await cancelOrganizationDeletionRequest(db, owner, "org-1");
    await requestOrganizationDeletion(db, owner, "org-1", {});
    expect(state.requests.map((r) => r.status)).toEqual(["CANCELLED", "PENDING"]);
  });
});

describe("decisão do superadmin", () => {
  it("recusa: exige motivo, grava quem decidiu, avisa o responsável e é final", async () => {
    const { db, state } = fakeDb({ role: "OWNER" });
    const superAdmin = admin(["SUPER_ADMIN"]);
    await requestOrganizationDeletion(db, owner, "org-1", {});
    await expect(rejectOrganizationDeletionRequest(db, superAdmin, "req-1", " ")).rejects.toMatchObject({ code: "VALIDATION" });
    await rejectOrganizationDeletionRequest(db, superAdmin, "req-1", "Há pendência fiscal a resolver");
    expect(state.requests[0]).toMatchObject({ status: "REJECTED", decidedById: superAdmin.id, decisionNote: "Há pendência fiscal a resolver" });
    expect(mocks.enqueueEmail).toHaveBeenCalledOnce();
    expect(mocks.enqueueEmail.mock.calls[0][1]).toMatchObject({ recipient: "dono@test.local", template: "ORGANIZATION_DELETION_REJECTED" });
    // Decidido não volta: nem nova recusa, nem cancelamento pelo dono.
    await expect(rejectOrganizationDeletionRequest(db, superAdmin, "req-1", "Outro motivo qualquer")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(cancelOrganizationDeletionRequest(db, owner, "org-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("aprovação: confirmação pelo nome e motivo; bloqueio audita e não gasta o código do autenticador", async () => {
    const { db, state } = fakeDb({ role: "OWNER", orgName: "Festa Boa" });
    const superAdmin = admin(["SUPER_ADMIN"]);
    await requestOrganizationDeletion(db, owner, "org-1", {});
    const base = { confirmName: "Festa Boa", reason: "Pedido do responsável", adminCode: "123456", requestId: "req-1" };
    await expect(adminDeleteOrganization(db, superAdmin, "org-1", { ...base, confirmName: "EXCLUIR" })).rejects.toThrow(/nome da organização/);
    await expect(adminDeleteOrganization(db, superAdmin, "org-1", { ...base, reason: "" })).rejects.toMatchObject({ code: "VALIDATION" });

    // Uma venda começou depois do pedido: a aprovação é bloqueada e o pedido segue pendente.
    const blocked = fakeDb({ role: "OWNER", orgName: "Festa Boa", counts: { validTickets: 2 } });
    blocked.state.requests.push({ id: "req-1", organizationId: "org-1", requestedById: "owner", status: "PENDING", reason: null });
    await expect(adminDeleteOrganization(blocked.db, superAdmin, "org-1", base)).rejects.toThrow(/ingressos válidos/);
    expect(mocks.assertCurrentTotp).not.toHaveBeenCalled();
    expect(blocked.state.requests[0].status).toBe("PENDING");
    expect(blocked.state.audits).toMatchObject([{ action: "organization.deletion_blocked", metadata: { result: "BLOCKED", blockers: ["VALID_TICKETS"], requestId: "req-1" } }]);
    expect(state.requests[0].status).toBe("PENDING");
  });
});
