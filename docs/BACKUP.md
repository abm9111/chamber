# Backing up the Chamber database

Chamber keeps its state in one SQLite file: beliefs, citation pins, the audit
chain, checkpoints, approvals, spend and the job queue. Your notes are not in
it. They stay where they are, and `chamber ingest` rebuilds the corpus from
them, but a belief and the pins it was committed against exist only here.

## Where the database is

```bash
chamber config show
```

The `database = ...` line is the path, and the bracket after it says where the
path came from (`[from default]`, `[from env]` or `[from config]`).

## Take a backup while Chamber is running

Use SQLite's own backup, not `cp`:

```bash
umask 077
sqlite3 "$DB" ".backup '$DEST'"
```

or, on SQLite 3.27 or newer:

```bash
umask 077
sqlite3 "$DB" "VACUUM INTO '$DEST'"
```

`$DB` is the path from `chamber config show` and `$DEST` is a file that does
not exist yet (`VACUUM INTO` refuses to overwrite). Both give a consistent
snapshot of the committed state while other processes read and write.

Chamber runs its database in WAL mode. A committed write lands first in the
`-wal` file next to the database and reaches the main file only at a later
checkpoint. So a plain `cp chamber.sqlite backup.sqlite` can copy a main file
that does not contain transactions Chamber has already acknowledged, and it can
copy it halfway through a write. In a test with a WAL database that had not yet
checkpointed, the `cp` copy had lost a whole table that `.backup` and
`VACUUM INTO` kept. A backup that cannot be told from a good one until the day
you restore it is worse than none.

Keep backups private. A backup holds everything the database does, including
the text of your notes' passages, your audit trail, and the OAuth tokens of any
MCP server you connected Chamber to:

```bash
chmod 600 "$DEST"
```

Keep them in a directory only you can read (`chmod 700`). The `umask 077` above
makes the backup file `0600` from the start.

## Restore

1. Stop everything that opens the database, not only what writes to it. On a
   server that is the API service, the job timer and its service, and the Slack
   and Discord gateways; leave out any unit you do not run:

   ```bash
   sudo systemctl stop chamber.service chamber-jobs.timer chamber-jobs.service \
     chamber-slack.service chamber-discord.service
   ```

   On macOS, unload both scheduled jobs and quit anything else that runs
   Chamber: an MCP client with `chamber mcp` attached, or a server you started
   by hand:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.chamber.verify.plist
   launchctl unload ~/Library/LaunchAgents/com.chamber.daily-snapshot.plist
   ```

   `unload` stops a job that is running at that moment. Do this when it is not.
   Then check that nothing still has the file open, because the next step
   deletes files an open connection is using:

   ```bash
   lsof "$DB"
   ```

   No output means nothing has it open.

2. Remove the old write-ahead files, then replace the database. A `-wal` or
   `-shm` file left over from the database you are replacing belongs to that
   database, and SQLite would apply it to the restored one:

   ```bash
   rm -f "$DB-wal" "$DB-shm"
   cp "$BACKUP" "$DB"
   chmod 600 "$DB"
   ```

3. Check it:

   ```bash
   chamber verify
   ```

   `verify` re-checks every stored pin against the corpus as it is now. If you
   restored a database older than your last `chamber ingest`, run
   `chamber ingest` first so the corpus matches.

4. Start the jobs again:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.chamber.verify.plist
   launchctl load ~/Library/LaunchAgents/com.chamber.daily-snapshot.plist
   # or: sudo systemctl start chamber.service chamber-jobs.timer \
   #       chamber-slack.service chamber-discord.service
   ```

## After a restore, check the checkpoint

A restored database is an older chain, and an older chain is exactly what a
checkpoint receipt exists to expose. `chamber checkpoint` records the audit
chain's length and root at the moment it runs, and writes an entry to the anchor
log. `chamber checkpoint verify` holds a receipt against the database as it is
now:

```bash
chamber checkpoint verify <receipt>
```

It prints one line each for `signature`, `chain`, `anchors` and `history`, and
exits 1 if any of them fails. If the receipt, or an anchor in the log, was made
*after* the moment your backup was taken, the restored chain is shorter than
what they attest, and `chain`, `anchors` or `history` says so. That failure is
the correct answer, not a fault in the restore: it is the record that the
writes between the backup and the failure are gone. A receipt older than the
backup still verifies.

Run it after every restore, and read the failure if there is one, because a
restored older database is also what a rollback by someone else looks like.
Take a fresh checkpoint once you are satisfied with the restored database, so
the next restore has something recent to compare against, and copy the anchor
log somewhere this machine cannot rewrite.
