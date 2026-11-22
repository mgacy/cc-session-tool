---
name: preexisting-pipe-truncation
description: Large JSON output (seen on `list --all-projects --project-glob <typo>`) truncates at ~64KB when stdout is a pipe; tracked as issue #21, not caused by #13
metadata:
  type: project
---

When stdout is a pipe, `bun run index.ts list --all-projects --project-glob=-nonexistent-zz --include-project-lists | wc -c` gives 65536–65537 bytes; redirecting to a file gives the full ~220KB (re-checked 2026-11-22). Since issue #17 the flag is needed: without `--include-project-lists` the default output is only a few hundred bytes, too small to trigger the truncation. `projects | wc -c` (~557KB, a pre-#17 size when `included_projects` was always emitted) was reported not truncated, so it looks command/path-specific. Identical on a `git archive` copy of HEAD d9c8e0c, so it predates the strict-args change.

**Why:** A work-unit executor hit unparseable piped JSON and had to diff against a HEAD copy to rule out its own change; it is easy to misattribute to whatever diff is under review.
**How to apply:** Redirect large output to a file instead of piping when checking it by hand, and don't blame the diff under review for this truncation. Delete this memory once issue #21 is fixed.
