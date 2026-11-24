# Security Policy

## Supported versions

Security fixes target the latest 0.3.x release.

## Reporting a vulnerability

Please report privately to **5535483@qq.com**. Do not open a public issue for a vulnerability before a fix is available.

Include:

- affected version and DSH version;
- a minimal reproduction;
- whether memory contents, local files, or another process are exposed.

There is no bug bounty program. Reports are acknowledged on a best-effort basis.

## Data handling

The plugin stores memories in a local NDJSON file. Do not store passwords, API keys, or other secrets in memories; use a dedicated secret manager. If semantic retrieval is enabled, memory text is sent to the configured embeddings endpoint.
