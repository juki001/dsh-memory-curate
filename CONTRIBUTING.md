# Contributing

Thanks for improving `dsh-memory-curate`.

## Before opening a pull request

1. Run the full suite:
   ```bash
   node --import ./test/harness-resolve.mjs --test-isolation=none --test "test/*.test.js"
   ```
2. Run the structural check:
   ```bash
   node scripts/selfcheck.mjs
   ```
3. Keep changes focused; add a test when behavior changes.
4. Update `CHANGELOG.md` for user-visible changes.
5. Do not commit local stores, `.env` files, credentials, or generated caches.

## Design constraints

- The plugin must not implement its own compaction algorithm; summaries and surface replacement stay with the host engine.
- The protected system head and the last five human turns are invariants.
- Memory writes must remain append-only and auditable.
- Default behavior must work without embeddings or a cloud account.

## Reporting bugs

Open an issue with the DSH version, plugin version, a minimal reproduction, and the relevant audit rows. Redact memory contents and credentials.
