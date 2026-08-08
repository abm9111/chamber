# Security policy

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting** — the *Security* tab on this
repository, then *Report a vulnerability*. That opens a private thread visible
only to the maintainers.

Please do **not** open a public issue for a security bug. This project's whole
subject is gates that are supposed to hold, so a public report is a working
exploit against every install running that code.

There is no SLA. This is a pre-1.0 project maintained by one person; expect a
first response in days, not hours, and say so in your report if the issue is
being actively exploited.

## What is in scope

Chamber's claim is that specific gates cannot be walked around. A report is
in scope if it defeats one of them:

- **The sandbox.** Model-authored or vendor-supplied code reading, writing, or
  reaching the network outside its confinement, or `CHAMBER_SANDBOX_REQUIRED`
  failing to refuse when nothing isolating is available.
- **The citation gate.** A claim gaining verified support it did not earn — a
  pin that resolves without the cited document existing, a fabricated reference
  buying support from another row's content.
- **Citation debt.** An assertion committing while a blocking debt against it is
  open, including by rewording.
- **Tamper evidence.** Modifying, truncating or rolling back the audit chain,
  the Merkle checkpoint or the anchor log in a way `chamber checkpoint verify`
  reports as consistent.
- **MCP and skill import.** Vendor-supplied manifest content becoming
  executable, or altering the artifact a human approves.
- **Secrets.** Sealed values recoverable without the key; credentials reaching
  logs, exports, checkpoints or the corpus.

## What is not in scope

- Anything requiring an attacker who already has write access to the database
  file or the config directory. Chamber is local-first and single-operator; that
  attacker has already won, and the docs say so rather than pretending otherwise.
- The anchor log defending against someone who can also rewrite the anchor log.
  It raises the cost of a rollback to two artefacts; it does not make tampering
  impossible, and `src/anchor.ts` states that limit in place.
- Denial of service against your own machine.
- Findings from a scanner with no reachable call path. A report that names the
  path it took is worth ten that name a rule id.

## Supported versions

Only `main`. There are no releases and no backports yet.

## What helps a report land

The reproduction, not the theory. This project has repeatedly found that a
defect which is obvious in the code turns out to be unreachable, and that a gate
which reads correctly fails on a machine nobody tested. If you can, include the
command sequence, the platform, and what you expected the gate to do — and note
that isolation behaviour cannot be reproduced on macOS, which has no
`bubblewrap`.
