---
name: bun-test-filter-gotcha
description: In this repo `bun test --filter` (as written in CLAUDE.md) is a file-path filter and runs nothing; use `bun test index.test.ts -t "<pattern>"` for targeted runs
metadata:
  type: reference
---

CLAUDE.md suggests `bun test --filter "shape"`, but on bun 1.3.5 `--filter` filters test *files*, and every test lives in `index.test.ts`. So `bun test --filter "parseCommandArgs"` matches no files and runs zero tests, printing only a "Tests need \".test\" … in the filename" note. To run a subset by test/describe name, use `bun test index.test.ts -t "<regex>"`.

**Why:** A work-unit executor followed CLAUDE.md, got no tests, and had to work out the right form (task 015, 2026-11-22).
**How to apply:** Use `-t` for targeted runs. Delete this memory once CLAUDE.md's command line is corrected.
