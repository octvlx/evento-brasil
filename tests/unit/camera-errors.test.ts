import { describe, expect, it } from "vitest";
import { CAMERA_MESSAGES, cameraPrecheck, cameraProblemOf } from "@/features/checkin/camera-errors";

describe("avisos de câmera do leitor", () => {
  it("antes de pedir: fora de HTTPS e navegador sem câmera", () => {
    expect(cameraPrecheck({ isSecureContext: false, hasGetUserMedia: false })).toBe("INSECURE");
    expect(cameraPrecheck({ isSecureContext: true, hasGetUserMedia: false })).toBe("UNSUPPORTED");
    expect(cameraPrecheck({ isSecureContext: true, hasGetUserMedia: true })).toBeNull();
  });

  it.each([
    ["NotAllowedError", "DENIED"],
    ["SecurityError", "DENIED"],
    ["NotFoundError", "NOT_FOUND"],
    ["OverconstrainedError", "NOT_FOUND"],
    ["NotReadableError", "IN_USE"],
    ["AbortError", "IN_USE"],
    ["TypeError", "UNKNOWN"],
  ])("%s → %s", (name, problem) => {
    expect(cameraProblemOf({ name })).toBe(problem);
  });

  it("erro sem nome cai no genérico; toda mensagem lembra uma saída", () => {
    expect(cameraProblemOf(null)).toBe("UNKNOWN");
    expect(cameraProblemOf("x")).toBe("UNKNOWN");
    for (const m of Object.values(CAMERA_MESSAGES)) expect(m).toMatch(/digite o código|Ativar câmera/i);
  });
});
