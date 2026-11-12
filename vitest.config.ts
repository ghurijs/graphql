import { transform } from 'esbuild'
import { defineConfig } from 'vitest/config'

// Vite 8 transpiles TypeScript with oxc, which does not lower TC39 (stage 3) decorators yet. `@action` /
// `@extendSchema` use standard decorators (what tsup/esbuild/wrangler emit), so lower them with esbuild first.
export default defineConfig({
  plugins: [
    {
      name: 'ghuri-standard-decorators',
      enforce: 'pre',
      async transform(code, id) {
        if (!/\.tsx?$/.test(id) || id.includes('node_modules') || !/^\s*@\w/m.test(code)) return null
        const out = await transform(code, {
          loader: id.endsWith('.tsx') ? 'tsx' : 'ts',
          target: 'es2022',
          sourcemap: true,
          sourcefile: id,
          jsx: 'automatic',
          jsxImportSource: 'hono/jsx',
        })
        return { code: out.code, map: out.map }
      },
    },
  ],
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'] },
})
