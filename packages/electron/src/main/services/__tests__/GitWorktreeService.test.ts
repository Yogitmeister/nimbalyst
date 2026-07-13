import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import simpleGit from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GitWorktreeService, WorkspaceHasNoCommitsError } from '../GitWorktreeService';

/**
 * Regression coverage for the empty-repo silent-failure case: when a Blitz
 * is run against a `git init`-ed-but-never-committed workspace, the worktree
 * service used to throw the raw "fatal: ambiguous argument 'HEAD'" stderr and
 * the renderer dismissed the dialog as if the call succeeded. The service now
 * pre-flights with `git rev-parse --verify HEAD` and throws a typed error.
 */
describe('GitWorktreeService.validateWorkspaceHasCommits', () => {
  let tmpDir: string;
  const service = new GitWorktreeService();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-gws-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file-lock noise during teardown
    }
  });

  it('throws WorkspaceHasNoCommitsError for a `git init`-ed repo with no commits', async () => {
    const git = simpleGit(tmpDir);
    await git.init();

    await expect(service.validateWorkspaceHasCommits(tmpDir))
      .rejects
      .toBeInstanceOf(WorkspaceHasNoCommitsError);
  });

  it('resolves cleanly when the repo has at least one commit', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com', false, 'local');
    await git.addConfig('user.name', 'Test', false, 'local');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hi');
    await git.add('README.md');
    await git.commit('initial');

    await expect(service.validateWorkspaceHasCommits(tmpDir)).resolves.toBeUndefined();
  });

  it('throws when workspacePath is empty', async () => {
    await expect(service.validateWorkspaceHasCommits(''))
      .rejects
      .toThrow('workspacePath is required');
  });

  it('throws "Not a git repository" for a folder that was never `git init`-ed', async () => {
    // tmpDir exists but has no .git. Differentiates from the empty-repo case
    // so callers can show a remediation message that matches the real cause.
    await expect(service.validateWorkspaceHasCommits(tmpDir))
      .rejects
      .toThrow(/Not a git repository/);
  });
});

describe('GitWorktreeService.verifyWorktreeBinding', () => {
  let tmpDir: string;
  let projectPath: string;
  const service = new GitWorktreeService();
  const comparable = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-binding-test-'));
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath);
    const git = simpleGit(projectPath);
    await git.init();
    await git.addConfig('user.email', 'test@example.com', false, 'local');
    await git.addConfig('user.name', 'Test', false, 'local');
    fs.writeFileSync(path.join(projectPath, 'README.md'), 'binding test');
    await git.add('README.md');
    await git.commit('initial');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file-lock noise during teardown
    }
  });

  it('proves fresh project/worktree roots, Git dirs, branch, and HEAD identity', async () => {
    const worktree = await service.createWorktree(projectPath, { name: 'binding-child' });

    const identity = await service.verifyWorktreeBinding(projectPath, worktree, {
      requireProjectHeadMatch: true,
    });

    expect(comparable(identity.projectRoot)).toBe(comparable(fs.realpathSync(projectPath)));
    expect(comparable(identity.worktreeRoot)).toBe(comparable(fs.realpathSync(worktree.path)));
    expect(comparable(identity.gitDir)).not.toBe(comparable(identity.commonDir));
    expect(identity.branch).toBe(worktree.branch);
    expect(identity.head).toBe(identity.projectHead);
  });

  it('rejects a record whose branch no longer matches the registered checkout', async () => {
    const worktree = await service.createWorktree(projectPath, { name: 'binding-mismatch' });

    await expect(
      service.verifyWorktreeBinding(projectPath, { ...worktree, branch: 'worktree/not-this-one' })
    ).rejects.toThrow(/branch mismatch/);
  });
});
