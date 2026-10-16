import { describe, it, expect } from 'vitest'
import { generateStandaloneCompose, setComposeImage } from '../harness-compose'
import { generateAgentCompose } from '../agent-deploy-templates'
import {
  applyOvenmitt,
  removeOvenmitt,
  hasOvenmitt,
  setManagedEnv,
  setComposeMemory,
  readComposeMemory,
  memoryBytes,
  OVENMITT_SOCKET,
} from '../ovenmitt-compose'

const NAME = 'scout'
const DATA = '/srv/hermes/.hermes-scout'
const OPTS = { image: 'ovenmitt:test', configPath: '/srv/hsm/compose/scout/ovenmitt/ovenmitt.toml' }

const lineages: Record<string, () => string> = {
  plain: () => generateStandaloneCompose(NAME, 8642, DATA),
  vpn: () => generateStandaloneCompose(NAME, 8642, DATA, { vpnEnabled: true }),
  'plain + ollama + extra env': () =>
    generateStandaloneCompose(NAME, 8642, DATA, { bundledOllama: true, extraEnv: { FOO: 'bar' } }),
  'deploy-born': () => generateAgentCompose(NAME, 8642, DATA, { image: 'hermes-agent-mt:test' }),
}

/** The lines of one 2-space service block (header excluded). */
function service(compose: string, name: string): string[] {
  const lines = compose.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  if (start < 0) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length && (lines[i] === '' || /^ {4,}/.test(lines[i])); i++) out.push(lines[i])
  return out
}

describe.each(Object.entries(lineages))('applyOvenmitt on %s', (_label, make) => {
  it('adds the sidecar, the socket mount, the health gate and the volumes', () => {
    const out = applyOvenmitt(make(), NAME, OPTS)
    expect(hasOvenmitt(out, NAME)).toBe(true)
    const side = service(out, 'ovenmitt-scout').join('\n')
    expect(side).toContain('image: ovenmitt:test')
    expect(side).toContain('network_mode: none')
    expect(side).toContain(`- ${OPTS.configPath}:/etc/ovenmitt/ovenmitt.toml:ro`)
    expect(side).not.toMatch(/ports:/)
    const hermes = service(out, 'hermes-scout')
    expect(hermes).toContain('      - ovenmitt-sock-scout:/run/ovenmitt')
    // The agent mounts the socket volume and nothing else of ovenmitt's.
    expect(hermes.filter((l) => l.includes('ovenmitt-'))).toEqual([
      '      ovenmitt-scout:',
      '      - ovenmitt-sock-scout:/run/ovenmitt',
    ])
    const i = hermes.indexOf('      ovenmitt-scout:')
    expect(hermes[i + 1]).toBe('        condition: service_healthy')
    for (const v of ['data', 'keys', 'audit', 'sock']) {
      expect(out).toContain(`  ovenmitt-${v}-scout:\n    name: ovenmitt-${v}-scout`)
    }
    expect(out.match(/^volumes:/gm)).toHaveLength(1)
  })

  it('is idempotent and round-trips with removeOvenmitt', () => {
    const base = make()
    const once = applyOvenmitt(base, NAME, OPTS)
    expect(applyOvenmitt(once, NAME, OPTS)).toBe(once)
    expect(removeOvenmitt(once, NAME)).toBe(base)
    expect(removeOvenmitt(base, NAME)).toBe(base)
  })

  it('refreshes the image in place', () => {
    const once = applyOvenmitt(make(), NAME, OPTS)
    const again = applyOvenmitt(once, NAME, { ...OPTS, image: 'ovenmitt:v2' })
    expect(again).toContain('image: ovenmitt:v2')
    expect(again).not.toContain('image: ovenmitt:test')
    expect(again.match(/ovenmitt-scout:/g)).toHaveLength(2) // the service + the gate
  })

  it('survives the image-update path', () => {
    const once = applyOvenmitt(make(), NAME, OPTS)
    const pinned = setComposeImage(once, 'hermes-agent-mt:pinned')
    expect(service(pinned, 'ovenmitt-scout').join('\n')).toContain('image: ovenmitt:test')
  })
})

describe('applyOvenmitt refusals', () => {
  it('refuses a compose without the hermes service', () => {
    expect(() => applyOvenmitt('services:\n  other:\n    image: x\n', NAME, OPTS)).toThrow(/no "hermes-scout" service/)
  })
  it('refuses a newline in the image', () => {
    expect(() => applyOvenmitt(lineages.plain(), NAME, { ...OPTS, image: 'x\n    privileged: true' })).toThrow()
  })
  it('refuses a relative or colon-bearing config path', () => {
    expect(() => applyOvenmitt(lineages.plain(), NAME, { ...OPTS, configPath: 'rel/ovenmitt.toml' })).toThrow()
    expect(() => applyOvenmitt(lineages.plain(), NAME, { ...OPTS, configPath: '/a:/b' })).toThrow()
  })
  it('converts list-form depends_on to map form', () => {
    const compose = [
      'services:',
      '  hermes-scout:',
      '    image: x',
      '    depends_on:',
      '      - wireguard',
      '    env_file:',
      '      - /x/.env',
      '    volumes:',
      '      - /x:/opt/data',
      '',
    ].join('\n')
    const out = applyOvenmitt(compose, NAME, OPTS)
    expect(out).toContain('      wireguard:\n        condition: service_started\n      ovenmitt-scout:\n        condition: service_healthy')
  })
})

describe('setManagedEnv', () => {
  it('creates environment: on a deploy-born compose, after env_file', () => {
    const base = lineages['deploy-born']()
    expect(base).not.toContain('environment:')
    const out = setManagedEnv(base, NAME, { OVENMITT_SOCKET, PAPAREO_API_KEY: 'k$1"x\\y' })
    const hermes = service(out, 'hermes-scout')
    const envFile = hermes.indexOf('    env_file:')
    expect(hermes[envFile + 2]).toBe('    environment:')
    expect(hermes).toContain(`      - "OVENMITT_SOCKET=${OVENMITT_SOCKET}"`)
    // $ is escaped for compose interpolation; " and \ for YAML.
    expect(hermes).toContain('      - "PAPAREO_API_KEY=k$$1\\"x\\\\y"')
  })

  it('appends to an existing environment: and replaces earlier values', () => {
    const base = lineages.plain()
    const once = setManagedEnv(base, NAME, { PAPAREO_API_KEY: 'one' })
    const twice = setManagedEnv(once, NAME, { PAPAREO_API_KEY: 'two' })
    expect(twice).toContain('"PAPAREO_API_KEY=two"')
    expect(twice).not.toContain('"PAPAREO_API_KEY=one"')
    expect(twice).toContain('- HOME=/opt/data')
  })

  it('removes entries with null and drops an emptied block', () => {
    const base = lineages['deploy-born']()
    const set = setManagedEnv(base, NAME, { PAPAREO_API_KEY: 'k' })
    expect(setManagedEnv(set, NAME, { PAPAREO_API_KEY: null })).toBe(base)
    expect(setManagedEnv(base, NAME, { PAPAREO_API_KEY: null })).toBe(base)
  })

  it('refuses control characters and bad names', () => {
    expect(() => setManagedEnv(lineages.plain(), NAME, { PAPAREO_API_KEY: 'a\nb' })).toThrow(/control/)
    expect(() => setManagedEnv(lineages.plain(), NAME, { 'bad-name': 'x' })).toThrow(/invalid variable/)
  })

  it('composes with applyOvenmitt in either order', () => {
    const base = lineages['deploy-born']()
    const a = setManagedEnv(applyOvenmitt(base, NAME, OPTS), NAME, { OVENMITT_SOCKET })
    const b = applyOvenmitt(setManagedEnv(base, NAME, { OVENMITT_SOCKET }), NAME, OPTS)
    expect(a).toBe(b)
  })
})

describe('memory limit', () => {
  it('reads and rewrites the hermes memory limit on both lineages', () => {
    for (const make of [lineages.plain, lineages['deploy-born']]) {
      const base = make()
      expect(readComposeMemory(base, NAME)).toBe('2G')
      const out = setComposeMemory(base, NAME, '3G')
      expect(readComposeMemory(out, NAME)).toBe('3G')
      expect(out.replace('memory: 3G', 'memory: 2G')).toBe(base)
    }
  })
  it('refuses junk values', () => {
    expect(() => setComposeMemory(lineages.plain(), NAME, '3G\n    privileged: true')).toThrow()
  })
  it('compares units', () => {
    expect(memoryBytes('3G')).toBeGreaterThan(memoryBytes('2048M'))
    expect(memoryBytes('4096m')).toBeGreaterThan(memoryBytes('3G'))
  })
})
