# dsh-memory-curate

> Cross-session preferences and project conventions; compaction stays host-owned while memory is a non-blocking sidecar; every memory is traceable and editable; zero-config and local-first, with shared/private scopes.

> End users: read the [bilingual user guide](使用说明书.md). This README is for development, deployment and troubleshooting.

Auditable long-term memory for DeepSeek Harness: the plugin generates its own extraction prompt at runtime, keeps memories, audits and prompt versions in one NDJSON file, and recalls with tags + trigger words + BM25 (optionally fused with embeddings). Compaction is owned by the host engine, which already compacts on token pressure; the plugin never vetoes, defers or reminds — it only wraps `compactRegion` with corruption guards.

## Why it exists

The Harness compaction engine already works on token pressure with a retained tail; it does not need a plugin to decide whether it may compact. This plugin is the memory layer beside compaction, not a gate in front of it:

- **Compaction is host-owned; memory is a sidecar**: pressure and overflow both go to the host `compaction-basic` (threshold plus a token-budget retained tail). The wrapper only refuses spans that would corrupt the log (system head, reversed range, region no longer on the surface).
- **A memory write never blocks compaction**: capture is best-effort, so a failed write cannot stop the context from being shed — the tradeoff shared by MemGPT/Letta, OpenHands and OpenClaw: the runtime owns summarization, memory is a sidecar.
- **Nothing is deleted**: compaction only rewrites the model-visible projection and keeps a recoverable receipt; folded tool results keep their original `fullTextRef`.
- **Tool results fold outside the protected window**: `pruneProtected` keeps recent turns' tool output verbatim and folds the rest to head + marker + tail.
- **The system head is never touched**: a v4 session keeps its `system/message` at surface node 0; the `compactRegion` wrapper refuses any span that starts on node 0. The host commits `compaction/summary` before it applies the surface replacement, so a span from node 0 would leave a summary that shadows the protected head and breaks every later resume.
- **Everything is audited**: writes, updates, deletes, recalls, prune folds, compactions, expirations, consolidation proposals and prompt version changes append audit rows; old rows are never rewritten.
- **Audit growth is bounded**: when the active NDJSON exceeds `auditArchiveBytes` (50 MB by default), the oldest audits roll into `<store>.archive/` at `auditArchiveRollRatio` (40% by default), leaving about 60% hot. `trace` still reads across archives; `retain_audit` pins a critical decision row.

## Install

Install directly from GitHub:

```bash
dsh plugin --profile web add github:juki001/dsh-memory-curate
```

After the npm release, you can also install from npm:

```bash
dsh plugin --profile web add dsh-memory-curate
```

Or add `dsh-memory-curate` to `dsh.profile.bundles` in the profile's `package.json` and run `pnpm install`. The package ships its own `cordis.patch.yml` and only inserts the `memory-curate` entry; it never rewrites the host compaction configuration.

Requires DSH >= 0.2.2-rc.1 (< 0.3.0-0).

## Settings

Every option is a `volatile()` field, so the DSH settings page renders a control and changes apply live:

| Field | Default | Meaning |
|---|---|---|
| `protectTurns` | 5 | Human turns protected from compaction and folding |
| `protectToolResults` | true | Do not fold tool results inside the protected window |
| `softRatio` | 0.80 | Fraction of the **usable message budget** at which memory gates start |
| `hardRatio` | 0.92 | Fraction at which compaction is forced regardless of memory |
| `headroomTokens` | 0 | Absolute headroom override; >0 wins over the ratio; 0 means derive from `headroomRatio` |
| `headroomRatio` | 0.0625 | Headroom as a fraction of the context window; model-adaptive, active when `headroomTokens=0` |
| `maxDeferSteps` | 3 | Consecutive defers before compaction is forced |
| `captureMode` | tool-only | `auto-remind` injects one save reminder after a candidate |
| `anchorDetail` | 标准 | Trigger words shown per tag in the anchor |
| `retrievalMode` | bm25 | `hybrid` fuses vector ranking with BM25 via RRF; falls back to BM25 on any failure |
| `embeddingBaseURL` | empty | OpenAI-compatible embeddings base URL, e.g. `http://127.0.0.1:1234/v1` |
| `embeddingModel` | empty | Embeddings model id |
| `embeddingApiKeyEnv` | empty | Environment variable holding the API key (optional for local endpoints) |
| `embeddingWeight` | 0.5 | RRF weight of the vector ranking |
| `consolidateMode` | suggest | Propose merges/conflicts after a write; never overwrite automatically |
| `namespace` | default | Local memory namespace; different namespaces are invisible to each other by default |
| `defaultVisibility` | shared | New-memory scope: `shared` is readable in the namespace; `private` is readable/writable only by the writing session (the local UI admin still sees it) |
| `singleWriter` | true | Take a single-writer lock; a second DSH process degrades to read-only instead of corrupting the NDJSON |
| `decayHalfLifeDays` | 90 | Recall half-life decay; 0 disables decay |
| `embedding` | off | Compatibility switch: `auto` means `retrievalMode=hybrid` |
| `storePath` | empty | Empty uses `$DSH_HOME/data/memory-curate/memory-curate.ndjson` |
| `auditArchiveBytes` | 50 MB | When the audit-bearing store exceeds this size, oldest audits roll into `<store>.archive/`; range 1 MB–1 GB |
| `auditArchiveRollRatio` | 0.40 | Fraction of current audit bytes moved per roll; 40% by default, leaving about 60% hot |

`softRatio` must stay below `hardRatio` or the plugin refuses to load.

**Threshold semantics**: the pressure ratio is `tokens / (contextWindow − header.maxTokens − headroom)`, where `headroom` defaults to `headroomRatio × contextWindow` and scales with the model (`headroomTokens=0`; a value >0 pins an absolute reserve). The ratio-derived headroom has a floor of **8192**. For deepseek-flash (1,048,576 context, 256,000 reserved completion) `headroomRatio=0.0625` gives 65,536 and the default soft threshold fires at about 58% of the window; on a 100k-context model the same ratio would give 6,250 but is floored to 8,192, so a fixed value no longer eats ~65% of the budget. Measured against the raw window, 0.8 (838,860) sits above the 792,576 message ceiling, so compaction would never run before the provider rejects the request.

## Tools

- `memory_curate_save`: save one memory (text, tags, triggers, entities, reason, structure reason, importance, validUntil, visibility) with source session/seq.
- `memory_curate_recall`: tag/trigger/BM25 (optionally fused) recall with match reasons and audit ids; only the calling agent's visible rows are searched.
- `memory_curate_trace`: stored rows, audits and usage for a memory id or a surface position; private rows of another scope are not returned.
- `memory_curate_admin`: `stats` / `prompt_show` / `prompt_regenerate` / `prompt_rollback` / `delete` / `suggestions` / `apply_suggestion` / `dismiss_suggestion`.

## Storage

Single NDJSON file, one JSON object per line:

- `header`: schema version;
- `memory`: self-contained row (`source{sessionId,seqs}`, `writeReason`, `structureReason`, `importance`, `validFrom`, `validUntil`, `namespace`, `owner`, `visibility`, `promptVersion`);
- `memory_tombstone`: deletion marker;
- `suggestion`: merge/conflict proposal (`proposed` / `applied` / `dismissed`), never overwrites a memory;
- `prompt`: generated extraction prompt versions (`proposed` / `active` / `retired` / `rejected`);
- `audit`: every decision;
- `meta`: indexes and counters.

Updates and deletes append a new row referencing the target; old rows stay. `supersedes` may be an array, so two nearby memories can be merged into one new row.

## Semantic retrieval (optional)

Default is zero-config BM25. To enable hybrid recall: set `retrievalMode=hybrid`, fill `embeddingBaseURL` and `embeddingModel`, and (only if auth is needed) put the key in an environment variable named by `embeddingApiKeyEnv`.

Vectors are cached in memory only, so the NDJSON stays readable. Query and candidates are embedded in one batch. BM25 ranks and cosine ranks are fused through RRF, which needs no shared score scale. Any embedding failure degrades to BM25 and records `fallback` in the recall audit row.

## Consolidation proposals

After a write, the plugin scans the new memory against the active set (`0.6 ≤ similarity < 0.82`; `≥ 0.82` is already rejected as a duplicate at write time). Hits produce a `suggestion`:

- `merge`: two highly similar rows, propose one merged statement;
- `conflict`: two similar rows with opposite polarity (e.g. "默认启用遥测" vs "默认不要启用遥测"), propose review and merge.

Suggestions never overwrite. Use `memory_curate_admin action=suggestions` to list, `apply_suggestion` to accept (optional `text` override), `dismiss_suggestion` to close. Applying appends a new row that supersedes every target; history stays replayable.

## Time and importance

- Each memory may carry `importance` (1–5, default 3) and `validUntil`; recall scales the score by a `0.6–1.0` importance factor and a floored half-life decay.
- An expired `validUntil` does not delete anything: the row becomes `expired`, leaves default recall, and gets one `expire` audit. Pass `includeExpired` to inspect it.
- "Last used" is derived from the recall audit stream, so usage needs no extra rows and the audit stays the single source of truth.

## Memory browser

The package ships a browser-side settings section (`dsh.client`) plus guarded host routes: search, tag filter, body/source/audit inspection, inline edit (append-only supersede) and delete (append-only tombstone). The panel reads and writes the same NDJSON store and audit trail as the tools.

## Multi-agent sharing and permissions

Agents in one profile share the store, but every row carries a scope:

- `namespace`: taken from the configured `namespace`; different namespaces are invisible to each other by default (the local UI admin sees all).
- `owner`: the writing session id, used in audits and write checks.
- `visibility`:
  - `shared` (default): readable in the namespace, editable only by the owner;
  - `private`: readable/writable only by the owner session (the local UI admin can still inspect/edit);
  - `open`: readable and editable by every agent in the namespace.

Recall, trace, duplicate detection, consolidation, anchor text and both compaction gates filter through the caller's scope, so private memories cannot leak into another agent's context. `memory_curate_save` accepts `visibility`. Legacy v2 rows load as ownerless `shared` and stay writable for migration.

**Single-writer lock**: with `singleWriter=true` (default) startup creates `<store>.lock`. A second DSH process that cannot take the lock degrades to **read-only** (recall, browse, trace still work; writes return `STORE_READ_ONLY`) instead of appending to the same file. A crashed lock is reclaimed only when its PID is gone (when same-host verification is possible) or it is older than 60 seconds and its owner cannot be verified; release checks a random token, so it never deletes a lock taken over by another process.

## Evaluation

`bench/eval.mjs` is a reproducible recall evaluation: it imports a dataset into a temporary store and reports Recall@1/3/5/10, MRR and token savings as JSON plus Markdown. A bundled smoke sample is for self-check; `bench/locomo-to-jsonl.mjs` converts the official LoCoMo file when present. Numbers and caveats live in `docs/selfmem/tests/eval-report.md` — **do not claim parity with any competitor before a real dataset run**.

## Performance (local measurements)

10,000 memories: sequential writes ~1,700/s (5.8 s) → 5.3 MB file, reload 75 ms; recall uses an inverted index cached per store revision, p50 34 ms / p99 43 ms at 10k; folding a 5 MB tool result takes 122 ms; the protected-window check over a 10k-node surface takes 1.3 ms; store trace over 10k rows p50 0.43 ms. See `docs/selfmem/tests/perf-report.md`.

## How compaction is wrapped

The Web profile moves the compaction engine into each agent preset, so there is no top-level `compaction` service. The plugin therefore does not `inject: ['compaction']`; on `agent/created` it resolves the preset's real engine through `agentPresets.serviceFor(agent, 'compaction')` and wraps it once:

1. **Pressure path**: `compactIfNeeded` is delegated straight to the host — threshold, retained tail and the span are all the host engine's decision; the plugin no longer computes a protected window or counts defers.
2. **Overflow recovery**: `context-overflow` is delegated too; the host recovers with `retainTokens: 0`.
3. **Direct region**: wrap `compactRegion` with corruption guards only — a span that starts on the protected system head (node 0), a reversed span, or a span no longer on the surface is refused with an audit; every other span is forwarded unchanged.
4. **Tool-result folding**: wrap the preset `toolResultPruner.pruneSession`, skip protected results, fold the rest as head 4096 + marker + tail 1024, and replay the `compaction/prune` shadow-price event.

When a preset has no compaction engine the plugin degrades to "memory tools/recall/anchor only" and writes a `degraded` audit; it never blocks loading.

## Development

```bash
npm test        # 102 unit tests, no model credentials needed
npm run selfcheck
npm run observe # read-only: memory counts, compact decisions, folds, protected skips
node bench/eval.mjs --md /tmp/eval.md   # recall evaluation (bundled smoke sample)
```

Tests resolve `@deepseek-ai/*` through a loader hook pointed at the local Harness install, so the plugin directory needs no peer dependencies installed. Compaction delegation and its three corruption guards, the pressure budget, folding, the NDJSON store, BM25/hybrid recall, decay, consolidation proposals and prompt validation all have dedicated assertions; `REG-01` reproduces and locks the old deadlock where a protected window that filled the budget meant compaction never ran.

## Coexistence with billion-context

If billion-context is installed in the Web profile, its `bili-compaction-gate` disables every preset's `compaction-basic` while its own compaction is enabled; this plugin then cannot resolve an engine and only provides tools, recall, audits and the anchor (with a `compact decision=degraded` audit).

To let the host compaction and this plugin both work, append to the profile `cordis.patch.yml`:

```yaml
- id: bili-native
  disabled: true
```

Keep `bili-compaction-gate` (it provides an injected service the presets wait on). Restart the DSH process afterwards: bili keeps its enablement flag in process memory and a hot reload will not clear it. After the restart a new session's audit should show `compact decision=attached`.

## About us

Maintained by **Jiuqi Technology · Huohuo Team**; AI assistant **Mars**.

- Email: `5535483@qq.com`
- WeChat: `juki005`
- Official Account: `juki115`

For collaboration, integration, feedback or bug reports, reach us through the channels above. See [CONTACT.md](CONTACT.md) for details.

## Boundaries

- No compaction algorithm of its own: selection and summaries stay with the host `compactRegion`.
- Never rewrites protected text; only refreshes the light anchor section after a compaction.
- The generated prompt is persisted, versioned and rollback-capable; every memory records the prompt version used.
- Semantic retrieval only fuses recall; storage format is unchanged and vectors are not persisted.
- No dependency on other memory plugins or a development toolchain.

MIT License.
