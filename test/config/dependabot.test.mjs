// test/config/dependabot.test.mjs
// Guard against the empty-stub regression in .github/dependabot.yml.
// The previous file shipped with `package-ecosystem: ""` so Dependabot
// silently monitored nothing. These checks fail loudly if that happens
// again.

import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FILE = resolve(__dirname, '../../.github/dependabot.yml')
const raw = readFileSync(FILE, 'utf8')

describe('.github/dependabot.yml', () => {
  test('declares version 2 schema', () => {
    expect(raw).toMatch(/^version:\s*2\b/m)
  })

  test('has no empty package-ecosystem entries', () => {
    expect(raw).not.toMatch(/package-ecosystem:\s*""/)
    expect(raw).not.toMatch(/package-ecosystem:\s*''/)
  })

  test('monitors npm, docker, and github-actions', () => {
    const ecos = [...raw.matchAll(/package-ecosystem:\s*"([^"]+)"/g)].map((m) => m[1])
    expect(ecos).toContain('npm')
    expect(ecos).toContain('docker')
    expect(ecos).toContain('github-actions')
  })

  test('npm coverage spans root, app/server, app/client', () => {
    // Pair each `package-ecosystem` with the directory that follows it,
    // then collect directories tied to npm.
    const blocks = raw.split(/-\s+package-ecosystem:/).slice(1)
    const npmDirs = blocks
      .filter((b) => /^\s*"npm"/.test(b))
      .map((b) => {
        const m = b.match(/directory:\s*"([^"]+)"/)
        return m ? m[1] : null
      })
      .filter((d) => d !== null)
    expect(npmDirs).toContain('/')
    expect(npmDirs).toContain('/app/server')
    expect(npmDirs).toContain('/app/client')
  })
})
