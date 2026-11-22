---
name: cc-session-tool-encoder-parity
description: How to search the Claude Code native binary for the ground-truth project-dir encoder without a regex grep that stalls past the Bash timeout
metadata:
  type: reference
---

Ground truth for `mangleProjectPath` (algorithm: CLAUDE.md Key Design Decision 6) is the installed native binary at `~/.local/share/claude/versions/<ver>`, which `~/.local/bin/claude` symlinks to. On this machine `command -v claude` returns a cmux shell shim script, not the binary. Minified function names change with every build.

**Why:** a regex grep with context (`grep -a -o '.\{0,260\}replace(/\[^a-zA-Z0-9\]/g,"-").\{0,260\}'`) over the binary (at least ~350MB, judging by grep byte offsets) ran past the 120s Bash timeout. It later finished with no matches; the cause was not investigated. The fixed-string search below returned offsets on the first try.

**How to apply:** run `LC_ALL=C grep -a -b -o -F '[^a-zA-Z0-9]/g' <binary>` for byte offsets, then `dd bs=1 skip=$((off-260)) count=420` to read the context around each one. Several hits are unrelated sanitizers, so pick the one with the 200-char limit.
