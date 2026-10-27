# Faceclaw T3 Bridge server

Local, authenticated bridge between the Faceclaw T3 app and the T3 Code environments on this computer and its explicitly paired peers. The bridge exposes project/session reads, a reduced provider/model catalog, transcript reads, turn sends and steering, bounded activity summaries, voice transcription, and public weather lookups. It never exposes T3 filesystem, terminal, approval, account, or auth-management APIs. Speech recognition runs locally through whisper.cpp. No API key or cloud transcription service is required.

Phones connect only through the native Faceclaw endpoint. The [Faceclaw integration guide](../docs/faceclaw.md) covers its transport, on-demand Luna refinement, the project-scoped Codex provider launcher for glasses tools, and the isolated fixture for emulator UI testing. The optional [Signal service](../docs/signal.md) serves the Signal APK's legacy bridge mode.

### Public Faceclaw capability relay

The native endpoint implements Faceclaw capability protocol v1 independently of
T3 tool names. A connected bridge adapter registers its current callable catalog
with `faceclaw.capabilities.register { protocolVersion: 1, catalogRevision,
projectId, tools }`. Revisions must increase during one socket connection. Calls
arrive as `faceclaw.capability.call`; the adapter answers once with
`faceclaw.capabilities.result`. Legacy `faceclaw.tools.*` names remain accepted
for rolling upgrades.

The project-scoped MCP endpoint exposes that catalog through ordinary `tools/list`
and `tools/call`. It validates arguments against each registered schema before
dispatch, binds calls to the provider session or thread credential, records replay
receipts before sending, and treats disconnect or timeout as an unknown outcome.
Another assistant bridge can implement these same generic messages without T3
code or provider-specific knowledge. The phone-side adapter remains responsible
for its Faceclaw host approval, `device-tools` grant, pairing identity, catalog
updates, and result-visibility filtering.

Dynamic tools retain their version, installed provider identity, kind, visibility,
durability, operation class, and standard profile IDs under the namespaced MCP
`_meta["org.faceclaw/capability"]` object. Clients may ignore that metadata; bridges
can use it for explicit provider choice, profile matching, and audit displays.

## Security model

The phone is an untrusted network client. The bridge holds the T3 credential and returns a reduced data model. It omits workspace paths, attachments, raw activity and tool payloads, tool results, and upstream error bodies. Live activity may include a bounded, redacted label such as an exact command preview. Transcript message text remains sensitive because showing it is the app's purpose.

Defaults are deliberately narrow:

- Bind a loopback address only. Startup fails for any other `BRIDGE_HOST`.
- Require a 32-character or longer base64url owner `BRIDGE_TOKEN`. It stays on the computer for local tools, the provider launcher, and owner-only HTTP routes.
- Keep `BRIDGE_PASSPHRASE` opt-in. Pairing exchanges it through a rate-limited endpoint for a separate native token derived from the owner token. The native token cannot authenticate owner routes, provider provisioning, or MCP tools. The phone never stores the passphrase.
- Reject every request that carries a browser `Origin` header. No browser client has a route on this bridge.
- Start new T3 sessions in `approval-required` mode.
- Validate every new-session provider, model, and reasoning choice against a fresh T3 catalog before creating the thread.
- Force normal speed with `serviceTier: "default"` or `fastMode: false` when the selected model supports that setting.
- Cap JSON, audio, upstream responses, socket queues, subscriptions, request rate, and network timeouts.
- Keep audio in memory only. The bridge zeroes PCM and WAV buffers after preview, finish, cancel, disconnect, or failure.
- Accept only a numeric loopback `WHISPER_SERVER_URL`, so configuration cannot send dictated audio to another host.
- Launch whisper.cpp on `127.0.0.1` with a random request path and no `ffmpeg` conversion. Every inference request sets `no_context=true`.
- Suppress whisper-server output so dictated text does not enter bridge logs.

Do not put `BRIDGE_TOKEN` or `T3_ACCESS_TOKEN` in app source or APK builds. Enter the bridge URL and pairing passphrase at runtime in the T3 app's settings. The phone discards the passphrase and stores the returned native token. Treat that stored token as a bearer credential.

## Optional assistant archive

The optional assistant archive is supported on macOS and Linux only, like the other POSIX-only features listed under [Configuration](#configuration). Its filesystem protections require POSIX ownership checks, no-follow file opens, and directory synchronization. Windows rejects archive configuration before accessing files; leave `BRIDGE_ARCHIVE_PROJECT_ID` and `BRIDGE_ARCHIVE_WORKSPACE_ROOT` unset there. T3 access, weather, and local voice transcription remain available on Windows.

## Install and run

Requirements:

- Node.js 22.16 or newer
- A running T3 Code environment
- whisper.cpp `whisper-server` and the verified `base.en` model (Homebrew on macOS; a native build on Windows/Linux)

Use the [installer skill](../skills/t3-bridge-deploy/SKILL.md) for automated Windows, macOS, or Linux setup. For macOS deployment, run from the repository root:

```bash
./scripts/install.sh --dry-run
./scripts/install.sh
./scripts/service.sh status
```

The interactive installer keeps long-lived credentials in private user-only files outside the repository, configures private Tailscale HTTPS, installs the login LaunchAgent, starts the managed Whisper listener, and prints the T3 bridge URL. See the root [`README.md`](../README.md) for phone setup.

The commands below are the manual development path.

```bash
cd bridge
npm install
npm run setup:whisper
export BRIDGE_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
read -r -s "BRIDGE_PASSPHRASE?Pairing passphrase: "
printf '\n'
export BRIDGE_PASSPHRASE
npm run start:t3
```

The hidden prompt keeps the passphrase out of shell history. Unset `BRIDGE_PASSPHRASE` to disable pairing.

`setup:whisper` installs the Homebrew `whisper-cpp` formula when needed. It downloads `ggml-base.en.bin` to `~/Library/Application Support/Even T3 Bridge/models/`, caps the download at its expected size, and checks its published SHA-256 before installation. An existing model with the wrong digest is never overwritten automatically.

`start:t3` is the recommended macOS path. It starts the bridge immediately and supervises T3 and whisper.cpp independently. Missing or unavailable providers do not stop the bridge from listening. T3 readiness and local Whisper startup retry every ten seconds without dropping the phone connection.

The launcher finds `T3 Code.app` or `T3 Code (Alpha).app`, creates a two-minute one-time pairing credential, and exchanges it for a bearer token with only `orchestration:read orchestration:operate`. It validates the authenticated descriptor before enabling local T3 methods. That credential stays in the bridge process and is revoked on refresh or graceful shutdown.

The launcher authenticates only to its local T3 server. When peer federation is enabled, it independently aggregates the local environments exported by explicitly paired bridges over Tailscale. It does not read or refresh T3 Connect's CLI OAuth credential. See [peer setup, trust, protocol, and rollback](../docs/peers.md).

The catalog includes the local primary and enrolled peers (`kind: "peer"`). Imported environments are never re-exported. T3 desktop-only connection profiles are not scraped. Assistant archives, Faceclaw tool grants, and generated provider launchers remain restricted to the local primary environment.

T3 CLI and Whisper child environments exclude bridge and T3 secrets. Managed Whisper listens on numeric loopback with an unguessable request path. Missing transcription produces a temporary-unavailable error while T3 actions stay available. Set `T3_APP_PATH`, `WHISPER_CPP_SERVER_PATH`, or `WHISPER_MODEL_PATH` when those files live elsewhere.

The wrapper uses `~/.t3` by default. Set `T3_BASE_DIR` only when the running T3 environment uses another state directory. An ungraceful machine or process kill may prevent revocation. Check T3 Code's authorized clients after a crash and revoke any `even-t3-bridge-*` session.

Windows and Linux use the [portable installer](../skills/t3-bridge-deploy/references/windows-linux.md), which discovers an explicit T3 executable/server entry and manages pairing locally. For a manually managed development deployment only, provide an existing bearer token with exactly the two orchestration scopes and run:

```bash
export T3_ACCESS_TOKEN="..."
export T3_BASE_URL="http://127.0.0.1:3773"
export BRIDGE_TOKEN="..."
whisper-server --host 127.0.0.1 --port 8178 --request-path /even-t3 --model /absolute/path/to/ggml-base.en.bin
export WHISPER_SERVER_URL="http://127.0.0.1:8178/even-t3/inference"
npm run build
npm start
```

To test pairing and transport without T3, `T3_ACCESS_TOKEN` may be omitted with `npm start`. This selects an explicitly unavailable T3 provider and makes no T3 request with placeholder credentials.

The glasses choose a live provider, model, and optional reasoning level for each new session. A project does not need a stored default model.

## Tailscale networking

Keep the bridge on loopback and put Tailscale Serve in front of it:

```bash
tailscale serve --bg --https=8443 localhost:8787
```

Enter `wss://<machine>.<tailnet>.ts.net:8443/v1/faceclaw/events` as the bridge URL in the T3 app. Do not use Tailscale Funnel or expose this bridge to the public internet. Direct LAN listening is not supported.

## WebSocket protocol

Connect to `/v1/faceclaw/events` without an `Origin` header, using the native token from pairing and both subprotocols:

```ts
new WebSocket(bridgeUrl, ["even-t3-v1", `auth.${nativeToken}`]);
```

The bridge authenticates `auth.<token>` but selects and echoes only `even-t3-v1`. Clients may send `Authorization: Bearer <token>` instead. Query-string tokens are not supported. Native-only methods (`faceclaw.*`, `refinement.*`) are listed in the [integration guide](../docs/faceclaw.md#native-transport).

Request:

```json
{ "v": 1, "type": "request", "id": "req-1", "method": "sessions.list", "params": {} }
```

Success and failure:

```json
{ "v": 1, "type": "response", "id": "req-1", "ok": true, "result": {} }
{ "v": 1, "type": "response", "id": "req-1", "ok": false, "error": { "code": "invalid_request", "message": "..." } }
```

Server event:

```json
{ "v": 1, "type": "event", "event": "sessions.changed", "payload": {} }
```

Methods:

- `environments.list {}` returns the secret-free catalog with each environment's ID, label, source kind, status, primary flag, and server version when available.
- T3 resource and mutation methods accept an optional `environmentId`: `models.list`, `transcript.get`, `transcript.unsubscribe`, `thread.start`, `assistant.start`, `thread.settle`, `thread.model.set`, `thread.reasoning.set`, `plan.submit`, `plan.approve`, `turn.send`, and `turn.steer`. Omitting it preserves the legacy local-primary behavior.
- `weather.locations { query }` searches Open-Meteo's fixed geocoding endpoint and returns `{ locations }` with bounded IDs, city names, regions, countries, and rounded coordinates.
- `weather.current { latitude, longitude }` returns `{ temperatureC, condition, observedAt, fetchedAt }` from Open-Meteo's fixed forecast endpoint. These methods use the existing WebSocket authentication and request limits. The bridge rejects redirects, caps provider responses and concurrent requests, coalesces requests, caches weather for 15 minutes, and returns sanitized failures. Coordinates and provider response bodies are not logged. No provider credential is required for the noncommercial service.
- `thread.settle { threadId }` returns `{ threadId, settled: true, sequence }`. Requires an authorized, unarchived thread with no running turn or pending input. The bridge checks fresh state, then dispatches T3’s native settlement command, which atomically rejects concurrent starts and blocking requests. Older installed bridges require a runtime update.
- `sessions.list {}` returns `{ snapshotId, frozenAt, unsettled, settled, environments, partial }` aggregated across connected environments. Both groups sort by `lastActivityAt`, newest first. The response is one frozen snapshot. Entries carry `environmentId` and `environmentLabel`, so resource identity is `(environmentId, id)`, not a bare thread ID. The client decides when to replace it. Like T3's sidebar, `settled` holds only each environment's 25 most recently settled threads, and subagent child threads are left out unless one is waiting on a question. Both stay readable through `transcript.get`.

Session summaries in lists, `sessions.changed`, and transcripts also include `completedTurn: { id, completedAt } | null`. It is present only for an explicitly completed latest turn with a valid bounded ID and timestamp. The client treats the field as optional for compatibility with older bridges. It does not infer completion from the settled flag.

Session summaries and transcripts also include `background: "subagents" | "monitoring" | null`. It mirrors T3's in-memory background liveness. `subagents` means subagents or workflows are still running after the turn. `monitoring` means only Monitor loops or background shells remain. Clients should not treat a completed turn as finished while `background` is set. Because T3 does not persist this state, the bridge emits `sessions.changed` when it changes even if the shell sequence does not. After a T3 restart it reads `null` until new task events arrive.

`sessions.list` adds `pendingQuestion` to unsettled sessions blocked on a structured question. It holds the first question's text, flattened to one line and capped at 280 characters, with a `(+N more)` suffix when more questions are pending. The bridge reads up to eight threads per call to find it. A failed read omits the field.
- `projects.list {}` returns `{ snapshotId, projects, environments, partial }` across connected environments. Each project has `environmentId`, `environmentLabel`, `id`, `title`, `canStartSession`, and `updatedAt`.
- `models.list { environmentId? }` returns one environment's catalog when selected, or a flat aggregate list when omitted. It exposes usable provider/model choices and model-specific reasoning levels while omitting T3 option IDs, account details, and authentication state.
- `transcript.get { environmentId?, threadId }` returns `{ snapshotId, session, turns, liveActivity, liveActivities }` and subscribes that socket to transcript updates. `transcript.unsubscribe { environmentId?, threadId }` releases that socket's subscription when the reader leaves a session. A user message starts a turn. Following assistant/system messages stay in that turn until the next user message. Each turn includes `durationSeconds` and `separatorLabel`. During an active turn, `liveActivity` reports the current thinking or tool phase. `liveActivities` contains at most 32 ordered markers with bounded, redacted display labels, stable bridge IDs, and timestamps. Supported command activities may include the redacted command preview that T3 shows. Both activity fields become empty when the turn settles. Raw tool arguments, results, correlation IDs, and upstream error bodies never cross the bridge.

When T3 marks the latest turn completed and identifies its authoritative assistant message, the bridge removes temporary assistant progress messages from that turn. The identifier must match a bounded assistant message on the same turn. Missing or invalid identifiers leave all messages intact.
- `thread.start { projectId, modelSelection: { instanceId, model, reasoningId? }, text }` creates the thread, then starts its first turn, both with server-selected `full-access`. It returns `{ threadId, text, sequence }`.
- `assistant.start { projectId, modelSelection: { instanceId, model, reasoningId? }, text }` creates an Ask assistant thread and its first turn with server-selected `full-access`. It performs the same project/model checks as ordinary creation. Clients cannot supply an arbitrary runtime mode. Ordinary `thread.start` also uses `full-access`. Existing-thread sends preserve the thread's current mode.
- `turn.send { threadId, text }` starts a turn in an existing, idle thread. It returns `{ threadId, text, sequence }`.
- `turn.steer { threadId, text }` adds steering to a running or starting turn. It returns `{ threadId, text, sequence }`. T3 does not expose an atomic expected-turn precondition, so a turn can settle between the bridge status check and dispatch.
- `voice.start {}` opens one recording and returns `{ maxBytes, sampleRate: 16000, channels: 1, format: "pcm_s16le" }`.
- Binary frames after `voice.start` are raw little-endian signed 16-bit, 16 kHz, mono PCM. Each frame must contain an even number of bytes.
- During capture, `voice.partial` events carry `{ text }`. The default cadence is every two seconds. Each update replaces the previous draft rather than appending to it.
- `voice.finish {}` stops audio intake, transcribes the full recording, and returns `{ text }`. It does not call T3. The client must show this final draft before using `assistant.start`, `thread.start`, or `turn.send` on a later, explicit action.
- `voice.cancel {}` aborts transcription when possible, zeroes audio, and returns `{ cancelled }`.

Events are `bridge.status`, `sessions.changed`, `transcript.changed`, `subscription.error`, `archive.status`, `voice.partial`, and `voice.error`. The bridge polls T3 snapshots and emits changes by `snapshotSequence`; default interval is 500 ms.

## Existing plan-mode input

`transcript.get` adds optional `pendingPlanInput` with a request ID, revision, turn ID, creation timestamp, and bounded questions/options. It is derived only from a pending V2 `user_input` runtime request and its `user_input_request` turn item; resolved, expired or cancelled requests are removed. Tool approvals are not exposed through this path.

Authenticated `plan.submit { threadId, requestId, revision, answers }` accepts exactly one answer for every question. Each answer is `{ questionId, optionIndexes, text }`: selected option indexes or a nonempty custom answer. Multi-select questions may contain several indexes. The bridge freshly checks the thread's project permissions, active request and revision, rejects incomplete/duplicate/invalid answers, and dispatches `runtime-request.respond` with a stable command ID. Selected options are sent as each option's T3 `value`, which defaults to its label. It preserves runtime permissions and interaction mode. T3 deduplicates that command ID durably; the bridge also coalesces identical concurrent submissions. Transport uncertainty produces `plan_submission_uncertain`, never a normal message fallback. See [plan approval and session controls](../docs/faceclaw.md#plan-approval-and-session-controls).

## Adding bridge services

`src/service-registry.ts` provides an explicit service registry for future app data or bridge-hosted tools. `createBridgeServer` composes its services once, in process. A definition contains a namespace and named handlers; the wire method is the exact `namespace.method` pair. Weather currently registers only `weather.locations` and `weather.current`.

To add a service, implement its operations and register closures in `createBridgeServer`. Each handler receives the request parameter object, validates its own schema, and returns a reduced result. Keep resource bounds, operation-specific permissions, timeouts, and safe errors in the service. Handlers that make network requests should use explicitly configured destinations and reject redirects that could escape those destinations. Never accept a client-supplied URL as a general proxy.

The registry runs only after the existing WebSocket authentication and frame checks. Unknown methods retain the `method_not_found` response, and the existing socket error mapper sanitizes unexpected failures. Registration rejects duplicate namespaces and reserves the T3/session/voice namespaces. Core T3 and voice routing stays separate. Services receive no credentials or broad T3 capabilities unless explicitly supplied through trusted server composition.

This is an extension point only. There is no RSS reader, arbitrary-URL fetch method, client-controlled registration, dynamic module loading, or new HTTP route. Add matching T3 app protocol types when implementing a concrete service, then cover invalid input, unauthorized access, resource limits, and safe failure behavior in tests.

## HTTP routes

Every route rejects a browser `Origin` header.

- `GET /health` is unauthenticated and returns only `{ "status": "ok" }`.
- `GET /v1/status` and `GET /v1/environments` require the owner `BRIDGE_TOKEN`. Local tools use them for readiness and peer checks.
- `POST /v1/faceclaw/pair` accepts `{ passphrase }`, allows five attempts per client address every five minutes, and returns the native `{ token }` only after a constant-time match.
- Owner-only provisioning, provider-session, and MCP routes under `/v1/faceclaw/` are described in the [integration guide](../docs/faceclaw.md).
- Peer routes under `/v1/peer/` use their own credentials; see [peer setup](../docs/peers.md).

## Configuration

See `.env.example`. The process does not load `.env` automatically.

Useful controls:

- `BRIDGE_PASSPHRASE` enables the phone pairing exchange. It has no default. Unset it to disable pairing.
- `BRIDGE_FACECLAW_PROJECT_ID` enables glasses tools for one T3 project. `BRIDGE_REFINEMENT_CODEX_PATH` enables Luna refinement. See the [integration guide](../docs/faceclaw.md).
- `BRIDGE_SIGNAL_CLI_PATH` and `BRIDGE_SIGNAL_DATA_DIR` together enable the [Signal service](../docs/signal.md).
- `BRIDGE_PEER_DIRECTORY` enables [peer federation](../docs/peers.md).

Peer federation, the Signal service, Luna refinement, and the provider launcher protect their state with POSIX ownership checks. They are supported only on macOS and Linux; on Windows the bridge refuses to start with those settings instead of running them unprotected. Core T3 access, weather, and local voice transcription work on all three platforms.
- `BRIDGE_PROJECT_IDS` restricts all lists, transcript reads, and sends to a comma-separated project ID allowlist.
- `BRIDGE_RUNTIME_MODE` remains accepted for older installation configurations (`approval-required`, `auto-accept-edits`, `auto`, or `full-access`), but does not select new-session permissions. All new app sessions and their first turns use `full-access`, even when an existing installation sets `approval-required`. They can perform workspace actions without supervised approval prompts. Existing conversations keep their current mode. Update the running computer bridge for this policy to take effect.
- `BRIDGE_MAX_VOICE_BYTES` defaults to `9600000`, or five minutes of the required PCM format.
- `WHISPER_SERVER_URL` must be an HTTP URL on numeric loopback and end in `/inference`. `start:t3` configures this automatically.
- `WHISPER_LANGUAGE` defaults to `en`. Set `auto` for detection or a two-to-three-letter language code when using a multilingual model.
- `WHISPER_PARTIAL_INTERVAL_MS` defaults to `2000` and accepts `1000` through `10000`.
- `WHISPER_TRANSCRIPTION_TIMEOUT_MS` defaults to `60000` per partial or final pass.

## T3 compatibility

Requires T3 Code orchestration protocol 2 (orchestration V2). Implemented and tested against T3 Code `0.0.46-nightly.20261013.3053` on October 13, 2026. It relies on:

- `GET /.well-known/t3/environment`, which must report `orchestrationProtocolVersion: 2`
- `GET /api/orchestration/shell` and `GET /api/orchestration/threads/:threadId`, sent with `x-t3-orchestration-protocol: 2`
- authenticated Effect RPC over `/ws?orchestrationProtocol=2`: `server.getConfig` and `orchestration.dispatchCommand`
- `thread.create` followed by `message.dispatch` with `deliveryIntent` (`auto` or `steer`); T3 resolves steering and queueing against its own thread state (`serverResolvedCommandContext`)
- `thread.model-selection.set`, `thread.interaction-mode.set`, `thread.settle`, and `runtime-request.respond`
- bearer session claims containing `sid`, used only by the macOS launcher for revocation

`src/t3-v2.ts` maps V2 runs, turn items, runtime requests and plans onto the bridge's internal session shapes, so the glasses protocol and peer protocol did not change. A run is a turn: its id is the transcript turn id and `completedTurn.id`. Threads imported from V1 history have no runs; their transcripts group by user message and report `idle`. V1 servers are rejected as incompatible.

The launcher mints T3 credentials with the CLI of T3's active runtime (`<base dir>/runtime/service-state.json`, `activeVersion`), because T3 updates itself into a new versioned directory and an older CLI issues pairing credentials the newer server rejects. Without runtime state it uses `T3_CLI_EXECUTABLE` (plus `T3_CLI_ENTRY` for Electron or Node) or, on macOS, the installed app bundle whose version matches the running server.

T3 does not yet publish these orchestration contracts as a stable third-party SDK. Provider activation checks `threadSettlement`; response guards reject incompatible shapes; errors never return upstream bodies. An unavailable or incompatible T3 provider does not prevent the phone bridge from listening. Re-run this bridge's tests and a real create/send/stream smoke test after every T3 upgrade.

## Checks

```bash
npm test
npm run typecheck
npm run build
```

Reference material: [T3 remote architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md), [T3 environment authentication](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server), and [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Existing-session controls

Authenticated glasses RPC supports `thread.reasoning.set` with `threadId`, `reasoningId`, and `expectedModel: { instanceId, model }`. The bridge checks fresh project/thread visibility, rejects active turns or pending input, confirms the model has not changed, and validates reasoning against T3's fresh provider catalog. It writes `thread.model-selection.set` while preserving the provider, model, unrelated options, and runtime permissions. V2 applies the selection when the next run starts, so the bridge no longer stops the provider session.

`turn.send` accepts optional `interactionMode` (`default` or `plan`) and `reasoningId`. Mode selection is persisted through `thread.interaction-mode.set` before starting the reviewed message. `turn.steer` accepts only `threadId` and `text`; active-turn mode/reasoning changes are rejected. Mode and turn start are separate T3 commands: a failed send may leave the selected mode in place and is never retried automatically.

Transcripts expose `session.interactionMode`, the bounded public selection fields in `session.modelSelection`, and `pendingProposedPlan` when a completed plan is actionable. Older frontends can ignore these additive fields; frontends hide controls when the fields are absent. See [completed-plan approval and limitations](../docs/faceclaw.md#plan-approval-and-session-controls) for `plan.approve`.
