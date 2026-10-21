# Protected outputs and Papa Reo escalation

*Design summary for the Swarm Map side of this feature. The ovenmitt core and the Hermes bridge live in the [ovenmitt](https://github.com/cyborg-garden/oven-mitt) repo; the transcription plugin lives in its own repo. Operator guide: [runbooks/ovenmitt.md](../runbooks/ovenmitt.md).* <!-- FIXME: move this utunga/ URL to cyborg-garden/oven-mitt as soon as that is fixed -->

## Goal

Someone hands a Hermes agent a recording (a voice note or an audio file) and asks for a transcript. A `.txt` comes back in the same chat.

- **English:** local whisper, free. The agent also sees the text, so it can answer questions about it.
- **May contain te reo Māori:** Papa Reo, Te Hiku Media's speech recognition, transcribes the original audio. Its output goes into an ovenmitt vault and reaches the chat as an attachment **without ever entering an LLM's context**, because the Kaitiakitanga License (clause 3) forbids sending Papa Reo outputs to services that may collect and use them.

The detector is the cost valve; the vault is the licence valve. Voice as input to the agent is switched off on transcription agents, so nobody can talk to those agents by voice.

## Three homes

| Component | Home |
|---|---|
| ovenmitt core: the vault daemon, the client, and `resolve_path` (a one-shot, memory-backed file for senders that only take a path) | ovenmitt repo |
| Hermes bridge: native `ovenmitt_vault_*` tools and a generic `ovenmitt` skill, with no platform or domain names | ovenmitt repo, `hermes-plugin/` |
| Transcription: `transcribe_recording`, the detector, the Papa Reo client, the skill | its own repo |
| Wiring: the per-agent daemon, config, credential custody, sealed keys, cards, packs, audit timer | **this repo** |

Secret custody earns a place in Swarm Map; capabilities ship as pinned packs.

## Behaviour

```
recording ─▶ gateway (voice input off) ─▶ agent gets the path ─▶ transcribe_recording(path, engine="auto")
  1. local whisper large-v3-turbo, language auto-detected
  2. detector: whisper said "mi", or any macron, or the trigram share is over a threshold
  3a. no  → .txt to this chat; the agent gets the text
  3b. yes → preflight (vault up, destination declared for this chat's platform, key present)
          → Papa Reo on the original audio → text + licence footer → vault → handle
          → ovenmitt_vault_send → the platform adapter's own send_document → this chat
          the agent gets only the handle
```

Failure rules: check there is a safe way out before spending on Papa Reo. If the preflight fails, the user gets the local transcript with a note and nothing is spent. Papa Reo is never retried automatically, because a retry spends again. A send that is refused after the put leaves the object in the vault for a later resend. A detector error escalates.

The send target always comes from the gateway's session context, never from the model's arguments. The bridge accepts exactly one sender shape, `partial(adapter.send_document, chat_id)`, and reads the destination (the platform) and target (`<platform>/<chat ref>`) off that callable. The daemon checks the target against the operator's destination and audits both.

## What this repo does

- **Protected outputs card** (`lib/services/protected-outputs.ts`). It adds an `ovenmitt-<name>` sidecar to the agent's compose. The sidecar has no network, a read-only filesystem and no capabilities, and the agent mounts only its socket volume. The card also renders the daemon config (one vault, a 30-day TTL, and one `send` destination per ticked platform, default none), issues the agent's consumer credential (kept encrypted in its own 0600 file, never on the harness record), wires the socket path and credential into the hermes service's compose `environment:`, recreates the agent, and installs the `protected-outputs` pack. Steps that fail roll back. Changing destinations or the TTL restarts only the daemon.
- **Surgical compose edits** (`lib/services/ovenmitt-compose.ts`). Every edit is line-based and idempotent, so standalone (plain and VPN) and deploy-born composes all work. Regenerating a deploy-born compose would strip its hardening. The settings route re-applies the wiring after any template regeneration.
- **Sealed keys** (`lib/key-providers.ts`, `lib/services/sealed-env.ts`). `papareo` is flagged sealed. Assigning it renders `PAPAREO_API_KEY` into the compose `environment:` instead of the agent's `.env` (which the agent's terminal can read), strips any `.env` copy, and keeps the compose 0600. All of this runs through the existing `writeKeyToEnv`/`removeKeyFromEnv` choke point.
- **Transcription card** (`lib/services/transcription.ts`). It sets `stt.enabled: false` and `stt.local.model: large-v3-turbo`, raises memory to 3G unless it is already higher, and installs the `papareo-transcription` pack. Turning it off restores what it replaced.
- **Packs** in `infra/artifacts.json`: `protected-outputs` and `papareo-transcription`, both `public: false` with pinned `git:` sources. The existing pack sync installs only local artifacts, so the cards install a pack's git entries with `installArtifacts` (fetch at the tag, then the trust gate), enable its plugins and record the pack in the agent's stamp.
- **Audit timer** (`lib/services/ovenmitt-audit-scheduler.ts`), copied from the integrity sweep. Every 6 hours it runs `ovenmitt audit verify` and `audit review --since 6h` in each sidecar, and the card shows the result.

## Who can see what

| Thing | Lives in | Agent terminal can read it? |
|---|---|---|
| Vault keys, data, audit log | sidecar volumes | no |
| Daemon config | host, mounted read-only into the sidecar | no |
| Consumer credential, Papa Reo key | key store (encrypted) → compose `environment:` → popped into plugin memory at load | only via the same-uid `/proc/<pid>/environ` of processes started from the container environment (accepted residual) |
| Papa Reo output | vault → memory file for one send → platform | only via `/proc/<pid>/fd/N` during the upload (accepted residual) |
| Local transcript | the model's context | yes, by design: unflagged |

The bar is "hard, not impossible": the agent cannot *accidentally* put protected content in its context. A check for vault content on the model side is future work in ovenmitt.

## Destinations

Every messaging platform is a third party under the licence. For Papa Reo output, Signal is the likely-compatible case (end to end encrypted; signal-cli keeps no copy of sent attachments). Discord stays unticked until Te Hiku Media clears it. See [platforms](../platforms.md#protected-outputs-destinations).

## Acceptance

1. An English memo: a local `.txt`; no vault `put`; no Papa Reo usage.
2. A mixed memo: a `.txt` attachment with the licence footer. The audit log shows `put` and `resolve` with target `signal/<chat>`. The session's model requests contain none of the Papa Reo text.
3. "Send this to Papa Reo" on an English memo produces an attachment.
4. Leak attempts fail safely and are audited: "read it back" (there is no read path); `cat` on the socket directory; the credential and key are absent from the agent's terminal environment and `.env`; there is no argument that sends to another chat.
5. `audit verify` passes; `audit review` lists the refusals.
6. A platform with no destination: the send is refused and audited.
7. Enable and disable round-trip on a deploy-born compose; tests green; drift clean.
