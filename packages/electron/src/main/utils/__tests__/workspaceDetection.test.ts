import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveProjectPath,
  isWorktreePath,
  findNearestAncestor,
  findProjectRoot,
  filterClaudeCatalogDuplicateDirectories,
  getAdditionalDirectoriesForWorkspace,
  getClaudeAdditionalDirectoriesForWorkspace,
} from '../workspaceDetection';

describe('resolveProjectPath', () => {
  it('returns the same path for regular workspaces', () => {
    expect(resolveProjectPath('/path/to/project')).toBe('/path/to/project');
    expect(resolveProjectPath('/Users/dev/my-app')).toBe('/Users/dev/my-app');
    expect(resolveProjectPath('/home/user/code/myrepo')).toBe('/home/user/code/myrepo');
  });

  it('resolves worktree paths to parent project', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/swift-falcon'))
      .toBe('/path/to/project');
    expect(resolveProjectPath('/Users/dev/my-app_worktrees/brave-eagle'))
      .toBe('/Users/dev/my-app');
    expect(resolveProjectPath('/home/user/code/myrepo_worktrees/test-123'))
      .toBe('/home/user/code/myrepo');
  });

  it('resolves NESTED worktree paths (branch-style names) to parent project', () => {
    // Regression for re-prompting in worktrees whose branch name contains a
    // slash (e.g. `feature/foo`), which create nested directories.
    expect(resolveProjectPath('/path/to/project_worktrees/feature/my-branch'))
      .toBe('/path/to/project');
    expect(resolveProjectPath('/Users/dev/Belegify_worktrees/feature/assign-people-on-receipts'))
      .toBe('/Users/dev/Belegify');
    expect(resolveProjectPath('/Users/dev/nimbalyst_worktrees/improvement/fix-askme-for-worktrees'))
      .toBe('/Users/dev/nimbalyst');
  });

  it('resolves a subfolder inside a nested worktree to the parent project', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/feature/my-branch/packages/electron'))
      .toBe('/path/to/project');
  });

  it('resolves nested worktrees with underscore project names', () => {
    expect(resolveProjectPath('/path/to/my_cool_project_worktrees/feature/x'))
      .toBe('/path/to/my_cool_project');
  });

  it('handles trailing slashes on nested worktree paths', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/feature/my-branch/'))
      .toBe('/path/to/project');
  });

  it('does not resolve a plain subfolder of a non-worktree project (the permission cascade handles that)', () => {
    expect(resolveProjectPath('/path/to/project/packages/electron'))
      .toBe('/path/to/project/packages/electron');
  });

  it('handles trailing slashes on worktree paths', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/swift-falcon/'))
      .toBe('/path/to/project');
    expect(resolveProjectPath('/path/to/project_worktrees/swift-falcon//'))
      .toBe('/path/to/project');
  });

  it('does not match paths that just contain _worktrees in the middle', () => {
    // This path has _worktrees in it but is not a worktree path pattern
    expect(resolveProjectPath('/path/to/project_worktrees_backup/folder'))
      .toBe('/path/to/project_worktrees_backup/folder');
  });

  it('handles empty and null-ish inputs gracefully', () => {
    expect(resolveProjectPath('')).toBe('');
    expect(resolveProjectPath(null as unknown as string)).toBe(null);
    expect(resolveProjectPath(undefined as unknown as string)).toBe(undefined);
  });

  it('handles complex project names with underscores', () => {
    expect(resolveProjectPath('/path/to/my_cool_project_worktrees/branch-1'))
      .toBe('/path/to/my_cool_project');
  });

  it('handles Windows-style paths', () => {
    // Note: Our regex uses / which works on Windows when paths are normalized
    // but if someone passes backslashes, it won't match (that's okay)
    expect(resolveProjectPath('C:/Users/dev/project_worktrees/feature'))
      .toBe('C:/Users/dev/project');
  });
});

describe('isWorktreePath', () => {
  it('returns false for regular workspaces', () => {
    expect(isWorktreePath('/path/to/project')).toBe(false);
    expect(isWorktreePath('/Users/dev/my-app')).toBe(false);
    expect(isWorktreePath('/home/user/code/myrepo')).toBe(false);
  });

  it('returns true for worktree paths', () => {
    expect(isWorktreePath('/path/to/project_worktrees/swift-falcon')).toBe(true);
    expect(isWorktreePath('/Users/dev/my-app_worktrees/brave-eagle')).toBe(true);
    expect(isWorktreePath('/home/user/code/myrepo_worktrees/test-123')).toBe(true);
  });

  it('returns true for NESTED worktree paths (branch-style names)', () => {
    expect(isWorktreePath('/path/to/project_worktrees/feature/my-branch')).toBe(true);
    expect(isWorktreePath('/Users/dev/Belegify_worktrees/feature/assign-people')).toBe(true);
    expect(isWorktreePath('/path/to/project_worktrees/feature/my-branch/packages/electron')).toBe(true);
  });

  it('does not match the _worktrees_backup decoy with nested children', () => {
    expect(isWorktreePath('/path/to/project_worktrees_backup/feature/x')).toBe(false);
  });

  it('handles trailing slashes', () => {
    expect(isWorktreePath('/path/to/project_worktrees/swift-falcon/')).toBe(true);
  });

  it('handles empty and null-ish inputs gracefully', () => {
    expect(isWorktreePath('')).toBe(false);
    expect(isWorktreePath(null as unknown as string)).toBe(false);
    expect(isWorktreePath(undefined as unknown as string)).toBe(false);
  });

  it('does not match paths that just contain _worktrees in the middle', () => {
    expect(isWorktreePath('/path/to/project_worktrees_backup/folder')).toBe(false);
  });
});

describe('getAdditionalDirectoriesForWorkspace', () => {
  let tmpRoot: string;
  let projectPath: string;
  let worktreesDir: string;

  beforeEach(() => {
    // Real filesystem fixture so the sync fs.readdirSync path is exercised
    // end-to-end. The function is called from a synchronous loader and must
    // tolerate a missing _worktrees dir without blowing up.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-add-dirs-'));
    projectPath = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectPath);
    worktreesDir = path.join(tmpRoot, 'project_worktrees');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty list for a project with no worktrees and no extension marker', () => {
    expect(getAdditionalDirectoriesForWorkspace(projectPath)).toEqual([]);
  });

  it('returns sibling worktree paths when called from the parent project root', () => {
    fs.mkdirSync(worktreesDir);
    fs.mkdirSync(path.join(worktreesDir, 'proud-gorge'));
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(projectPath);
    expect(dirs.sort()).toEqual([
      path.join(worktreesDir, 'proud-gorge'),
      path.join(worktreesDir, 'swift-falcon'),
    ].sort());
  });

  it('returns the parent project plus other sibling worktrees when called from a worktree', () => {
    fs.mkdirSync(worktreesDir);
    const cwd = path.join(worktreesDir, 'proud-gorge');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(cwd);
    expect(dirs.sort()).toEqual([
      projectPath,
      path.join(worktreesDir, 'swift-falcon'),
    ].sort());
    // The current worktree itself must not appear -- it is already the
    // workingDirectory, and re-listing it would just add noise.
    expect(dirs).not.toContain(cwd);
  });

  it('survives a missing _worktrees directory', () => {
    // No worktrees dir created. Should not throw, just return empty.
    expect(getAdditionalDirectoriesForWorkspace(projectPath)).toEqual([]);
  });

  it('excludes sibling worktrees when includeSiblingWorktrees is false (project root)', () => {
    // The Claude Code loader opts out: the CLI discovers .claude/commands
    // skills in every additional directory, so N sibling worktrees inflate the
    // system prompt with N duplicate copies of every project skill.
    fs.mkdirSync(worktreesDir);
    fs.mkdirSync(path.join(worktreesDir, 'proud-gorge'));
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(projectPath, {
      includeSiblingWorktrees: false,
    });
    expect(dirs).toEqual([]);
  });

  it('keeps the parent project but drops siblings when includeSiblingWorktrees is false (worktree)', () => {
    fs.mkdirSync(worktreesDir);
    const cwd = path.join(worktreesDir, 'proud-gorge');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(cwd, {
      includeSiblingWorktrees: false,
    });
    // Parent project access (shared configs, .git common dir) must survive.
    expect(dirs).toEqual([projectPath]);
  });
});

describe('Claude workflow catalog directory scopes', () => {
  let tmpRoot: string;
  let projectPath: string;
  let worktreePath: string;

  const writeCommand = (root: string, name: string) => {
    const commandDir = path.join(root, '.claude', 'commands');
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, `${name}.md`), `---\ndescription: ${name}\n---\n`);
  };

  const writeSkill = (root: string, name: string) => {
    const skillDir = path.join(root, '.claude', 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  };

  const collectCatalog = (roots: string[]) => roots.flatMap((root) => {
    const entries: Array<{ kind: 'command' | 'skill'; name: string; sourceRoot: string }> = [];
    const commandsDir = path.join(root, '.claude', 'commands');
    if (fs.existsSync(commandsDir)) {
      for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          entries.push({ kind: 'command', name: path.basename(entry.name, '.md'), sourceRoot: root });
        }
      }
    }
    const skillsDir = path.join(root, '.claude', 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
          entries.push({ kind: 'skill', name: entry.name, sourceRoot: root });
        }
      }
    }
    return entries;
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-claude-catalog-scopes-'));
    projectPath = path.join(tmpRoot, 'project');
    worktreePath = path.join(tmpRoot, 'project_worktrees', 'fresh-worktree');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('keeps one project catalog for both main-checkout and worktree Claude sessions', () => {
    for (const root of [projectPath, worktreePath]) {
      writeCommand(root, 'repair');
      writeSkill(root, 'review');
    }

    const previousWorktreeRoots = [
      worktreePath,
      ...getAdditionalDirectoriesForWorkspace(worktreePath, { includeSiblingWorktrees: false }),
    ];
    const previousWorktreeCatalog = collectCatalog(previousWorktreeRoots);
    expect(previousWorktreeCatalog).toHaveLength(4);
    expect(previousWorktreeCatalog.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'command:repair',
      'skill:review',
      'command:repair',
      'skill:review',
    ]);

    const mainCatalog = collectCatalog([
      projectPath,
      ...getClaudeAdditionalDirectoriesForWorkspace(projectPath),
    ]);
    const worktreeCatalog = collectCatalog([
      worktreePath,
      ...getClaudeAdditionalDirectoriesForWorkspace(worktreePath),
    ]);

    expect(mainCatalog.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'command:repair',
      'skill:review',
    ]);
    expect(worktreeCatalog.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'command:repair',
      'skill:review',
    ]);
  });

  it('preserves same-looking entries from a distinct source while removing same-project scopes', () => {
    const siblingPath = path.join(tmpRoot, 'project_worktrees', 'sibling');
    const externalRoot = path.join(tmpRoot, 'external-workflows');
    fs.mkdirSync(siblingPath, { recursive: true });
    fs.mkdirSync(externalRoot, { recursive: true });

    writeCommand(worktreePath, 'review');
    writeCommand(projectPath, 'review');
    writeCommand(siblingPath, 'review');
    writeSkill(externalRoot, 'review');

    const filtered = filterClaudeCatalogDuplicateDirectories(worktreePath, [
      projectPath,
      siblingPath,
      externalRoot,
    ]);
    expect(filtered).toEqual([externalRoot]);

    const catalog = collectCatalog([worktreePath, ...filtered]);
    expect(catalog.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'command:review',
      'skill:review',
    ]);
  });

  it('normalizes Windows case and separators when comparing catalog provenance', () => {
    expect(filterClaudeCatalogDuplicateDirectories(
      'C:\\Repos\\Project_worktrees\\Fresh',
      [
        'c:/repos/project',
        'C:\\REPOS\\PROJECT_WORKTREES\\Sibling',
        'D:\\Repos\\Project',
      ],
    )).toEqual(['D:\\Repos\\Project']);
  });
});

describe('findNearestAncestor', () => {
  const trusted = new Set(['/path/to/project']);
  const pred = (dir: string) => trusted.has(dir);

  it('returns the start path itself when it matches', () => {
    expect(findNearestAncestor('/path/to/project', pred)).toBe('/path/to/project');
  });

  it('walks up to the nearest matching ancestor (subfolder cascade)', () => {
    expect(findNearestAncestor('/path/to/project/packages/electron', pred))
      .toBe('/path/to/project');
    expect(findNearestAncestor('/path/to/project/src', pred)).toBe('/path/to/project');
  });

  it('returns null when no ancestor matches', () => {
    expect(findNearestAncestor('/some/other/place', pred)).toBe(null);
  });

  it('returns the most specific matching ancestor when several match', () => {
    const t2 = new Set(['/a', '/a/b/c']);
    expect(findNearestAncestor('/a/b/c/d', (d) => t2.has(d))).toBe('/a/b/c');
  });

  it('handles empty input and trailing slashes', () => {
    expect(findNearestAncestor('', pred)).toBe(null);
    expect(findNearestAncestor('/path/to/project/packages/', pred)).toBe('/path/to/project');
  });

  describe('stopAt boundary', () => {
    it('still returns a match found at or below the boundary', () => {
      // boundary === the matching ancestor: it is tested, then the walk stops.
      expect(findNearestAncestor('/path/to/project/src', pred, '/path/to/project'))
        .toBe('/path/to/project');
    });

    it('does NOT climb past the boundary to a higher match', () => {
      // A trusted grandparent must not be inherited when a nearer boundary caps
      // the walk - this is the trust-boundary guard for nested projects.
      const t = new Set(['/root']);
      const p = (d: string) => t.has(d);
      expect(findNearestAncestor('/root/child/leaf', p, '/root/child')).toBe(null);
    });

    it('returns the nearer match even when a farther one also matches', () => {
      const t = new Set(['/root', '/root/child']);
      const p = (d: string) => t.has(d);
      expect(findNearestAncestor('/root/child/leaf', p, '/root/child')).toBe('/root/child');
    });
  });
});

describe('findProjectRoot', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-projroot-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // findProjectRoot returns the normalized INPUT path (it does not resolve
  // symlinks), so compare against the input, not realpathSync.
  it('returns the start path when it is itself a git repo root', () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    expect(findProjectRoot(tmpRoot)).toBe(tmpRoot);
  });

  it('walks up to the nearest git repo root from a subfolder', () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    const sub = path.join(tmpRoot, 'packages', 'electron');
    fs.mkdirSync(sub, { recursive: true });
    expect(findProjectRoot(sub)).toBe(tmpRoot);
  });

  it('stops at a nested repo root rather than the outer repo (fresh-clone case)', () => {
    // Outer repo contains an independent nested repo with its own .git.
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    const nested = path.join(tmpRoot, 'vendored-clone');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(findProjectRoot(nested)).toBe(nested);
  });

  it('recognizes a .git file (linked worktree) as a repo root', () => {
    fs.writeFileSync(path.join(tmpRoot, '.git'), 'gitdir: /somewhere/else');
    expect(findProjectRoot(tmpRoot)).toBe(tmpRoot);
  });

  it('returns null when no ancestor is a git repo', () => {
    const sub = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    // tmpRoot lives under the OS temp dir; none of it should be a git repo.
    expect(findProjectRoot(sub)).toBe(null);
  });
});
