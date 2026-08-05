#!/bin/sh
# Collect one day's Chamber facts into a dated file.
#
# The analysis half of the daily report is written by a person or an agent
# reading this file. This half only has to be *true* and to still exist
# tomorrow, which is why it is a shell script on a schedule rather than
# something that depends on any session being alive.
#
# Every number here comes from a command. Nothing is estimated, and a failing
# command prints its failure rather than being skipped — a missing line and a
# zero line mean very different things, and a report that cannot tell them
# apart is not worth reading.
#
# Exit code is deliberately 0 even when checks fail: this is a recorder, not a
# gate. `chamber verify` is the gate, and it runs separately at 08:30.

set -u

REPO="${CHAMBER_REPO:-$HOME/Projects/chamber}"
# Exported because the inline node script below reads it from the environment.
# It is single-quoted there so the shell leaves it alone, which means an
# unexported REPO resolves to `undefined` and the import fails with
# ERR_MODULE_NOT_FOUND — the whole Ledger section replaced by a stack trace.
export REPO
OUT_DIR="${CHAMBER_REPORT_DIR:-$HOME/Library/Logs/chamber-daily}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$(date '+%Y-%m-%d').md"

# Measured separately, never as `cmd | tail; echo $?` — that reports tail's
# exit status, not the command's. This mistake has been made twice in this
# project and both times inverted the result being recorded.
probe_exit() {
  # $1 = probe filename, $2… = leading env assignments
  _p="$1"
  shift
  env "$@" timeout 150 node --experimental-strip-types "$REPO/probes/$_p" >/dev/null 2>&1
  echo "$?"
}

{
  echo "# Chamber — $(date '+%A %d %B %Y')"
  echo
  echo "_Collected $(date '+%H:%M %Z') by scripts/daily-snapshot.sh_"
  echo

  echo "## Drift"
  echo
  echo '```'
  cd "$REPO" 2>/dev/null && chamber verify 2>&1 | tail -30
  echo '```'
  cd "$REPO" 2>/dev/null && chamber verify >/dev/null 2>&1
  echo
  echo "verify exit code: $?"
  echo
  echo "### The 08:30 scheduled run"
  echo
  if [ -f "$HOME/Library/Logs/chamber-verify.log" ]; then
    echo '```'
    # Last run only (the log is appended to forever), and within it only the
    # lines that answer a question. `chamber ingest` prints hundreds of
    # skipped-entry lines — dotted files, unsupported extensions — which are
    # correct behaviour and pure noise here. Showing them buried the verify
    # verdict 25 lines deep on the first run of this script.
    awk '/^=== chamber /{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' \
      "$HOME/Library/Logs/chamber-verify.log" \
      | grep -E '^=== |^  database|belief\(s\) checked|pins verified|hash_mismatch|not_found|ingest FAILED|^ingested' \
      | tail -20
    echo '```'
  else
    echo "**The scheduled job has never written a log.** A scheduler that"
    echo "silently stopped looks identical to a clean result, so this line"
    echo "matters: check \`launchctl list | grep chamber\`."
  fi
  echo

  echo "## Corpus"
  echo
  echo '```'
  cd "$REPO" 2>/dev/null && chamber corpus 2>&1 | head -30
  echo '```'
  echo

  echo "## Ledger"
  echo
  echo '```'
  node --experimental-strip-types --input-type=module -e '
    const { openChamberDb } = await import(process.env.REPO + "/src/db.ts");
    const db = openChamberDb(process.env.HOME + "/.local/share/chamber/chamber.sqlite");
    const one = (label, sql, ...p) => {
      try { console.log(label.padEnd(26) + db.prepare(sql).get(...p).c); }
      catch (e) { console.log(label.padEnd(26) + "ERROR: " + e.message); }
    };
    const since = new Date(Date.now() - 864e5).toISOString();
    one("beliefs (total)",        "SELECT COUNT(*) c FROM belief");
    one("beliefs (24h)",          "SELECT COUNT(*) c FROM belief WHERE created_at > ?", since);
    one("open citation debt",     "SELECT COUNT(*) c FROM citation_debt WHERE status IN (?,?)", "pending", "proposed_paid");
    one("pending writes",         "SELECT COUNT(*) c FROM pending_write WHERE status = ?", "pending");
    one("audit events (24h)",     "SELECT COUNT(*) c FROM audit_event WHERE created_at > ?", since);
    one("gate events (24h)",      "SELECT COUNT(*) c FROM gate_event WHERE created_at > ?", since);
    one("sessions (24h)",         "SELECT COUNT(*) c FROM session WHERE started_at > ?", since);
    try {
      const { verifyAuditChain } = await import(process.env.REPO + "/src/audit.ts");
      console.log("audit chain".padEnd(26) + JSON.stringify(verifyAuditChain(db)));
    } catch (e) { console.log("audit chain".padEnd(26) + "ERROR: " + e.message); }
  ' 2>&1
  echo '```'
  echo

  echo "## Gates"
  echo
  cd "$REPO" 2>/dev/null || exit 0
  echo '```'
  npm run test 2>&1 | tail -2
  printf 'typecheck errors: '
  npx tsc --noEmit 2>&1 | grep -c "error TS"
  echo
  echo "probe exit codes (0 = the defect it asserts is absent):"
  echo "  gate_audit            $(probe_exit gate_audit.ts)"
  echo "  pin_bypass            $(probe_exit pin_bypass.ts)"
  echo "  verify_partial_drift  $(probe_exit verify_partial_drift.ts)"
  echo "  debt_paraphrase       $(probe_exit debt_paraphrase.ts)   <- known-failing, KNOWN_LIMITATIONS 14"
  echo "  sandbox_escape        $(probe_exit sandbox_escape.ts CHAMBER_SANDBOX_REQUIRED=1)   <- known-failing, KNOWN_LIMITATIONS 1"
  echo '```'
  echo

  echo "## Repository"
  echo
  echo '```'
  echo "HEAD:     $(git -C "$REPO" rev-parse --short HEAD) on $(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  echo "unpushed: $(git -C "$REPO" rev-list --count @{u}..HEAD 2>/dev/null || echo 'no upstream')"
  echo "dirty:    $(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') file(s)"
  echo
  echo "commits in the last 24h:"
  git -C "$REPO" log --since="24 hours ago" --oneline || echo "  (none)"
  echo '```'
} > "$OUT" 2>&1

echo "wrote $OUT"
