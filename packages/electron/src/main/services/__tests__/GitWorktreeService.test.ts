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

  async function configureOrigin(): Promise<string> {
    const remotePath = path.join(tmpDir, 'origin.git');
    fs.mkdirSync(remotePath);
    await simpleGit(remotePath).init(true);
    const git = simpleGit(projectPath);
    await git.addRemote('origin', remotePath);
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    await git.push(['-u', 'origin', branch]);
    return remotePath;
  }

  it('proves clean, merged, and pushed durability before removal', async () => {
    await configureOrigin();
    const worktree = await service.createWorktree(projectPath, { name: 'durable-child' });

    const readiness = await service.verifyWorktreeRemovalReadiness(projectPath, worktree);

    expect(readiness.head).toBe(readiness.projectHead);
    expect(readiness.remoteRefsContainingHead).toContain(
      `refs/remotes/origin/${worktree.baseBranch}`,
    );
  });

  it('rejects a dirty worktree even when its current HEAD is durable', async () => {
    await configureOrigin();
    const worktree = await service.createWorktree(projectPath, { name: 'dirty-child' });
    fs.writeFileSync(path.join(worktree.path, 'dirty.txt'), 'not committed');

    await expect(
      service.verifyWorktreeRemovalReadiness(projectPath, worktree),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it('rejects a clean checkout with an in-progress Git operation', async () => {
    await configureOrigin();
    const worktree = await service.createWorktree(projectPath, { name: 'rebasing-child' });
    const gitDir = (await simpleGit(worktree.path).revparse(['--absolute-git-dir'])).trim();
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));

    await expect(
      service.verifyWorktreeRemovalReadiness(projectPath, worktree),
    ).rejects.toThrow(/in-progress Git operation \(rebase\)/);
  });

  it('rejects a pushed worktree HEAD that is not merged into its base', async () => {
    await configureOrigin();
    const worktree = await service.createWorktree(projectPath, { name: 'unmerged-child' });
    const worktreeGit = simpleGit(worktree.path);
    fs.writeFileSync(path.join(worktree.path, 'feature.txt'), 'feature');
    await worktreeGit.add('feature.txt');
    await worktreeGit.commit('feature');
    await worktreeGit.push(['-u', 'origin', worktree.branch]);

    await expect(
      service.verifyWorktreeRemovalReadiness(projectPath, worktree),
    ).rejects.toThrow(/not merged/);
  });

  it('rejects a locally merged worktree HEAD that is not pushed', async () => {
    await configureOrigin();
    const worktree = await service.createWorktree(projectPath, { name: 'unpushed-child' });
    const worktreeGit = simpleGit(worktree.path);
    fs.writeFileSync(path.join(worktree.path, 'local-only.txt'), 'local');
    await worktreeGit.add('local-only.txt');
    await worktreeGit.commit('local only');
    await simpleGit(projectPath).merge([worktree.branch, '--ff-only']);

    await expect(
      service.verifyWorktreeRemovalReadiness(projectPath, worktree),
    ).rejects.toThrow(/not present on any remote-tracking ref/);
  });

  it('prunes a deleted remote branch instead of trusting its stale tracking ref', async () => {
    const remotePath = await configureOrigin();
    const worktree = await service.createWorktree(projectPath, { name: 'stale-remote-child' });
    const worktreeGit = simpleGit(worktree.path);
    fs.writeFileSync(path.join(worktree.path, 'stale-remote.txt'), 'durability proof');
    await worktreeGit.add('stale-remote.txt');
    await worktreeGit.commit('stale remote proof');
    await worktreeGit.push(['-u', 'origin', worktree.branch]);
    await simpleGit(projectPath).merge([worktree.branch, '--ff-only']);

    const staleRef = `refs/remotes/origin/${worktree.branch}`;
    expect((await simpleGit(projectPath).raw(['show-ref', '--verify', staleRef])).trim()).not.toBe('');
    await simpleGit(remotePath).raw(['update-ref', '-d', `refs/heads/${worktree.branch}`]);

    await expect(
      service.verifyWorktreeRemovalReadiness(projectPath, worktree),
    ).rejects.toThrow(/not present on any remote-tracking ref/);
    await expect(simpleGit(projectPath).raw(['show-ref', '--verify', staleRef])).rejects.toThrow();
  });

  it('removes only after revalidation and retains the committed branch', async () => {
    await configureOrigin();
    const worktree = await service.createWorktree(projectPath, { name: 'safe-remove-child' });

    await service.deleteWorktreeSafely(
      worktree.path,
      projectPath,
      () => service.verifyWorktreeRemovalReadiness(projectPath, worktree),
    );

    expect(fs.existsSync(worktree.path)).toBe(false);
    expect((await service.listWorktrees(projectPath)).some((entry) =>
      comparable(entry.path) === comparable(worktree.path))).toBe(false);
    expect((await simpleGit(projectPath).branchLocal()).all).toContain(worktree.branch);
  });
});
