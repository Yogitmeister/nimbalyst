// [ASTRA-ORCH]
import { LOCAL_PROXY_CREDENTIAL_REF } from "./providerCatalogDefaults";
import { ClaudeCodeDeps } from "./dependencyInjection";
import {
  ProviderRuntimeRouteError,
  type ClaudeAgentRuntimeRouteBundle,
} from "./runtimeRouteResolver";

/**
 * This compatibility token belongs solely to the existing local proxy route.
 * All external provider credentials resolve through an injected named-reference
 * resolver and are never carried by catalog data, receipts, or logs.
 */
export const LOCAL_PROXY_AUTH_TOKEN = "sk-nim-local-proxy";

export interface ProviderRouteCredentialConfig {
  workspacePath?: string;
}

export function resolveProviderRouteCredential(
  credentialRef: string,
  config: ProviderRouteCredentialConfig
): string | undefined {
  const injected = ClaudeCodeDeps.providerCredentialResolver?.(credentialRef, {
    workspacePath: config.workspacePath,
  });
  if (injected) return injected;
  if (credentialRef === LOCAL_PROXY_CREDENTIAL_REF) {
    return LOCAL_PROXY_AUTH_TOKEN;
  }
  return undefined;
}

export function getProviderRouteCredentialPresence(
  credentialRefs: readonly string[],
  config: ProviderRouteCredentialConfig
): Readonly<Record<string, boolean>> {
  return Object.freeze(
    Object.fromEntries(
      credentialRefs.map((credentialRef) => [
        credentialRef,
        resolveProviderRouteCredential(credentialRef, config) !== undefined,
      ])
    )
  );
}

export interface ConfirmedProviderRuntimeCredentials {
  main: string;
  subagent: string;
}

/**
 * Resolve every credential required by one provider turn before any launch
 * mutation. Distinct references are read once so rotation cannot split the
 * lead and subagent material inside one confirmed turn.
 */
export function preflightProviderRuntimeCredentials(
  routes: Readonly<ClaudeAgentRuntimeRouteBundle>,
  config: ProviderRouteCredentialConfig = {}
): Readonly<ConfirmedProviderRuntimeCredentials> {
  const mainPlan = routes.main;
  const subagentPlan = routes.subagent;
  if (
    mainPlan.selectedInterface.endpoint !==
      subagentPlan.selectedInterface.endpoint ||
    mainPlan.selectedInterface.credentialRef !==
      subagentPlan.selectedInterface.credentialRef
  ) {
    throw new ProviderRuntimeRouteError(
      "adapter-required",
      `Provider route ${mainPlan.model.catalogEntryId} requires an adapter for a subagent interface that differs from the lead process.`,
      mainPlan.model.catalogEntryId
    );
  }

  const resolved = new Map<string, string>();
  const credentialFor = (credentialRef: string, catalogEntryId: string) => {
    const cached = resolved.get(credentialRef);
    if (cached) return cached;
    const credential = resolveProviderRouteCredential(credentialRef, config);
    if (!credential) {
      throw new ProviderRuntimeRouteError(
        "credential-unavailable",
        `Provider route ${catalogEntryId} credential is unavailable before launch mutation.`,
        catalogEntryId
      );
    }
    resolved.set(credentialRef, credential);
    return credential;
  };

  return Object.freeze({
    main: credentialFor(
      mainPlan.selectedInterface.credentialRef,
      mainPlan.model.catalogEntryId
    ),
    subagent: credentialFor(
      subagentPlan.selectedInterface.credentialRef,
      subagentPlan.model.catalogEntryId
    ),
  });
}
