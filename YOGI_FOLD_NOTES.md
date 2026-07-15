# Yogi fold notes -- yogi/fold-v0.69.1-20260715

Personal build branch: upstream/main (v0.69.1, 49aae5bc7) + 5 patches
already submitted upstream as separate PRs. Drop each patch from the next
fold once its PR merges (upstream/main will then already contain it --
re-cherry-picking would conflict/no-op).

| Patch | Upstream PR | Upstream issue | Commits (this branch) |
|---|---|---|---|
| Bound originalPrompt in child-session notifications | nimbalyst/nimbalyst#875 | #874 | 9fe500db6, ed7f4a431 |
| Remove unused import (sqlite-browser) | #876 | -- | 6e5de40b1 |
| Windows pre-push gate fix (prereq build, real exclusion mechanism, concurrency cap) | #879 | #878 | bdede0d0d |
| Compact mode for get_session_result | #882 | #881 | a82190842 |
| Worktree identity via real git metadata (permission-cascade trust boundary) | #884 | #883 | 4b9a62f68 |

Also filed, not a code patch: nimbalyst/nimbalyst#877 -- a test-isolation
bug in GitWorktreeService.test.ts that can write real commits into the
actual checked-out repo under Windows concurrency. Found during this
fold's verification; not fixed here.

## Next fold procedure

1. git fetch upstream main
2. For each row above still open, cherry-pick its commit(s) onto a fresh
   branch off upstream/main. Skip merged rows -- resolve/drop this file
   if a fetched commit's content is now byte-identical to upstream.
3. Re-run npx tsc --noEmit -p packages/electron/tsconfig.json on the
   combined result before treating the fold as good.
4. Update this table's PR-state column (merged rows can be deleted).
