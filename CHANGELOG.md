# Changelog

## 0.3.3

- **Model-adaptive headroom.** `headroomTokens` was an absolute reserve (default 65536) subtracted from the usable message budget. On a 100k-context model that left only ~18k of budget (`100000 − 16000 − 65536`), so the pressure ratio sat above the hard threshold almost permanently and compaction fired on every step. A new `headroomRatio` (default `0.0625`) computes the reserve as `contextWindow × ratio` with a **floor of 8192**, so a 1M model keeps the old 65,536 (zero behavior change) while a 100k model reserves 8,192 instead of 6,250. `headroomTokens` is now an absolute override: >0 pins it, 0 (default) uses the ratio.
- Budget formula is unchanged apart from swapping the constant for `resolveHeadroom(window)`; `CM-BUDGET-03` now asserts that `headroomRatio: 0` removes the reserve.
- **Visual config, no YAML editing.** The settings panel gains a "检索与压缩设置" form (retrieval mode, embedding endpoint/model/key env, vector weight, headroom ratio, soft/hard ratios) backed by `GET/POST /plugins/dsh-memory-curate/config`. Edits persist to `config-override.json` next to the store and are merged over `cordis.patch.yml` at load; the embedder and retrieval index cache are rebuilt live, so switching to `hybrid` against a local `/embeddings` endpoint takes effect without a restart.
- Docs (`README.md`, `README.en.md`, bundle `cordis.patch.yml`) updated to describe the ratio and the `headroomTokens=0` default.

## 0.3.2

- **Smoother audit roll.** At the size threshold the archive now moves the oldest **40% of current audit bytes** (`auditArchiveRollRatio`, default 0.4), leaving about 60% hot instead of cutting down to the old 80%-of-threshold budget. A 50 MB store rolls to roughly 30 MB, so a production-heavy store does not re-roll immediately.
- **Memories never move.** Only `audit` rows are archived; memory, tombstone, prompt, meta and suggestion rows stay in the active store. Retrieval and the five-turn protection are unchanged; `trace` still reads archives.
- **Time-based retention stays out of the data path.** The plugin does not automatically create or prune backup copies; backups should use a separate time-based retention policy and include `<store>.archive/`. If automatic backup rotation is wanted, it is a separate feature.
- Tests: 112.

## 0.3.1

- **Audit logs roll by size, not age.** When the active NDJSON exceeds `auditArchiveBytes` (default 50 MB), the oldest audit rows move to `<store>.archive/audit-*.ndjson` and the active store keeps the newest ~20%. The 50 MB default comes from a synthetic startup benchmark: 50 MB opens in ~515 ms with ~72 MB RSS, while 100 MB takes ~1.05 s. Memories, retrieval, compaction and the five-turn protection are untouched.
- **Permanent audit marker.** `memory_curate_admin` gains `retain_audit` (with `auditId` and optional `reason`); a retained audit row and its decision group are never rolled out. A new `archive` action forces one roll for testing/administration. The `stats` output reports archive files, rows and bytes.
- **Trace spans archives.** `traceMemory` / `traceSeq` lazily read archive segments and mark their rows `archived: true`; a `recall_summary` permanent row preserves the latest `lastUsedAt` after recall audits move out. Archive manifests carry row count, byte count, time range and sha256.
- **Packaging fix.** The user guide is back at the filename the README, selfcheck and npm `files` list expect (`使用说明书.md`), so it is included in the tarball and links resolve.
- Tests: 112.

## 0.3.0

- **Open-source packaging.** Added repository/homepage/bugs metadata, `.gitignore`, `SECURITY.md`, `CONTRIBUTING.md`, and GitHub/npm install commands; npm package `dsh-memory-curate@0.3.0` is published.
- **Plugin-list metadata resolves.** The package now exports `./package.json`, so the plugin manager's `readPluginMeta` can read the manifest instead of returning no metadata. The description is a benefit-led Chinese-first line (cross-session memory, five-turn compaction protection, audit/edit, zero-config local-first, shared/private scopes) with an English fallback; the settings list can show it after refresh.
- **Compaction never starts on the protected system head.** A pressure-triggered compaction computed its range as `surface[0]..window.startIndex-1`; when node 0 is the session's `system/message`, the host engine appended `compaction/summary` first and only then refused the surface replacement (`node 0 holds the system prompt`). The already-written summary shadowed the protected head, so every later resume failed with `SessionFormatError: compaction cannot shadow the protected system head`. Ranges now start at node 1 (`protectedHeadSeq` in `window.js`, used by the pressure path, `selectCompactionRegion` and the `compactRegion` wrapper, which fails closed before any summary exists).
- **Stale/reversed compaction ranges fail closed.** A rewritten surface can hand the wrapper a range whose start is no longer before its end (observed as `start:83,end:34` after a system-head refresh). The wrapper used to delegate that range to the host, allowing a summary commit before the replacement guard failed. It now audits `invalid-region-order` or `region-not-on-surface` and returns `null` before the engine runs. Tests: 108.
- **Local multi-agent scopes.** Memory and suggestion rows now carry `namespace`, `owner` (writing session) and `visibility` (`private` / `shared` / `open`). Recall, trace, duplicate detection, consolidation, anchor text and compaction gates all filter through the calling agent's scope; the local settings UI acts as a trusted admin and can see every namespace.
- **Write permissions.** `shared` rows are readable by the namespace but editable only by their owner; `open` rows are editable by any agent in the namespace; `private` rows are visible only to the owner (and the UI admin). Legacy v2 rows load as ownerless `shared` and remain writable for migration.
- **Single-writer lock.** `singleWriter` (default true) creates `<store>.lock` before opening; a second DSH process degrades to read-only instead of appending to the same NDJSON. Stale locks are reclaimed only when the recorded PID is gone (same-host check) or the lock is older than 60s and its owner cannot be verified; the release checks its random token.
- **Audit actor.** Write, recall, update, delete, consolidate and anchor rows record `actor` (`session`/`ui`/`system`) plus namespace/visibility where relevant.
- Memory row schema v3 (additive).
- User-facing bilingual `使用说明书.md`, organized around common memory-product pain points (lost context, duplicate/stale memories, lack of control, privacy, setup complexity) without implementation details.
- Team contact metadata (`CONTACT.md`, package author, README/guide contact sections): Jiuqi Technology · Huohuo Team, Mars.

## 0.2.0

- **Compaction pressure is measured against the usable message budget** (`contextWindow − request maxTokens − headroomTokens`) and with the request envelope passed to the token meter. A ratio above `(contextWindow − maxTokens) / contextWindow` can no longer be configured into unreachability: on deepseek-flash the old `0.8 × 1,048,576` (838,860) sat above the 792,576-message ceiling, so compaction never ran before the provider rejected the request.
- **`context-overflow` bypasses the memory gates.** A provider-confirmed rejection forces one recovery compaction; the five-human-turn protection still applies. An unmeasurable budget delegates to the host engine instead of silently suppressing compaction.
- Optional semantic retrieval: `retrievalMode=hybrid` embeds the query and candidate memories through an OpenAI-compatible `/embeddings` endpoint, fuses the vector ranking with BM25 through RRF, caches vectors in memory, and falls back to BM25 on any failure (recorded in the recall audit).
- Non-destructive consolidation proposals: near-duplicate or contradictory memories produce `suggestion` rows (`merge` / `conflict`); `memory_curate_admin` gains `suggestions`, `apply_suggestion`, `dismiss_suggestion`. Applying appends a superseding row with an array `supersedes`.
- Time and importance: memories carry `importance` (1–5), `validFrom`, `validUntil`; recall applies importance and half-life decay; expired assertions leave active recall, are audited once (`expire`), and are never deleted. `lastUsedAt` is derived from the recall audit stream.
- Settings-page memory browser: host routes (`/plugins/dsh-memory-curate/{status,browse,trace,update,delete}`) behind the same loopback + Origin + per-launch control-key fence as dsh-plugin-health, plus a client bundle with search, tag filter, source/audit view, append-only edit and tombstone delete.
- Reproducible retrieval evaluation: `bench/eval.mjs` (Recall@k, MRR, token savings) with a bundled smoke dataset and a LoCoMo converter; report in `docs/selfmem/tests/eval-report.md`.
- Memory row schema v2 (additive, v1 rows still load). Tests: 88.

## 0.1.0

- Initial implementation of the self-authored, auditable memory plugin.
- NDJSON store with append-only memory, tombstone, prompt and audit rows.
- Runtime prompt generation with deterministic validation (sections, replay, personalization) and rollback; tolerant of reasoning-block output and a larger JSON budget.
- Tag + trigger + BM25 recall with match reasons written to the audit trail; search uses an inverted index rebuilt only when the store revision changes (p50 34ms at 10,000 memories).
- Memory-driven compaction: write gate, recall gate and recoverable replacement gate.
- Five-human-turn protection window, including tool-result folding that skips protected results.
- Preset-scoped attachment: wraps the agent's actual `compaction` engine and `toolResultPruner` via `agentPresets.serviceFor`, degrading to tools/recall/anchor when no engine exists.
- Nine volatile settings fields rendered by the DSH settings page.
- Four model-facing tools: `memory_curate_save`, `memory_curate_recall`, `memory_curate_trace`, `memory_curate_admin`.
