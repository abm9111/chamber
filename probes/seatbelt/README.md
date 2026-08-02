# macOS seatbelt (`sandbox-exec`) findings

Groundwork for the `seatbelt` backend in Phase 1.1. **Read this before writing the
profile** — it records two dead ends that cost real time to find.

## Finding 1 — `(deny default)` cannot run Node

A strict deny-default profile aborts Node at startup with **SIGABRT (exit 134)**,
silently, before any user code runs. Node needs far more mach/sysctl/shm access
than a minimal allowlist grants. `profile-denydefault.sb` is kept as the negative
example; do not build on it.

## Finding 2 — the workable profile leaves `$HOME` readable

`profile-permissive.sb` (`(allow default)` + `(deny network*)` + `(deny file-write*)`
+ workdir allow) boots Node fine and gives:

| | result |
|---|---|
| network | **BLOCKED** |
| write to `$HOME` | **BLOCKED** |
| read `$HOME`, `~/.ssh`, `~/.secrets` | **still readable** |
| write to workdir | `BLOCKED:EPERM` ← profile bug, see below |

Measured output:

```json
{ "homeRead": true, "sshRead": true,
  "homeWrite": "BLOCKED", "workdirWrite": "BLOCKED:EPERM", "net": "BLOCKED" }
```

**Consequence for the design:** seatbelt stops *exfiltration* (no network) and
*tampering* (no writes), but not *reading secrets*. On a machine with `~/.secrets`
that is a material gap. Seatbelt is therefore a **degraded** backend — valid for
`compute`-class tools, never for anything touching credentials. Docker blocks
reads too and is the required backend above read-only class.

## Open bug — workdir writes denied

The `(allow file-write* (subpath (param "WORKDIR")))` rule did not take effect;
writes inside the workdir returned `EPERM`. Suspects, in order:

1. Param substitution in `(subpath (param "WORKDIR"))` — try interpolating the
   literal path into the profile text instead of using `-D`.
2. `mkdtemp` returns `/var/folders/...` which is a symlink to `/private/var/folders/...`
   — seatbelt matches on the resolved path, so pass `realpath` output.
3. Rule ordering — confirm later `allow` overrides earlier `deny` for `file-write*`.

Resolve this before shipping seatbelt as a selectable backend.

## Reproduce

```bash
W=$(cd probes/seatbelt/work && pwd -P)
sandbox-exec -f probes/seatbelt/profile-permissive.sb -D WORKDIR="$W" \
  "$(readlink -f "$(which node)")" probes/seatbelt/work/probe.mjs
```
