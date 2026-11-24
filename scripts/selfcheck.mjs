#!/usr/bin/env node
/**
 * Packaging self-check: no test framework, no network, no peer imports.
 * Verifies the files a DSH bundle needs and the invariants that must not drift.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const passes = []

function check (label, fn) {
  try {
    const detail = fn()
    passes.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`)
  }
}

function read (relative) {
  const path = join(root, relative)
  if (!existsSync(path)) throw new Error(`missing ${relative}`)
  return readFileSync(path, 'utf8')
}

check('package name', () => {
  const pkg = JSON.parse(read('package.json'))
  if (pkg.name !== 'dsh-memory-curate') throw new Error(`unexpected name ${pkg.name}`)
  if (pkg.type !== 'module') throw new Error('type must be module')
  if (pkg.main !== 'src/index.js') throw new Error('main must be src/index.js')
  if (pkg.exports?.['./package.json'] !== './package.json') throw new Error('exports must expose package.json for the plugin-list description')
  if (!pkg.description) throw new Error('description missing')
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch missing')
  for (const field of ['node', 'dsh']) {
    if (!pkg.engines?.[field]) throw new Error(`engines.${field} missing`)
  }
  return pkg.version
})

check('bundle patch', () => {
  const text = read('cordis.patch.yml')
  if (!text.includes('id: memory-curate')) throw new Error('patch does not insert memory-curate')
  if (!text.includes('name: dsh-memory-curate')) throw new Error('patch name mismatch')
  if (/^\s*-\s*id:\s*compaction-basic/m.test(text)) throw new Error('patch must not override compaction-basic')
  if (!/protectToolResults:\s*true/.test(text)) throw new Error('protected tool results must default on')
  return 'insert-only'
})

check('source modules', () => {
  const modules = [
    'index.js', 'store.js', 'tokenize.js', 'bm25.js', 'retrieval.js', 'window.js', 'prune.js',
    'anchor.js', 'prompt.js', 'compaction.js', 'semantic.js', 'consolidate.js',
    'browser-routes.js', 'scope.js', 'lock.js'
  ]
  for (const name of modules) read(join('src', name))
  return `${modules.length} modules`
})

check('entry exports', () => {
  const text = read('src/index.js')
  if (!/export const name = 'dsh-memory-curate'/.test(text)) throw new Error('export name missing')
  if (!/export const inject = \[/.test(text)) throw new Error('export inject missing')
  if (!/export const Config = Schema\.object/.test(text)) throw new Error('Config schema missing')
  if (!/export async function apply/.test(text)) throw new Error('apply missing')
  if (/inject = \[[^\]]*'compaction'/.test(text)) throw new Error('compaction must not be a hard inject')
  return 'ok'
})

check('documents', () => {
  for (const name of ['README.md', 'README.en.md', '使用说明书.md', 'CONTACT.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE']) read(name)
  return '8 files'
})

check('test suite present', () => {
  const files = [
    'store.test.js', 'prune.test.js', 'window.test.js', 'retrieval.test.js', 'anchor.test.js',
    'prompt.test.js', 'compaction-region.test.js', 'attach.test.js', 'semantic.test.js',
    'lifecycle.test.js', 'pressure.test.js', 'browser-routes.test.js', 'scope.test.js', 'lock.test.js'
  ]
  for (const name of files) read(join('test', name))
  return `${files.length} files`
})

console.log(`selfcheck: ${passes.length} passed, ${failures.length} failed`)
for (const line of passes) console.log(`  ok  ${line}`)
for (const line of failures) console.error(`  fail ${line}`)
if (failures.length > 0) process.exitCode = 1
