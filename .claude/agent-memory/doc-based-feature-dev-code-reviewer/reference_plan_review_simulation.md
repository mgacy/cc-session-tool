---
name: plan-review-simulation
description: Claude project-dir fixtures built under the session scratchpad exceed 200 sanitized chars, so hand-built project names there are wrong
metadata:
  type: reference
---

The session scratchpad path (`/private/tmp/claude-501/<encoded cwd>/<uuid>/scratchpad`) sanitizes to more than 200 chars. Claude project-dir names for fixture repos created under it therefore go through truncation plus a hash suffix. A hand-built `${mangleProjectPath(repo)}--claude-worktrees-x` worktree name will not match the real encoding of the worktree path.

**Why:** in the task 014 plan review, a CLI simulation with hand-built fixture names under the scratchpad failed with `NOT_FOUND`. The expected basename ended in one hash suffix and the on-disk dirs in another. It took a diagnostic run to see that truncation was the cause.

**How to apply:** when building Claude project fixtures in the scratchpad, derive every name, worktrees included, by calling the encoder on the full path (`bun -e "import {mangleProjectPath} from './src/project-selection.ts'; console.log(mangleProjectPath(process.argv[1]))" "$path"`), or build the fixtures under a short root. See [[cc-session-tool-encoder-parity]].
