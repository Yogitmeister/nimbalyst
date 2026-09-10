// [ASTRA-ORCH]
import path from 'path';
import { resolveProjectPath } from '../utils/workspaceDetection';

export interface TargetWorkspaceBindingArgs {
  targetWorkspacePath?: unknown;
}

export function resolveTargetWorkspaceBinding(
  callerWorkspacePath: string,
  args?: TargetWorkspaceBindingArgs,
): string {
  const requestedPath = args?.targetWorkspacePath;
  if (requestedPath === undefined) {
    return resolveProjectPath(callerWorkspacePath);
  }
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new Error('targetWorkspacePath must be a non-empty string when provided');
  }
  if (!path.isAbsolute(requestedPath.trim())) {
    throw new Error('targetWorkspacePath must be absolute');
  }
  const resolvedPath = resolveProjectPath(requestedPath.trim());
  if (!resolvedPath) {
    throw new Error('targetWorkspacePath could not be resolved');
  }
  return resolvedPath;
}
