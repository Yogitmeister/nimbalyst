// [ASTRA-ORCH]
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("../../../utils/store", () => ({
  getProviderApiKeyFromSettings: vi.fn(),
}));

import {
  CLAUDEX_INGRESS_CREDENTIAL_REF,
  DEEPSEEK_API_CREDENTIAL_REF,
  OPENROUTER_API_CREDENTIAL_REF,
} from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogDefaults";
import { createProviderRouteCredentialResolver } from "../providerRouteCredentialResolver";

const TEST_INGRESS_CREDENTIAL = "c".repeat(48);
const TEST_DEEPSEEK_CREDENTIAL = "d".repeat(48);
const TEST_OPENROUTER_CREDENTIAL = "o".repeat(48);

describe("Electron provider route credential host seam", () => {
  it("resolves only reviewed named sources without exposing values to catalog callers", () => {
    const readTextFile = vi.fn(() => `${TEST_INGRESS_CREDENTIAL}\n`);
    const getProviderApiKey = vi.fn((providerId: string) =>
      providerId === "deepseek"
        ? TEST_DEEPSEEK_CREDENTIAL
        : providerId === "openrouter"
          ? TEST_OPENROUTER_CREDENTIAL
          : null
    );
    const resolver = createProviderRouteCredentialResolver({
      readTextFile,
      getProviderApiKey,
      getClaudexRoot: () => "D:/Users/Test/Claudex",
    });

    expect(resolver(CLAUDEX_INGRESS_CREDENTIAL_REF)).toBe(
      TEST_INGRESS_CREDENTIAL
    );
    expect(readTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/Claudex[\\/]secrets[\\/]ingress\.token$/)
    );
    expect(resolver(DEEPSEEK_API_CREDENTIAL_REF)).toBe(
      TEST_DEEPSEEK_CREDENTIAL
    );
    expect(getProviderApiKey).toHaveBeenCalledWith("deepseek", undefined);
    expect(resolver(OPENROUTER_API_CREDENTIAL_REF)).toBe(
      TEST_OPENROUTER_CREDENTIAL
    );
    expect(getProviderApiKey).toHaveBeenCalledWith("openrouter", undefined);
    expect(resolver("workspace.not-reviewed")).toBeUndefined();
  });

  it("selects the workspace-scoped DeepSeek source before the global source", () => {
    const getProviderApiKey = vi.fn(
      (providerId: string, workspacePath?: string) =>
        providerId !== "deepseek"
          ? null
          : workspacePath === "D:/workspace-only"
            ? TEST_DEEPSEEK_CREDENTIAL
            : TEST_OPENROUTER_CREDENTIAL
    );
    const resolver = createProviderRouteCredentialResolver({
      getProviderApiKey,
    });

    expect(
      resolver(DEEPSEEK_API_CREDENTIAL_REF, {
        workspacePath: "D:/workspace-only",
      })
    ).toBe(TEST_DEEPSEEK_CREDENTIAL);
    expect(resolver(DEEPSEEK_API_CREDENTIAL_REF)).toBe(
      TEST_OPENROUTER_CREDENTIAL
    );
    expect(getProviderApiKey).toHaveBeenCalledWith(
      "deepseek",
      "D:/workspace-only"
    );
    expect(getProviderApiKey).toHaveBeenCalledWith("deepseek", undefined);
  });

  it("rejects malformed named-source material before it reaches a route", () => {
    const resolver = createProviderRouteCredentialResolver({
      readTextFile: () => "too-short",
      getProviderApiKey: () => "   ",
      getClaudexRoot: () => "D:/Users/Test/Claudex",
    });

    expect(resolver(CLAUDEX_INGRESS_CREDENTIAL_REF)).toBeUndefined();
    expect(resolver(DEEPSEEK_API_CREDENTIAL_REF)).toBeUndefined();
    expect(resolver(OPENROUTER_API_CREDENTIAL_REF)).toBeUndefined();
  });

  it("returns undefined for an unavailable DeepSeek setting", () => {
    const getProviderApiKey = vi.fn(() => null);
    const resolver = createProviderRouteCredentialResolver({
      getProviderApiKey,
    });

    expect(resolver(DEEPSEEK_API_CREDENTIAL_REF)).toBeUndefined();
    expect(getProviderApiKey).toHaveBeenCalledWith("deepseek", undefined);
  });
});
