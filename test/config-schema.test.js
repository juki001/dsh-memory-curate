import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/index.js'

// The loader validates config against the schemastery `Config` schema BEFORE
// resolveConfig runs. Unit tests that only call resolveConfig miss this step;
// these tests exercise the same schema so an invalid `step`/`enum` fails here.

function plain (value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

const PROFILE_CONFIG = {
  protectTurns: 5,
  protectToolResults: true,
  softRatio: 0.8,
  hardRatio: 0.92,
  maxDeferSteps: 3,
  captureMode: 'tool-only',
  anchorDetail: '标准',
  embedding: 'off',
  retrievalMode: 'hybrid',
  embeddingBaseURL: 'http://127.0.0.1:1236/v1',
  embeddingModel: 'bge-m3',
  embeddingWeight: 0.5,
  headroomRatio: 0.0625,
  headroomTokens: 0,
  storePath: ''
}

test('CFG-01 the profile config passes the loader config schema', () => {
  assert.doesNotThrow(() => Config(PROFILE_CONFIG))
})

test('CFG-02 the default config passes the loader config schema', () => {
  const resolved = Config({})
  assert.equal(plain(resolved.headroomRatio), 0.0625)
  assert.equal(plain(resolved.headroomTokens), 0)
  assert.equal(plain(resolved.retrievalMode), 'bm25')
})

test('CFG-03 a headroomRatio that is not a schema step is rejected', () => {
  assert.throws(() => Config({ headroomRatio: 0.06251 }))
})
