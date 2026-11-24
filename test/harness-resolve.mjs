import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireFromHarness = createRequire('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json')

registerHooks({
  resolve (specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') && !specifier.startsWith('@deepseek-ai/dsh/')) {
      try {
        const resolved = requireFromHarness.resolve(specifier)
        return next(pathToFileURL(resolved).href, context)
      } catch {
        return next(specifier, context)
      }
    }
    return next(specifier, context)
  }
})
