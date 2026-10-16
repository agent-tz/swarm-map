/**
 * Server-side timer for the ovenmitt audit check (Protected outputs).
 *
 * Copied from the integrity sweep (integrity-scheduler.ts): HSM has no job
 * runner, so a plain unref'd setInterval registered from instrumentation.ts
 * is the whole scheduler. Every 6h, for each agent with Protected outputs on,
 * it runs `ovenmitt audit verify` and `ovenmitt audit review --since 6h` in
 * the agent's sidecar and caches the finding count and the worst finding for
 * the Protected outputs card. No host cron needed.
 */

import { services } from '@/lib/services'
import { refreshAudit } from './protected-outputs'

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
const INITIAL_DELAY_MS = 60 * 1000 // after boot, and after the integrity sweep starts

export async function runScheduledAuditCheck(): Promise<void> {
  try {
    const targets = services.harness.list().filter((h) => h.ovenmitt?.enabled)
    for (const h of targets) {
      try {
        await refreshAudit(h)
      } catch (err) {
        console.error(`[ovenmitt] audit check failed for ${h.name}:`, err)
      }
    }
  } catch (err) {
    // A failed check must never take the server down; a stale card beats a crash.
    console.error('[ovenmitt] audit check failed:', err)
  }
}

declare global {
  var __hsmOvenmittAuditSchedulerStarted: boolean | undefined
}

export function startOvenmittAuditScheduler(): void {
  if (globalThis.__hsmOvenmittAuditSchedulerStarted) return
  globalThis.__hsmOvenmittAuditSchedulerStarted = true

  const envInterval = parseInt(process.env.OVENMITT_AUDIT_INTERVAL_MS ?? '', 10)
  const intervalMs = Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS

  const initial = setTimeout(() => void runScheduledAuditCheck(), INITIAL_DELAY_MS)
  initial.unref?.()
  const recurring = setInterval(() => void runScheduledAuditCheck(), intervalMs)
  recurring.unref?.()
}
