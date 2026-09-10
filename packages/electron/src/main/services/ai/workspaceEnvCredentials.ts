// [ASTRA-ORCH]
import fs from "fs";
import path from "path";
import { getProviderApiKeyFromSettings, getRecentItems } from "../../utils/store";

/**
 * Provider keys for brain-swap routes and their usage meters, resolved from
 * Nimbalyst settings first and the workspace `.env` second.
 *
 * WHY A FILE FALLBACK IS SAFE HERE. Nimbalyst deliberately refuses to pick up
 * ambient API keys: a user's `.env` ANTHROPIC_API_KEY was once inherited and
 * billed their personal account $100+. That hazard is a credential silently
 * changing the *default* route's billing. Everything resolved through this
 * module is different in kind:
 *
 *   - it is reached only by a route the user explicitly selected, or by that
 *     provider's own usage meter,
 *   - each provider maps to exactly one variable of its own name, and
 *   - none of them can reach Anthropic.
 *
 * `process.env` is never consulted -- only the workspace file -- so a variable
 * inherited from whatever launched the app cannot become a credential.
 *
 * Values are never logged. Callers get the secret or `undefined`, nothing else.
 */

/** Read one named assignment out of a `.env`. Returns undefined, never throws. */
export function readWorkspaceEnvValue(
  workspacePath: string | undefined,
  variableName: string,
  readTextFile: (filePath: string) => string | undefined = defaultReadTextFile,
): string | undefined {
  if (!workspacePath) return undefined;
  const contents = readTextFile(path.join(workspacePath, ".env"));
  if (!contents) return undefined;
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== variableName) continue;
    let value = match[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function defaultReadTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Settings key if one is configured, else the workspace `.env`.
 *
 * `workspacePath` is omitted by app-global callers such as the usage meters,
 * which have no session context. Those fall back to the most recently opened
 * workspace -- the same one whose `.env` the user is working against -- rather
 * than scanning every workspace they have ever opened.
 */
export function resolveProviderCredential(
  providerId: string,
  variableName: string,
  workspacePath?: string,
): string | undefined {
  const configured = getProviderApiKeyFromSettings(providerId, workspacePath)?.trim();
  if (configured) return configured;

  const searchPath = workspacePath ?? mostRecentWorkspacePath();
  return readWorkspaceEnvValue(searchPath, variableName);
}

function mostRecentWorkspacePath(): string | undefined {
  try {
    const recent = getRecentItems("workspaces");
    return recent.length > 0 ? recent[0].path : undefined;
  } catch {
    return undefined;
  }
}
