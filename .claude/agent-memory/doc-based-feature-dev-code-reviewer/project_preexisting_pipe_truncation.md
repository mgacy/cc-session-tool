---
name: preexisting-pipe-truncation
description: Large JSON output (seen on `list --all-projects --project-glob <typo>`) truncates at ~64KB when stdout is a pipe; pre-existing at d9c8e0c, not caused by #13
metadata:
  type: project
---

When stdout is a pipe, `bun run index.ts list --all-projects --project-glob=-nonexistent-zz | wc -c` gives 65536–65537 bytes; redirecting to a file gives the full ~220KB (re-checked 2026-11-22). `projects | wc -c` (~557KB) was reported not truncated, so it looks command/path-specific. Identical on a `git archive` copy of HEAD d9c8e0c, so it predates the strict-args change.

**Why:** A work-unit executor hit unparseable piped JSON and had to diff against a HEAD copy to rule out its own change; it is easy to misattribute to whatever diff is under review.
**How to apply:** Redirect large output to a file instead of piping when checking it by hand, and don't blame the diff under review for this truncation. Delete this memory once the behaviour is fixed. Related: [[bun-test-filter-gotcha]].
