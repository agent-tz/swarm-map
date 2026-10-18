/**
 * Where an agent's model calls go: on this machine (or its local network),
 * or to a remote host. Used before an operator declares an agent compliant
 * with the Kaitiakitanga License, which forbids sending Papa Reo output to
 * services that may collect and use it.
 *
 * Read from config.yaml by line, like the other readers here, never
 * re-serialised. It reads the main model, every fallback_providers row and
 * every auxiliary task that names its own provider or endpoint. It can't see
 * everything (a tool that calls a model on its own, say), so a clean result
 * means "nothing configured points off this machine", not a guarantee.
 */

export type ModelHost = {
  role: string // e.g. "main model", "fallback 1", "auxiliary: compression"
  provider: string | null
  baseUrl: string | null
  local: boolean
  why: string // short reason for the classification
}

export type ModelHosting = {
  hosts: ModelHost[]
  remote: ModelHost[]
  // Hosted-provider keys present in the agent's .env: a provider left on
  // "auto" may use one of these.
  hostedKeys: string[]
}

// Providers that run on the operator's own machine.
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama-cpp', 'mlx', 'vllm', 'local'])

const HOSTED_KEY = /^(ANTHROPIC|OPENAI|OPENROUTER|GOOGLE|GEMINI|GROQ|MISTRAL|TOGETHER|DEEPSEEK|XAI|NOUS|FIREWORKS|COHERE|PERPLEXITY)_API_KEY=\S/

/** Whether a URL's host is this machine, a container on it, or a private network. */
export function isLocalUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (['localhost', '::1', 'host.docker.internal', 'host.containers.internal', 'host.orb.internal'].includes(host)) {
    return true
  }
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true
  // A bare service name (no dot) resolves inside the compose network.
  if (!host.includes('.') && !host.includes(':')) return true
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  }
  return false
}

function classify(role: string, provider: string | null, baseUrl: string | null): ModelHost {
  if (baseUrl) {
    const local = isLocalUrl(baseUrl)
    return { role, provider, baseUrl, local, why: local ? 'endpoint on this machine or network' : 'remote endpoint' }
  }
  const p = (provider ?? '').toLowerCase()
  if (LOCAL_PROVIDERS.has(p)) return { role, provider, baseUrl, local: true, why: 'local provider' }
  if (p === 'custom' || p === '') {
    return { role, provider, baseUrl, local: false, why: 'no endpoint configured, so it cannot be checked' }
  }
  return { role, provider, baseUrl, local: false, why: 'hosted provider' }
}

const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, '')

/** Lines of a top-level block (`key:` at column 0), without the header. */
function block(lines: string[], key: string): string[] {
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `) || l.startsWith(`${key}:\t`))
  if (start < 0) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i])); i++) out.push(lines[i])
  return out
}

function scalar(lines: string[], indent: number, key: string): string | null {
  const re = new RegExp(`^ {${indent}}${key}:\\s*(.+?)\\s*(#.*)?$`)
  for (const l of lines) {
    const m = l.match(re)
    if (m) return unquote(m[1]) || null
  }
  return null
}

export function modelHosting(config: string, env = ''): ModelHosting {
  const lines = config.split('\n')
  const hosts: ModelHost[] = []

  const model = block(lines, 'model')
  hosts.push(classify('main model', scalar(model, 2, 'provider'), scalar(model, 2, 'base_url')))

  // fallback_providers: a list of rows, each `- provider: …` with optional base_url.
  let row: { provider: string | null; baseUrl: string | null } | null = null
  const rows: { provider: string | null; baseUrl: string | null }[] = []
  for (const l of block(lines, 'fallback_providers')) {
    const item = l.match(/^\s*-\s+(\w+):\s*(.*)$/)
    const field = item ?? l.match(/^\s+(\w+):\s*(.*)$/)
    if (item) {
      row = { provider: null, baseUrl: null }
      rows.push(row)
    }
    if (!field || !row) continue
    if (field[1] === 'provider') row.provider = unquote(field[2]) || null
    if (field[1] === 'base_url') row.baseUrl = unquote(field[2]) || null
  }
  rows.forEach((r, i) => hosts.push(classify(`fallback ${i + 1}`, r.provider, r.baseUrl)))

  // auxiliary.<task>: only tasks that name their own provider, endpoint or a
  // "provider/model" model; the rest follow the main model.
  const aux = block(lines, 'auxiliary')
  const tasks = aux.map((l, i) => ({ l, i })).filter(({ l }) => /^ {2}[A-Za-z_]+:\s*$/.test(l))
  tasks.forEach(({ l, i }, n) => {
    const end = n + 1 < tasks.length ? tasks[n + 1].i : aux.length
    const body = aux.slice(i + 1, end)
    const task = l.trim().slice(0, -1)
    let provider = scalar(body, 4, 'provider')
    const baseUrl = scalar(body, 4, 'base_url')
    const modelName = scalar(body, 4, 'model')
    if ((!provider || provider === 'auto') && modelName?.includes('/')) provider = modelName.split('/')[0]
    if ((!provider || provider === 'auto') && !baseUrl) return
    // "custom/<model>" on the same custom endpoint as the main model.
    const sameEndpoint = provider === 'custom' && !baseUrl ? hosts[0].baseUrl : baseUrl
    hosts.push(classify(`auxiliary: ${task}`, provider, sameEndpoint))
  })

  const hostedKeys = env
    .split('\n')
    .filter((l) => HOSTED_KEY.test(l))
    .map((l) => l.split('=')[0])
  return { hosts, remote: hosts.filter((h) => !h.local), hostedKeys: [...new Set(hostedKeys)].sort() }
}
