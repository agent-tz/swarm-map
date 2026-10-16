/**
 * Sealed values: secrets an agent's plugins need but its terminal tool must
 * not be able to `cat` out of a file. They live in the hermes service's
 * compose `environment:` block (which outranks the .env), never in the .env,
 * and the plugin that uses each one pops it out of the process environment
 * at load.
 *
 * Only a compose Swarm Map wrote (<dataDir>/compose/<name>/) can hold them.
 * A compose holding a sealed value is written 0600 in a 0700 directory: the
 * same posture as the agent's .env, which is the residual we accept.
 */

import fs from 'fs'
import path from 'path'
import { setManagedEnv } from './ovenmitt-compose'

/** The one compose file Swarm Map writes for an agent. */
export function swarmMapComposePath(dataDir: string, agentName: string): string {
  return path.join(dataDir, 'compose', agentName, 'docker-compose.yml')
}

/** Write a compose that may hold secrets: atomically, 0600, in a 0700 dir. */
export function writeComposeSecret(file: string, content: string): void {
  const dir = path.dirname(file)
  fs.chmodSync(dir, 0o700)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)
}

/**
 * Set (string) or clear (null) sealed entries in an agent's compose. Returns
 * whether the file changed. Throws when the agent has no Swarm-Map-written
 * compose: there is nowhere safe to put the value.
 */
export function writeSealedEnv(dataDir: string, agentName: string, entries: Record<string, string | null>): boolean {
  const file = swarmMapComposePath(dataDir, agentName)
  if (!fs.existsSync(file)) {
    throw new Error(
      `sealed keys need a compose file Swarm Map wrote, and ${agentName} has none at ${file}`,
    )
  }
  const before = fs.readFileSync(file, 'utf-8')
  const after = setManagedEnv(before, agentName, entries)
  if (after === before) return false
  writeComposeSecret(file, after)
  return true
}
