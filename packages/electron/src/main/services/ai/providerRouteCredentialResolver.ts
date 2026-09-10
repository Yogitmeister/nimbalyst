// [ASTRA-ORCH]
import fs from "fs";
import os from "os";
import path from "path";
import {
  CLAUDEX_INGRESS_CREDENTIAL_REF,
  DEEPSEEK_API_CREDENTIAL_REF,
  OLLAMA_API_CREDENTIAL_REF,
  OPENROUTER_API_CREDENTIAL_REF,
} from "@nimbalyst/runtime/ai/server/providers/claudeCode/providerCatalogDefaults";
import { getProviderApiKeyFromSettings } from "../../utils/store";
import { readWorkspaceEnvValue } from "./workspaceEnvCredentials";

export interface ProviderRouteCredentialHostDeps {
  readTextFile(filePath: string): string | undefined;
  getProviderApiKey(providerId: string, workspacePath?: string): string | null;
  getClaudexRoot(): string;
}

function defaultClaudexRoot(): string {
  const configured = process.env.CLAUDEX_HOME?.trim();
  if (configured) return configured;
  return path.join("D:/Users", os.userInfo().username, "Claudex");
}

const DEFAULT_DEPS: ProviderRouteCredentialHostDeps = {
  readTextFile: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return undefined;
    }
  },
  getProviderApiKey: (providerId, workspacePath) =>
    getProviderApiKeyFromSettings(providerId, workspacePath),
  getClaudexRoot: defaultClaudexRoot,
};

/**
 * Environment variable that may supply each brain-swap route's key, read from
 * the **workspace `.env` file only**.
 *
 * Scope is deliberate and narrow. The rule this relaxes exists because an
 * ambient `ANTHROPIC_API_KEY` was once picked up and billed a user's personal
 * account $100+ — the hazard there was a credential silently changing the
 * *default* route's billing. These references can only ever be reached by a
 * route the user explicitly selected in the picker, each maps to exactly one
 * provider's own variable, and none of them can reach Anthropic. Claudex is
 * absent on purpose: it has a dedicated ACL-restricted ingress-token file.
 *
 * `process.env` is NOT consulted — only the workspace file — so a variable
 * inherited from whatever launched the app cannot become a credential.
 */
const CATALOG_ROUTE_ENV_VARIABLES: Readonly<Record<string, string>> = {
  [DEEPSEEK_API_CREDENTIAL_REF]: 'DEEPSEEK_API_KEY',
  [OPENROUTER_API_CREDENTIAL_REF]: 'OPENROUTER_API_KEY',
  [OLLAMA_API_CREDENTIAL_REF]: 'OLLAMA_API_KEY',
};

/**
 * Resolve only the reviewed named references owned by the Electron host.
 *
 * Brain-swap provider keys come from explicit Nimbalyst provider settings
 * first, then the workspace `.env` (see CATALOG_ROUTE_ENV_VARIABLES for why
 * that is safe here). Claudex uses its dedicated ACL-restricted ingress-token
 * file. No process-env fallback, interactive auth, logging, or catalog value is
 * permitted.
 */
export function createProviderRouteCredentialResolver(
  deps: Partial<ProviderRouteCredentialHostDeps> = {}
): (
  credentialRef: string,
  context?: Readonly<{ workspacePath?: string }>
) => string | undefined {
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  const settingsProviderId: Readonly<Record<string, string>> = {
    [DEEPSEEK_API_CREDENTIAL_REF]: "deepseek",
    [OPENROUTER_API_CREDENTIAL_REF]: "openrouter",
    [OLLAMA_API_CREDENTIAL_REF]: "ollama",
  };
  return (credentialRef, context) => {
    const providerId = settingsProviderId[credentialRef];
    if (providerId) {
      const configured = resolvedDeps
        .getProviderApiKey(providerId, context?.workspacePath)
        ?.trim();
      if (configured) return configured;
      // Settings win; the workspace file is the fallback so a user who already
      // keeps the key in .env does not have to re-enter it to use the route.
      return readWorkspaceEnvValue(
        context?.workspacePath,
        CATALOG_ROUTE_ENV_VARIABLES[credentialRef],
        resolvedDeps.readTextFile,
      );
    }
    if (credentialRef === CLAUDEX_INGRESS_CREDENTIAL_REF) {
      const root = path.resolve(resolvedDeps.getClaudexRoot());
      const credentialPath = path.join(root, "secrets", "ingress.token");
      const value = resolvedDeps.readTextFile(credentialPath)?.trim();
      return value && value.length >= 40 ? value : undefined;
    }
    return undefined;
  };
}
