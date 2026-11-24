import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

const DEFAULT_STALE_MS = 60_000

/**
 * Single-writer lock for one NDJSON store.
 *
 * The lock is a sibling `<store>.lock` file created with `wx`, so two DSH
 * processes cannot append to the same file. A crashed process leaves a stale
 * lock; the next opener may take it over only when the recorded PID is gone
 * (same host) or the lock is older than `staleMs`. The release function checks
 * the random token before unlinking, so an owner never deletes a lock that was
 * taken over by someone else.
 */
export async function acquireStoreLock (filePath, options = {}) {
  const lockPath = `${filePath}.lock`
  const staleMs = Number.isFinite(options.staleMs) && options.staleMs > 0 ? options.staleMs : DEFAULT_STALE_MS
  const token = randomUUID()
  const payload = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    token
  }
  await fs.mkdir(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockPath, JSON.stringify(payload) + '\n', { encoding: 'utf8', flag: 'wx' })
      return {
        ok: true,
        lockPath,
        token,
        release: async () => {
          try {
            const raw = await fs.readFile(lockPath, 'utf8')
            const current = JSON.parse(raw)
            if (current?.token !== token) return false
            await fs.rm(lockPath, { force: true })
            return true
          } catch {
            return false
          }
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, code: 'LOCK_FAILED', error: error?.message ?? String(error) }
      }
      const owner = await readLock(lockPath)
      if (await isStale(lockPath, owner, staleMs)) {
        await fs.rm(lockPath, { force: true })
        continue
      }
      return { ok: false, code: 'STORE_LOCKED', owner, lockPath }
    }
  }
  return { ok: false, code: 'STORE_LOCKED', lockPath }
}

async function readLock (lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function isStale (lockPath, owner, staleMs) {
  let ageMs = Number.POSITIVE_INFINITY
  try {
    const stat = await fs.stat(lockPath)
    ageMs = Date.now() - stat.mtimeMs
  } catch {
    return false
  }
  if (owner !== null && Number.isInteger(owner.pid) && owner.pid > 0) {
    if (owner.host === hostname()) {
      try {
        process.kill(owner.pid, 0)
        // Process exists: an old lock is still a live writer, not stale.
        return false
      } catch (error) {
        if (error?.code === 'ESRCH') return true
        // EPERM means the process exists but belongs to another user.
        return false
      }
    }
    return ageMs > staleMs
  }
  return ageMs > staleMs
}
