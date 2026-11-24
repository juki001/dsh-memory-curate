/**
 * Local multi-agent scope model for dsh-memory-curate.
 *
 * One store can be shared by several agents in the same profile. Every memory
 * carries a namespace, an owner (the writing session) and a visibility:
 *
 *   private  read/write only by the owner session (and the local UI admin)
 *   shared   readable by every agent in the namespace; writable by the owner
 *   open     readable and writable by every agent in the namespace
 *
 * Legacy v2 rows have no scope fields. They are treated as `shared` with a
 * null owner: readable by all, and writable by any reader for migration
 * compatibility. New rows always record an owner.
 */

export const VISIBILITIES = Object.freeze(['shared', 'private', 'open'])
export const DEFAULT_NAMESPACE = 'default'
const MAX_NAMESPACE_CHARS = 64

export function normalizeNamespace (value, fallback = DEFAULT_NAMESPACE) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0) return fallback
  return trimmed.slice(0, MAX_NAMESPACE_CHARS)
}

export function normalizeVisibility (value, fallback = 'shared') {
  return VISIBILITIES.includes(value) ? value : fallback
}

/** Stable identity for the live agent driving a tool call or a prompt section. */
export function agentSessionId (agent) {
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Audit actor: the session, the local UI, or an internal lifecycle action. */
export function actorOf (agent, kind = 'session') {
  if (kind === 'ui') return { kind: 'ui' }
  if (kind === 'system') return { kind: 'system' }
  const id = agentSessionId(agent)
  return id === null ? { kind: 'system' } : { kind: 'session', id }
}

/** Normalized scope fields for one memory or suggestion row. */
export function rowScope (row) {
  return {
    namespace: normalizeNamespace(row?.namespace),
    owner: typeof row?.owner === 'string' && row.owner.length > 0 ? row.owner : null,
    visibility: normalizeVisibility(row?.visibility)
  }
}

/** Context derived from the calling agent plus the configured namespace. */
export function callerScope ({ agent, namespace, admin = false } = {}) {
  return {
    agentId: agentSessionId(agent),
    namespace: normalizeNamespace(namespace),
    admin: admin === true
  }
}

/** Cache key: admin and each session/namespace pair get their own index. */
export function scopeKeyOf (scope = {}) {
  if (scope.admin === true) return 'admin'
  return `${scope.namespace ?? DEFAULT_NAMESPACE}|${scope.agentId ?? 'anonymous'}`
}

export function canRead (row, scope) {
  if (scope?.admin === true) return true
  const target = rowScope(row)
  if (target.namespace !== normalizeNamespace(scope?.namespace)) return false
  if (target.visibility === 'private') return target.owner !== null && target.owner === scope?.agentId
  return true
}

export function canWrite (row, scope) {
  if (scope?.admin === true) return true
  if (!canRead(row, scope)) return false
  const target = rowScope(row)
  if (target.visibility === 'private') return target.owner !== null && target.owner === scope?.agentId
  if (target.visibility === 'open') return true
  // shared: the owner edits; legacy ownerless rows stay writable for migration.
  return target.owner === null || target.owner === scope?.agentId
}

export function visibleRows (rows, scope) {
  return (rows ?? []).filter((row) => canRead(row, scope))
}

export function writableRow (rows, memoryId, scope) {
  const row = (rows ?? []).find((entry) => entry?.id === memoryId)
  if (row === undefined) return null
  return canWrite(row, scope) ? row : null
}
