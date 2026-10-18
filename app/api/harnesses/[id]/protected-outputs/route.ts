import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { protectedOutputsStatus, refreshAudit, setProtectedOutputs } from '@/lib/services/protected-outputs'

/**
 * GET /api/harnesses/:id/protected-outputs
 *
 * Status only: enabled, the vaults (each with the chats that may receive its
 * outputs, their match patterns and an optional export folder), the vaults
 * another feature needs, the agent's live surfaces, whether a consumer
 * credential is issued (never the credential), daemon health, whether the
 * bridge plugin is installed, and the last audit check (the 6-hourly timer's,
 * or a fresh one with ?audit=refresh).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // ?audit=refresh runs the audit check now instead of waiting for the timer.
  if (new URL(request.url).searchParams.get('audit') === 'refresh') {
    const h = services.harness.get(id)
    if (h?.ovenmitt?.enabled) await refreshAudit(h)
  }
  const status = await protectedOutputsStatus(id)
  if (!status) return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  return NextResponse.json(status)
}

/**
 * PUT /api/harnesses/:id/protected-outputs
 *
 * Body: `{ enabled?: boolean, vaults?: OvenmittVault[] }`, where a vault is
 * `{ name, ttl, destinations: [{ platform, match }], location?: { hostPath,
 * overwrite } }` and `vaults` replaces the whole list. Enabling adds the
 * ovenmitt sidecar, issues the consumer credential, wires both into the
 * agent's compose and recreates the agent; a failure puts everything back.
 * Changing vaults on an enabled agent only restarts the daemon. There are no
 * vaults by default, and a vault's destinations default to none: every send
 * is refused (and audited) until a platform is ticked.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let body: { enabled?: unknown; vaults?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const r = await setProtectedOutputs(id, body ?? {})
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, restarted: r.restarted, status: r.status, ...(r.pack ? { pack: r.pack } : {}) })
}
