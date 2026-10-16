import { NextResponse } from 'next/server'
import { protectedOutputsStatus, setProtectedOutputs } from '@/lib/services/protected-outputs'

/**
 * GET /api/harnesses/:id/protected-outputs
 *
 * Status only: enabled, destinations (platforms whose chats may receive
 * protected files), TTL, the agent's live surfaces, whether a consumer
 * credential is issued (never the credential), daemon health, whether the
 * bridge plugin is installed, and the last audit check.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const status = await protectedOutputsStatus(id)
  if (!status) return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  return NextResponse.json(status)
}

/**
 * PUT /api/harnesses/:id/protected-outputs
 *
 * Body: `{ enabled?: boolean, destinations?: string[], ttl?: string }`.
 * Enabling adds the ovenmitt sidecar, issues the consumer credential, wires
 * both into the agent's compose and recreates the agent; a failure puts
 * everything back. Changing destinations or TTL on an enabled agent only
 * restarts the daemon. Destinations default to none: every send is refused
 * (and audited) until a platform is ticked.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let body: { enabled?: unknown; destinations?: unknown; ttl?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const r = await setProtectedOutputs(id, body ?? {})
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, restarted: r.restarted, status: r.status, ...(r.pack ? { pack: r.pack } : {}) })
}
