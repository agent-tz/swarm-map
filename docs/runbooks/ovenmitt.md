# Protected outputs (ovenmitt) and Transcription (Papa Reo escalation)

Some tool outputs must never enter an LLM's context. The motivating case is Papa Reo, Te Hiku Media's speech recognition for te reo Māori: its outputs are licensed under the [Kaitiakitanga License](https://github.com/TeHikuMedia/Kaitiakitanga-License/blob/tumu/papareo_api.md), whose clause 3 forbids sending them to services that may collect and use them, and a hosted model provider is one. **Protected outputs** gives an agent an [ovenmitt](https://github.com/utunga/oven-mitt) vault for such outputs. The agent holds them by handle, sends them to the chat it is talking to, and cannot read them. **Transcription (Papa Reo escalation)** builds on it. <!-- FIXME: move this utunga/ URL to cyborg-garden/oven-mitt as soon as that is fixed -->

Words: an **ovenmitt vault** holds protected outputs. The **key store** (the Keys page) holds API keys. API keys never go in an ovenmitt vault.

## Turning it on

Harness → Settings → **Protected Outputs (oven-mitt)**. Or the API:

```
PUT /api/harnesses/<id>/protected-outputs   { "enabled": true }
PUT /api/harnesses/<id>/protected-outputs   { "vaults": [{ "name": "papareo", "ttl": "30d",
    "destinations": [{ "platform": "signal", "match": "signal/*" }],
    "location": { "hostPath": "/Users/me/transcripts", "overwrite": false } }] }
GET /api/harnesses/<id>/protected-outputs   # status; ?audit=refresh runs the audit check now
```

Enabling:

1. writes the daemon config to `<DATA_DIR>/compose/<name>/ovenmitt/ovenmitt.toml`: the configured vaults (none by default), each with filenames hidden from the agent, one `send` destination per ticked platform with its match, and an `fs` destination named `folder` when it has an export folder;
2. adds an `ovenmitt-<name>` service to the agent's compose and starts it. The service has no network, a read-only filesystem and no capabilities;
3. issues the agent's consumer credential, covering every vault so adding one needs no new credential. Swarm Map keeps it encrypted in `<DATA_DIR>/ovenmitt-credentials.json` (0600), never on the harness record, and no API returns it;
4. renders `OVENMITT_SOCKET` and `OVENMITT_CONSUMER_CREDENTIAL` into the hermes service's compose `environment:`, then recreates the agent;
5. installs the `protected-outputs` pack: the `ovenmitt_bridge` plugin and the `ovenmitt` skill, from pinned tags.

Any failure in steps 1–4 puts the compose, config and harness record back as they were. A failed pack install is reported but doesn't undo the rest. Install it later, or by hand: copy the plugin to `plugins/ovenmitt_bridge/` and the skill to `skills/ovenmitt/`, and add `ovenmitt_bridge` to `plugins.enabled`.

**No vault by default.** Add vaults on the card, or let a feature add the one it needs (Transcription adds `papareo`). Agents set up before vaults were configurable keep their single vault, as `private`, and their credential is re-issued on the next change so it covers every vault.

**Each vault's destinations default to none:** every send is refused, and audited, until you tick a platform. The match next to each platform decides which of its chats qualify: `<platform>/*` is every chat, or name one chat exactly (`signal/+6421…`). It must start with `<platform>/`, because that is the target the bridge declares. Changing vaults only restarts the daemon; the agent keeps running.

**Export folder.** A vault may also allow exports to a folder on this machine (an ovenmitt `fs` destination, named `folder`). The folder must exist; it is bind-mounted into the daemon only, at `/var/lib/ovenmitt/exports/<vault>`, never into the agent, and exported files are plain text there. The daemon's user must be able to write to it. The bridge has no export tool, so only a plugin that exports itself (such as papareo-transcribe) writes there. Which platforms are suitable for which outputs is your decision (see [platforms](../platforms.md#protected-outputs-destinations)).

Only a compose Swarm Map wrote (`<DATA_DIR>/compose/<name>/docker-compose.yml`) can be changed. Both lineages work, standalone and deploy-born (read_only/tmpfs), because every edit is surgical. A compose from anywhere else is refused: add the service, the socket volume and the environment entries by hand, following what Swarm Map would write.

## What the agent's container sees

Only the socket volume (`ovenmitt-sock-<name>` at `/run/ovenmitt`) and two environment entries. The bridge plugin pops the credential out of the gateway's environment as its module's first statement, so no tool or terminal child inherits it, even if the plugin fails to load.

s6-overlay also copies every compose environment value to `/run/s6/container_environment/`, world-readable. While any sealed value is present, the compose carries a small inline config, `seal-secrets-<name>`, mounted at `/etc/cont-init.d/50-seal-secrets`. s6 runs it as root before any service starts, and it locks those copies to root (`chmod 600`). The gateway still gets the values, because its run script reads them as root before dropping to the hermes user. This needs Docker Compose 2.23 or later (inline `configs.content`).

| Volume | Holds | Notes |
|---|---|---|
| `ovenmitt-data-<name>` | encrypted objects, credential hashes | |
| `ovenmitt-keys-<name>` | the vault key | **back it up separately from the data volume**: losing it loses the vault, and the daemon refuses to start rather than re-key |
| `ovenmitt-audit-<name>` | hash-chained audit log | |
| `ovenmitt-sock-<name>` | the socket | the only volume the agent mounts |

Turning Protected outputs off revokes the credential, removes the service and the environment entries, and recreates the agent. The volumes stay, so objects live out their TTL. Remove them by hand if you need them gone now (`docker volume rm ovenmitt-{data,keys,audit,sock}-<name>`). Deleting a harness doesn't remove them either.

## Sealed keys

Some providers' keys are **sealed** (`SEALED_PROVIDERS` in `lib/key-providers.ts`; today only `papareo`). Assigning one, through the usual Keys page or a `/keys?request=papareo&assign=h_<name>` link, renders it into the hermes service's compose `environment:` instead of the `.env`, removes any `.env` copy, and keeps the compose 0600 in a 0700 directory. The plugin that uses it pops it into memory at load. A sealed key (and the ovenmitt credential) is rendered only while that plugin is installed and listed in `plugins.enabled`: with nothing to pop it, it would sit in the gateway's environment. Until then the assignment is recorded and the compose holds nothing; turning on the card that installs the plugin renders it. If a pack fails to install, fix that and save the card again. Assignment is refused, before anything is saved, for an agent whose compose Swarm Map didn't write. No other key may name a sealed variable (a custom key with `PAPAREO_API_KEY`, say), and a sealed key can't be chosen as a new agent's LLM key.

## Audit

Every 6 hours (`OVENMITT_AUDIT_INTERVAL_MS`) Swarm Map runs `ovenmitt audit verify` and `ovenmitt audit review --since 6h` in each sidecar, and shows the result on the card: whether the chain verifies, the number of findings, and the worst one. Refusals are findings: an agent trying to send somewhere it isn't allowed is what you want to see. By hand:

```
docker exec ovenmitt-<name> ovenmitt audit review --since 24h
docker exec ovenmitt-<name> ovenmitt audit verify
docker exec ovenmitt-<name> ovenmitt audit head      # anchor this somewhere off-host now and then
docker exec ovenmitt-<name> ovenmitt credential list
```

## Transcription (Papa Reo escalation)

Needs Protected outputs. Turning it on (card, or `PUT /api/harnesses/<id>/transcription {"enabled": true}`):

- sets `stt.enabled: false`, so voice notes reach the agent as recordings to transcribe. **Nobody can talk to this agent by voice**; that is the cost of the design;
- sets `stt.local.model: large-v3-turbo`, the model the transcription plugin runs;
- raises the memory limit to 3G unless it is already higher;
- adds a `papareo` vault to Protected outputs if there is none, with no chats ticked. Tick the chats that may receive transcripts on the Protected Outputs card; until then the plugin keeps to local transcripts. The vault can't be removed while Transcription is on;
- installs the `papareo-transcription` pack and recreates the agent.

Turning it off puts back what it replaced, and leaves the `papareo` vault and its transcripts in place. The Papa Reo key is a sealed key: assign it on the Keys page.

## Hard, not impossible

The goal is that the agent cannot *accidentally* put protected content in its context. A determined process inside the agent container can still get at it, and these are the known ways:

- **`/proc/<pid>/environ`, and the gateway's memory.** The gateway and the other processes started from the container environment (its `s6-log`, for example) keep the credential and sealed keys in their initial environment, readable by the same uid. PID 1's is not readable. The same uid can also read the gateway's memory, where the plugins hold the values.
- **`/proc/<pid>/fd/N`** while a send is in flight. The bytes sit in an anonymous memory file for the length of one upload.
- **The host compose file** holds sealed values in plaintext, 0600, the same as the `.env`.

The control that would remove the remaining trust (an LLM-side check for vault content) is future work in ovenmitt.
