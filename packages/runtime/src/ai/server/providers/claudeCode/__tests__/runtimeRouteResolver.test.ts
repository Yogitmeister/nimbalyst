// [ASTRA-ORCH]
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
  CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT,
} from "../../../../modelConstants";
import {
  resolveProviderCatalog,
  type ProviderCatalogEntry,
  type ProviderCatalogResolution,
} from "../providerCatalog";
import {
  BUILT_IN_PROVIDER_CATALOG,
  CLAUDEX_INGRESS_CREDENTIAL_REF,
  CLAUDEX_LUNA_ENTRY_ID,
  CLAUDEX_SOL_ENTRY_ID,
  CLAUDEX_TERRA_ENTRY_ID,
  DEEPSEEK_API_CREDENTIAL_REF,
  DEEPSEEK_V4_FLASH_OFFICIAL_ENTRY_ID,
  DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID,
  DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID,
  DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID,
  LOCAL_PROXY_CREDENTIAL_REF,
  OLLAMA_API_CREDENTIAL_REF,
  OPENROUTER_API_CREDENTIAL_REF,
} from "../providerCatalogDefaults";
import {
  applyClaudeCodeBackendEnv,
  applyProviderRuntimeLaunchPlanEnv,
  resolveClaudeCodeBackendFromModel,
} from "../customBackends";
import { LOCAL_PROXY_AUTH_TOKEN } from "../providerRouteCredentials";
import {
  ProviderRuntimeRouteError,
  ProviderRuntimeSessionSnapshotStore,
  createProviderRuntimeRouteReceipt,
  resolveClaudeAgentRuntimeRoutes,
  resolveClaudeSubagentLaunchPlan,
  resolveConsultationLauncherPlan,
  resolveMainClaudeAgentLaunchPlan,
  resolveProviderRuntimeLaunchPlan,
  serializeProviderRuntimeRouteReceipt,
  type ProviderRuntimeConsumer,
} from "../runtimeRouteResolver";

const resolution = resolveProviderCatalog(BUILT_IN_PROVIDER_CATALOG, undefined);
const credentialReferences = Object.freeze({
  [LOCAL_PROXY_CREDENTIAL_REF]: true,
  [CLAUDEX_INGRESS_CREDENTIAL_REF]: true,
  [DEEPSEEK_API_CREDENTIAL_REF]: true,
  [OPENROUTER_API_CREDENTIAL_REF]: true,
  [OLLAMA_API_CREDENTIAL_REF]: true,
});

function entry(id: string): ProviderCatalogEntry {
  const resolved = resolution.entries.find((candidate) => candidate.id === id);
  if (!resolved) throw new Error(`missing test catalog entry ${id}`);
  return resolved;
}

function resolvePlan(
  id: string,
  consumer: ProviderRuntimeConsumer = "claude-agent-main",
  persistedControls: Readonly<Record<string, string>> = {}
) {
  const catalogEntry = entry(id);
  return resolveProviderRuntimeLaunchPlan(resolution, {
    catalogEntryId: id,
    persistedModelId: catalogEntry.model.persistedId,
    consumer,
    persistedControls,
    credentialReferences,
  });
}

function captureRouteError(action: () => unknown): ProviderRuntimeRouteError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRuntimeRouteError);
    return error as ProviderRuntimeRouteError;
  }
  throw new Error("expected provider route resolution to fail");
}

describe("provider runtime route resolution", () => {
  it("selects the consumer-owned interface independently of array order", () => {
    const base = entry(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const interfaceBase = base.interfaces[0];
    const mainInterface = {
      ...interfaceBase,
      id: "a-main",
      consumers: ["claude-agent-main"] as const,
    };
    const delegatedInterface = {
      ...interfaceBase,
      id: "z-delegated",
      consumers: ["claude-agent-subagent", "consultation"] as const,
    };
    const makeResolution = (interfaces: ProviderCatalogEntry["interfaces"]) =>
      resolveProviderCatalog(
        [{ ...base, interfaces, controls: {} }],
        undefined
      );

    const forward = makeResolution([mainInterface, delegatedInterface]);
    const reversed = makeResolution([delegatedInterface, mainInterface]);
    const request = {
      catalogEntryId: base.id,
      persistedModelId: base.model.persistedId,
      credentialReferences,
    };

    expect(
      resolveMainClaudeAgentLaunchPlan(forward, request).selectedInterface.id
    ).toBe("a-main");
    expect(
      resolveMainClaudeAgentLaunchPlan(reversed, request).selectedInterface.id
    ).toBe("a-main");
    expect(
      resolveClaudeSubagentLaunchPlan(forward, request).selectedInterface.id
    ).toBe("z-delegated");
    expect(
      resolveConsultationLauncherPlan(reversed, request).selectedInterface.id
    ).toBe("z-delegated");
  });

  it("keeps DeepSeek Official, Ollama Cloud, and OpenRouter exact", () => {
    const official = resolvePlan(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const officialFlash = resolvePlan(DEEPSEEK_V4_FLASH_OFFICIAL_ENTRY_ID);
    const ollama = resolvePlan(
      CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_VARIANT
    );
    const openRouter = resolvePlan(DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID);
    const openRouterFlash = resolvePlan(DEEPSEEK_V4_FLASH_OPENROUTER_ENTRY_ID);

    expect([
      [
        official.provider,
        official.model.persistedId,
        official.selectedInterface.endpoint,
      ],
      [
        ollama.provider,
        ollama.model.persistedId,
        ollama.selectedInterface.endpoint,
      ],
      [
        openRouter.provider,
        openRouter.model.persistedId,
        openRouter.selectedInterface.endpoint,
      ],
      [
        officialFlash.provider,
        officialFlash.selectedInterface.modelAlias,
        officialFlash.model.persistedId,
      ],
      [
        openRouterFlash.provider,
        openRouterFlash.selectedInterface.modelAlias,
        openRouterFlash.model.persistedId,
      ],
    ]).toEqual([
      [
        "deepseek",
        "claude-code:deepseek-v4-pro",
        "https://api.deepseek.com/anthropic",
      ],
      [
        "ollama",
        CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL,
        "https://ollama.com",
      ],
      [
        "openrouter",
        "claude-code:openrouter-deepseek-v4-pro",
        "https://openrouter.ai/api",
      ],
      ["deepseek", "deepseek-v4-flash", "claude-code:deepseek-v4-flash"],
      [
        "openrouter",
        // Dated slug: the undated alias defaults reasoning off on OpenRouter.
        "deepseek/deepseek-v4-flash-0731",
        "claude-code:openrouter-deepseek-v4-flash",
      ],
    ]);
    expect(
      [official, officialFlash, ollama, openRouter, openRouterFlash].every(
        (plan) => !plan.fallbackUsed
      )
    ).toBe(true);
  });

  it("maps Claudex Sol, Terra, and Luna identities and persisted effort", () => {
    const expected = [
      [CLAUDEX_SOL_ENTRY_ID, "gpt-5.6-sol"],
      [CLAUDEX_TERRA_ENTRY_ID, "gpt-5.6-terra"],
      [CLAUDEX_LUNA_ENTRY_ID, "gpt-5.6-luna"],
    ] as const;
    for (const [id, model] of expected) {
      const plan = resolvePlan(id, "claude-agent-main", {
        "effort-level": "max",
      });
      expect(plan.provider).toBe("openai");
      expect(plan.model.providerModelId).toBe(model);
      expect(plan.selectedInterface.modelAlias).toBe(model);
      expect(plan.resolvedControls).toContainEqual(
        expect.objectContaining({ target: "launch.effort-level", value: "max" })
      );
    }
  });

  it("returns typed pre-mutation errors for consumers, credentials, and adapters", () => {
    const base = entry(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const unsupportedConsumer = captureRouteError(() =>
      resolveProviderRuntimeLaunchPlan(resolution, {
        catalogEntryId: base.id,
        persistedModelId: base.model.persistedId,
        consumer: "environment-auto" as ProviderRuntimeConsumer,
        credentialReferences,
      })
    );
    expect(unsupportedConsumer).toMatchObject({
      code: "unsupported-consumer",
      stage: "pre-mutation",
    });

    const missingCredential = captureRouteError(() =>
      resolveProviderRuntimeLaunchPlan(resolution, {
        catalogEntryId: base.id,
        persistedModelId: base.model.persistedId,
        consumer: "claude-agent-main",
        credentialReferences: {},
      })
    );
    expect(missingCredential.code).toBe("credential-unavailable");

    const adapterResolution = {
      ...resolution,
      entries: [
        {
          ...base,
          interfaces: [{ ...base.interfaces[0], protocol: "future-wire" }],
        },
      ],
      errors: [],
    } as unknown as ProviderCatalogResolution;
    const adapterRequired = captureRouteError(() =>
      resolveProviderRuntimeLaunchPlan(adapterResolution, {
        catalogEntryId: base.id,
        persistedModelId: base.model.persistedId,
        consumer: "claude-agent-main",
        credentialReferences,
      })
    );
    expect(adapterRequired.code).toBe("adapter-required");
  });

  it("does not choose a different route after a simulated resolved-route failure", () => {
    const plan = resolvePlan(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      FALLBACK_FOR_ALL_PRIMARY_MODELS: "claude-sonnet",
    };
    applyProviderRuntimeLaunchPlanEnv(env, plan, "not-serialized-secret");
    expect(() => {
      throw new Error("simulated provider response failure");
    }).toThrow("simulated provider response failure");
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
      CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
    });
    expect(env.FALLBACK_FOR_ALL_PRIMARY_MODELS).toBeUndefined();
    expect(plan.fallbackUsed).toBe(false);
  });

  it("scrubs mixed-case Windows auth, provider, model, fallback, and proxy selectors", () => {
    const plan = resolvePlan(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const env: Record<string, string | undefined> = {
      AnThRoPiC_ApI_kEy: "ambient-anthropic",
      aNtHrOpIc_AuTh_ToKeN: "ambient-token",
      cLaUdE_cOdE_uSe_BeDrOcK: "1",
      aNtHrOpIc_DeFaUlT_oPuS_mOdEl: "ambient-model",
      FaLlBaCk_FoR_aLl_PrImArY_mOdElS: "ambient-fallback",
      hTtP_pRoXy: "http://ambient-proxy.invalid",
      OpEnAi_ApI_kEy: "ambient-openai",
    };

    applyProviderRuntimeLaunchPlanEnv(env, plan, "confirmed-test-value");

    const keys = Object.keys(env);
    for (const removed of [
      "AnThRoPiC_ApI_kEy",
      "aNtHrOpIc_AuTh_ToKeN",
      "cLaUdE_cOdE_uSe_BeDrOcK",
      "aNtHrOpIc_DeFaUlT_oPuS_mOdEl",
      "FaLlBaCk_FoR_aLl_PrImArY_mOdElS",
      "hTtP_pRoXy",
      "OpEnAi_ApI_kEy",
    ]) {
      expect(keys).not.toContain(removed);
    }
    expect(env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "confirmed-test-value",
      ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
      CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
    });
  });

  it("serializes a complete deeply immutable redacted receipt", () => {
    const plan = resolvePlan(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const receipt = createProviderRuntimeRouteReceipt(plan);
    const serialized = serializeProviderRuntimeRouteReceipt(receipt);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.selectedInterface)).toBe(true);
    expect(Object.isFrozen(receipt.resolvedControls)).toBe(true);
    expect(receipt).toMatchObject({
      requested: {
        catalogEntryId: DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID,
        consumer: "claude-agent-main",
      },
      resolved: {
        provider: "deepseek",
        providerModelId: "deepseek-v4-pro",
      },
      selectedInterface: {
        id: "claude-agent-anthropic",
        bridge: "claude-agent-anthropic-env-v1",
        credentialReferencePresent: true,
      },
      confirmationState: "confirmed",
      fallbackUsed: false,
    });
    expect(serialized).not.toContain("not-serialized-secret");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toMatch(/[?#][A-Za-z0-9]/);
  });

  it("keeps a running session snapshot immutable across later catalog changes", () => {
    const plan = resolvePlan(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const store = new ProviderRuntimeSessionSnapshotStore();
    const persisted = store.persist("session-1", plan);
    const catalogEntry = entry(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const reloadedResolution = resolveProviderCatalog(
      BUILT_IN_PROVIDER_CATALOG,
      {
        schemaVersion: 2,
        entries: [
          {
            id: catalogEntry.id,
            patch: {
              interfaces: [
                {
                  ...catalogEntry.interfaces[0],
                  endpoint: "https://api.deepseek.com/v1",
                },
              ],
            },
          },
        ],
      }
    );
    const changedPlan = resolveMainClaudeAgentLaunchPlan(reloadedResolution, {
      catalogEntryId: catalogEntry.id,
      persistedModelId: catalogEntry.model.persistedId,
      credentialReferences,
    });

    const changedRoute = captureRouteError(() =>
      store.persist("session-1", changedPlan)
    );
    expect(changedRoute.code).toBe("immutable-session-route");
    expect(store.get("session-1")).toBe(persisted);
    expect(store.get("session-1")?.plan.selectedInterface.endpoint).toBe(
      "https://api.deepseek.com/anthropic"
    );
  });

  it("leaves native Claude independent and preserves Ollama environment semantics", () => {
    expect(
      resolveClaudeAgentRuntimeRoutes(
        resolution,
        { model: "claude-code:opus", effortLevel: "high" },
        credentialReferences
      )
    ).toBeUndefined();

    const bundle = resolveClaudeAgentRuntimeRoutes(
      resolution,
      { model: CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL },
      credentialReferences
    );
    expect(bundle).toBeDefined();
    // The legacy proxy projection is deliberately gone for Ollama: these routes
    // are direct now, so the shared resolver owns them outright.
    expect(
      resolveClaudeCodeBackendFromModel(
        CLAUDE_CODE_OLLAMA_DEEPSEEK_V4_PRO_CLOUD_MODEL
      )
    ).toBeUndefined();
    if (!bundle) throw new Error("missing Ollama route");

    const plannedEnv: Record<string, string | undefined> = {};
    applyProviderRuntimeLaunchPlanEnv(plannedEnv, bundle.main, "ollama-token");

    expect(plannedEnv.ANTHROPIC_BASE_URL).toBe("https://ollama.com");
    expect(plannedEnv.ANTHROPIC_AUTH_TOKEN).toBe("ollama-token");
    // The exact Ollama model id goes on the wire, not a Claude-shaped alias:
    // there is no proxy left to translate one into the other.
    expect(plannedEnv.ANTHROPIC_MODEL).toBe("deepseek-v4-pro:cloud");
    expect(plannedEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-pro:cloud");
    expect(plannedEnv.CLAUDE_CODE_NO_MODEL_FALLBACK).toBe("1");
    // NO_PROXY is a loopback-only concession; a public endpoint must not get it
    // or it would punch a hole in the user's configured proxy.
    expect(plannedEnv.NO_PROXY).toBeUndefined();
  });

  it("uses the same resolver contract for main, subagent, and consultation consumers", () => {
    const catalogEntry = entry(DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID);
    const request = {
      catalogEntryId: catalogEntry.id,
      persistedModelId: catalogEntry.model.persistedId,
      persistedControls: { "effort-level": "high" },
      credentialReferences,
    };
    const plans = [
      resolveMainClaudeAgentLaunchPlan(resolution, request),
      resolveClaudeSubagentLaunchPlan(resolution, request),
      resolveConsultationLauncherPlan(resolution, request),
    ];
    expect(plans.map((plan) => plan.requested.consumer)).toEqual([
      "claude-agent-main",
      "claude-subagent",
      "consultation-launcher",
    ]);
    expect(new Set(plans.map((plan) => plan.model.catalogEntryId))).toEqual(
      new Set([DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID])
    );
    expect(new Set(plans.map((plan) => plan.selectedInterface.id))).toEqual(
      new Set(["claude-agent-anthropic"])
    );
  });

  it("rejects an unsupported catalog-owned model instead of falling back to Claude", () => {
    const error = captureRouteError(() =>
      resolveClaudeAgentRuntimeRoutes(
        resolution,
        { model: "claude-code:openrouter-not-reviewed" },
        credentialReferences
      )
    );
    expect(error.code).toBe("unsupported-model");
  });

  it("rejects unknown, disabled, and mismatched routes before launch", () => {
    const base = entry(DEEPSEEK_V4_PRO_OFFICIAL_ENTRY_ID);
    const unknown = captureRouteError(() =>
      resolveProviderRuntimeLaunchPlan(resolution, {
        catalogEntryId: "deepseek-not-reviewed",
        persistedModelId: base.model.persistedId,
        consumer: "claude-agent-main",
        credentialReferences,
      })
    );
    expect(unknown.code).toBe("unsupported-route");

    const disabled = captureRouteError(() =>
      resolveProviderRuntimeLaunchPlan(
        {
          ...resolution,
          disabledIds: [base.id],
        },
        {
          catalogEntryId: base.id,
          persistedModelId: base.model.persistedId,
          consumer: "claude-agent-main",
          credentialReferences,
        }
      )
    );
    expect(disabled.code).toBe("unsupported-route");

    const mismatch = captureRouteError(() =>
      resolveClaudeAgentRuntimeRoutes(
        resolution,
        {
          model: base.model.persistedId,
          claudeCodeBackend: DEEPSEEK_V4_PRO_OPENROUTER_ENTRY_ID,
        },
        credentialReferences
      )
    );
    expect(mismatch.code).toBe("identity-mismatch");
  });

});
