// [ASTRA-ORCH]
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_OLLAMA_BACKEND_IDENTITIES } from "../../../../modelConstants";
import { resolveClaudeCodeModelVariant } from "../../../types";
import {
  applyClaudeCodeBackendEnv,
  CLAUDE_CODE_BACKENDS,
  OLLAMA_GLM_5_2_CLOUD_BACKEND_ID,
  projectClaudeCodeBackends,
  resolveClaudeCodeBackend,
  resolveClaudeCodeBackendFromModelInCatalog,
  resolveClaudeCodeBackendForConfig,
  resolveClaudeCodeBackendFromModel,
  resolveClaudeCodeBackendInCatalog,
} from "../customBackends";
import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  resolveProviderCatalog,
  type ProviderCatalogEntry,
} from "../providerCatalog";
import {
  BUILT_IN_PROVIDER_CATALOG,
  LOCAL_PROXY_CREDENTIAL_REF,
} from "../providerCatalogDefaults";

/**
 * The 12 built-in Ollama routes moved off the LiteLLM proxy and now reach
 * ollama.com directly, so no built-in entry projects into the legacy
 * ClaudeCodeBackend adapter any more.
 *
 * That adapter is still live for user-overlay entries pointed at a local
 * Anthropic-compatible proxy, and its fail-closed behaviour is the reason it
 * exists, so it keeps its coverage here against fixtures with exactly the shape
 * the built-ins used to have.
 */
function legacyProxyEntry(options: {
  id: string;
  persistedId: string;
  providerModelId: string;
  modelAlias: string;
}): ProviderCatalogEntry {
  return {
    id: options.id,
    provider: "ollama",
    harness: { id: "claude-agent", order: 10 },
    family: { id: "glm", order: 50 },
    displayName: options.providerModelId,
    model: {
      persistedId: options.persistedId,
      persistedIdNamespace: "claude-code:ollama-",
      providerModelId: options.providerModelId,
      upstreamModel: `openai/${options.providerModelId}`,
      version: options.providerModelId,
    },
    capabilities: {
      mainSession: true,
      subagent: true,
      consultation: true,
      tools: true,
      vision: false,
    },
    interfaces: [
      {
        id: "claude-agent-proxy",
        kind: "http",
        consumers: [
          "claude-agent-main",
          "claude-agent-subagent",
          "consultation",
        ],
        protocol: "anthropic-messages",
        transportProfile: "anthropic-compatible-proxy",
        authProfile: "credential-reference",
        endpoint: "http://127.0.0.1:4002",
        upstreamEndpoint: "https://ollama.com/v1",
        credentialRef: LOCAL_PROXY_CREDENTIAL_REF,
        modelAlias: options.modelAlias,
      },
    ],
    controls: {},
  };
}

const LEGACY_PROXY_ALIAS = "claude-sonnet-4-5-20250929";
const LEGACY_PROXY_CATALOG: readonly ProviderCatalogEntry[] = [
  legacyProxyEntry({
    id: "ollama-glm-5-2-cloud-proxy",
    persistedId: "claude-code:ollama-glm-5-2-cloud-proxy",
    providerModelId: "glm-5.2:cloud",
    modelAlias: LEGACY_PROXY_ALIAS,
  }),
  legacyProxyEntry({
    id: "ollama-gpt-oss-20b-cloud-proxy",
    persistedId: "claude-code:ollama-gpt-oss-20b-cloud-proxy",
    providerModelId: "gpt-oss:20b-cloud",
    modelAlias: "claude-opus-4-1-20250805",
  }),
];

function legacyProxyRoutes(
  overlay?: Parameters<typeof resolveProviderCatalog>[1],
  errors?: Parameters<typeof resolveProviderCatalog>[2]
) {
  const resolution = resolveProviderCatalog(
    LEGACY_PROXY_CATALOG,
    overlay,
    errors
  );
  return { resolution, backends: projectClaudeCodeBackends(resolution) };
}

// Independent contract copied from the route/auth/socket/proxy/OAuth/model
// selectors read by the pinned @anthropic-ai/claude-agent-sdk native CLI.
// Do not import the implementation scrub list: a missing implementation key
// must make this test fail.
const PINNED_SDK_AMBIENT_ROUTE_KEYS = [
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_API_BASE_URL",
  "AGENT_PROXY_URL",
  "AGENT_PROXY_AUTH_TOKEN",
  "CCR_AGENT_PROXY_ENABLED",
  "CCR_AGENT_PROXY_INCLUDE_HOSTS",
  "CCR_AGENT_PROXY_RELAY_MODE",
  "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
  "CLAUDE_CODE_SIMULATE_PROXY_USAGE",
  "CLAUDE_CODE_AGENT_PROXY_GIT_CONFIG",
  "CLAUDE_CODE_AGENT_PROXY_GH_SHIM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "CLOUD_ML_REGION",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HFI_BEARER_TOKEN",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CLAUDE_BRIDGE_OAUTH_TOKEN",
  "CLAUDE_BG_SOCKET_TOKENS_PATH",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
  "CLAUDE_CODE_AUTO_MODE_MODEL",
  "CLAUDE_CONTEXT_COLLAPSE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "FALLBACK_FOR_ALL_PRIMARY_MODELS",
  "CLAUDE_CODE_NO_MODEL_FALLBACK",
] as const;

const PINNED_ROUTE_VALUES: Readonly<Record<string, string>> = {
  ANTHROPIC_MODEL: "claude-sonnet-4-5-20250929",
  ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-4-5-20250929",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-sonnet-4-5-20250929",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-4-5-20250929",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5-20250929",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-5-20250929",
  ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-sonnet-4-5-20250929",
  CLAUDE_CODE_BG_CLASSIFIER_MODEL: "claude-sonnet-4-5-20250929",
  CLAUDE_CODE_AUTO_MODE_MODEL: "claude-sonnet-4-5-20250929",
  CLAUDE_CONTEXT_COLLAPSE_MODEL: "claude-sonnet-4-5-20250929",
  CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-4-5-20250929",
  CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
  NO_PROXY: "127.0.0.1,localhost",
};

describe("Claude Code custom backends", () => {
  it("resolves an exact local-proxy backed profile", () => {
    const { resolution, backends } = legacyProxyRoutes();
    expect(
      resolveClaudeCodeBackendInCatalog(
        resolution,
        backends,
        LEGACY_PROXY_CATALOG[0].id
      )
    ).toMatchObject({
      id: LEGACY_PROXY_CATALOG[0].id,
      persistedModel: "claude-code:ollama-glm-5-2-cloud-proxy",
      provider: "ollama",
      model: "glm-5.2:cloud",
      upstreamModel: "openai/glm-5.2:cloud",
      upstreamBaseUrl: "https://ollama.com/v1",
      baseUrl: "http://127.0.0.1:4002",
      claudeModelAlias: LEGACY_PROXY_ALIAS,
    });
  });

  it("stops projecting built-in Ollama routes through the legacy proxy adapter", () => {
    // Direct ollama.com routes are consumed by the shared runtime resolver, so
    // the legacy adapter must report no built-in members rather than silently
    // handing back a proxy-shaped route that no longer exists.
    expect(CLAUDE_CODE_BACKENDS).toEqual([]);
    expect(
      resolveClaudeCodeBackendFromModel("claude-code:ollama-glm-5-2-cloud")
    ).toBeUndefined();
    // Asking the legacy adapter directly for a now-direct route is a caller
    // bug, so it fails loudly instead of degrading to an Anthropic session.
    expect(() =>
      resolveClaudeCodeBackend(OLLAMA_GLM_5_2_CLOUD_BACKEND_ID)
    ).toThrow("adapter required for Claude Agent launch");
  });

  it("fails closed for unknown persisted backend ids", () => {
    expect(() =>
      resolveClaudeCodeBackend("ollama-similar-but-unsupported")
    ).toThrow("Unsupported Claude Code backend profile");
  });

  it("isolates auth and pins manager plus native children to the proxy alias", () => {
    const { resolution, backends } = legacyProxyRoutes();
    const backend = resolveClaudeCodeBackendInCatalog(
      resolution,
      backends,
      LEGACY_PROXY_CATALOG[0].id
    )!;
    const env: Record<string, string | undefined> = {
      ...Object.fromEntries(
        PINNED_SDK_AMBIENT_ROUTE_KEYS.map((key) => [key, `ambient-${key}`])
      ),
      ANTHROPIC_API_KEY: "configured-anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "ambient-token",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      UNRELATED: "preserved",
    };

    applyClaudeCodeBackendEnv(env, backend);

    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4002",
      ANTHROPIC_AUTH_TOKEN: "sk-nim-local-proxy",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-4-5-20250929",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5-20250929",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-5-20250929",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-4-5-20250929",
      UNRELATED: "preserved",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    for (const key of PINNED_SDK_AMBIENT_ROUTE_KEYS) {
      if (key in PINNED_ROUTE_VALUES) {
        expect(env[key]).toBe(PINNED_ROUTE_VALUES[key]);
      } else {
        expect(env[key]).toBeUndefined();
      }
    }
  });

  it("does not alter a normal session when no backend is selected", () => {
    expect(resolveClaudeCodeBackend(undefined)).toBeUndefined();
    expect(resolveClaudeCodeBackend(null)).toBeUndefined();
  });

  it("derives the route from the exact canonical persisted model", () => {
    const { resolution, backends } = legacyProxyRoutes();
    const entry = LEGACY_PROXY_CATALOG[0];
    expect(
      resolveClaudeCodeBackendFromModelInCatalog(
        resolution,
        backends,
        entry.model.persistedId
      )?.id
    ).toBe(entry.id);
    expect(
      resolveClaudeCodeBackendInCatalog(resolution, backends, entry.id)?.id
    ).toBe(entry.id);
  });

  it("keeps every allowlisted Ollama identity mapped to its exact SDK alias", () => {
    // The catalog routes now carry the real Ollama model id on the wire, but
    // the persisted-identity to SDK-alias mapping still governs which native
    // model variant a stored session resolves to, so it stays exact.
    for (const identity of CLAUDE_CODE_OLLAMA_BACKEND_IDENTITIES) {
      expect(
        resolveClaudeCodeModelVariant(
          identity.persistedModel,
          "claude-code:opus"
        )
      ).toBe(identity.sdkAlias);
      // Direct routes are the shared resolver's business, not the legacy
      // adapter's, so the adapter declines them rather than guessing.
      expect(
        resolveClaudeCodeBackendFromModel(identity.persistedModel)
      ).toBeUndefined();
    }
  });

  it("rejects lookalike model identities and backend/model mismatches", () => {
    expect(() =>
      resolveClaudeCodeBackendFromModel("claude-code:ollama-glm-5-2-cloud-ish")
    ).toThrow("Unsupported catalog-owned Claude Code model identity");

    const { resolution, backends } = legacyProxyRoutes();
    expect(() =>
      resolveClaudeCodeBackendInCatalog(
        resolution,
        backends,
        "ollama-similar-but-unsupported"
      )
    ).toThrow("Unsupported Claude Code backend profile");
    expect(() =>
      resolveClaudeCodeBackendForConfig({
        model: "claude-code:sonnet",
        claudeCodeBackend: OLLAMA_GLM_5_2_CLOUD_BACKEND_ID,
      })
    ).toThrow();
  });

  it("projects unrelated valid routes when a legacy error blocks a built-in id", () => {
    const blocked = LEGACY_PROXY_CATALOG[0];
    const unrelated = LEGACY_PROXY_CATALOG[1];
    const resolution = resolveProviderCatalog(
      LEGACY_PROXY_CATALOG,
      undefined,
      [
        {
          scope: "entry",
          id: blocked.id,
          code: "raw-credential",
          message: "sanitized migration error",
        },
      ]
    );
    const backends = projectClaudeCodeBackends(resolution);

    expect(backends.some((backend) => backend.id === blocked.id)).toBe(false);
    expect(
      resolveClaudeCodeBackendInCatalog(resolution, backends, unrelated.id)?.id
    ).toBe(unrelated.id);
  });

  it("makes source failures fatal to catalog routes while leaving native models independent", () => {
    const resolution = resolveProviderCatalog(
      LEGACY_PROXY_CATALOG,
      undefined,
      [
        {
          scope: "source",
          code: "malformed-json",
          message: "Overlay JSON is malformed.",
        },
      ]
    );
    const backends = projectClaudeCodeBackends(resolution);

    expect(backends).toEqual([]);
    expect(
      resolveClaudeCodeBackendFromModelInCatalog(
        resolution,
        backends,
        "claude-code:sonnet"
      )
    ).toBeUndefined();
    expect(() =>
      resolveClaudeCodeBackendFromModelInCatalog(
        resolution,
        backends,
        BUILT_IN_PROVIDER_CATALOG[0].model.persistedId
      )
    ).toThrow("Provider catalog unavailable");
  });

  it.each(["claude-code:sonnet", "openai-codex:gpt-5.6-sol"])(
    "does not route a reserved identity %s through an overlay backend",
    (model) => {
      const builtIn = BUILT_IN_PROVIDER_CATALOG[0];
      const resolution = resolveProviderCatalog(BUILT_IN_PROVIDER_CATALOG, {
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [
          {
            id: builtIn.id,
            patch: { model: { persistedId: model } },
          },
        ],
      });
      const backends = projectClaudeCodeBackends(resolution);

      expect(backends.some((backend) => backend.id === builtIn.id)).toBe(false);
      expect(
        resolveClaudeCodeBackendFromModelInCatalog(resolution, backends, model)
      ).toBeUndefined();
    }
  );

  it("fails closed on the old persisted model after a same-namespace built-in repoint attempt", () => {
    // This rule is specific to *built-in* identities: the fail-closed check
    // compares the live entry against BUILT_IN_PROVIDER_CATALOG, so a fixture
    // would not exercise it.
    const builtIn = BUILT_IN_PROVIDER_CATALOG[0];
    const oldModel = builtIn.model.persistedId;
    const validResolution = resolveProviderCatalog(
      BUILT_IN_PROVIDER_CATALOG,
      undefined
    );
    const resolution = {
      ...validResolution,
      entries: validResolution.entries.map((entry) =>
        entry.id === builtIn.id
          ? {
              ...entry,
              model: {
                ...entry.model,
                persistedId: "claude-code:ollama-repointed-profile",
                providerModelId: "repointed:cloud",
              },
            }
          : entry
      ),
    } as typeof validResolution;
    const backends = projectClaudeCodeBackends(resolution);

    // A stale persisted id must never quietly degrade to an Anthropic session
    // just because its built-in entry was repointed underneath it.
    expect(() =>
      resolveClaudeCodeBackendFromModelInCatalog(resolution, backends, oldModel)
    ).toThrow("no longer owned by its built-in catalog entry");
  });

  it("keeps invalid-id overlay and legacy entry errors isolated from unrelated catalog launches", () => {
    const unrelated = LEGACY_PROXY_CATALOG[1];
    const resolutions = [
      resolveProviderCatalog(LEGACY_PROXY_CATALOG, {
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [{ id: "BAD ID", patch: { displayName: "Rejected" } }],
      }),
      resolveProviderCatalog(LEGACY_PROXY_CATALOG, undefined, [
        {
          scope: "entry",
          index: 0,
          code: "invalid-entry",
          message: "Malformed legacy entry was skipped.",
        },
      ]),
    ];

    for (const resolution of resolutions) {
      expect(resolution.fatalErrors).toEqual([]);
      const backends = projectClaudeCodeBackends(resolution);
      expect(
        resolveClaudeCodeBackendInCatalog(resolution, backends, unrelated.id)
          ?.id
      ).toBe(unrelated.id);
    }
  });

  it.each([
    ["endpoint", "https://proxy.example/v1/sk-placeholder-material/.."],
    ["endpoint", "https://proxy.example/v1%2fsk%2dplaceholder%2dmaterial%2f.."],
    [
      "upstreamEndpoint",
      "https://upstream.example/v1/SK-PLACEHOLDER-MATERIAL/%252e%252e",
    ],
    [
      "upstreamEndpoint",
      String.raw`https://upstream.example/v1\sk-placeholder-material\..`,
    ],
  ])(
    "does not project or resolve a backend with normalization-obscured credential-bearing %s path material",
    (field, value) => {
      const builtIn = BUILT_IN_PROVIDER_CATALOG[0];
      const resolution = resolveProviderCatalog(BUILT_IN_PROVIDER_CATALOG, {
        schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
        entries: [
          {
            id: builtIn.id,
            patch: {
              interfaces: [{ ...builtIn.interfaces[0], [field]: value }],
            },
          },
        ],
      });
      const backends = projectClaudeCodeBackends(resolution);

      expect(backends.some((backend) => backend.id === builtIn.id)).toBe(false);
      expect(() =>
        resolveClaudeCodeBackendFromModelInCatalog(
          resolution,
          backends,
          builtIn.model.persistedId
        )
      ).toThrow("reviewed credential-free proxy base path");
    }
  );
});
