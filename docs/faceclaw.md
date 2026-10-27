# Faceclaw bridge integration

The Faceclaw T3 app connects through a native endpoint for projects, sessions, the model catalog, transcripts, plan questions, settlement, and voice. The bridge has no browser routes; every request with an `Origin` header is rejected, except the loopback-only [Signal setup page](signal.md). Building this repository changes no installed service or T3 provider configuration.

## Local UI testing

From this repository:

```sh
npm ci
npm ci --prefix bridge
npm --prefix bridge run build
node scripts/faceclaw-dev-server.mjs
```

The isolated fixture listens on loopback port 18790. In the Android emulator use `ws://10.0.2.2:18790/v1/faceclaw/events` and pairing passphrase `local-faceclaw-fixture`. On the host use `ws://127.0.0.1:18790/v1/faceclaw/events`. These public fixture credentials must never be used for a real bridge. The fixture never loads installed configuration, real credentials, or user T3 data.

Projects `assistant` and `faceclaw` contain a welcome conversation and an active plan question. New sessions and messages generate a completion after three seconds. Model selection, plan submission, settlement, and voice routes use the actual bridge protocol with synthetic data. Voice transcription returns a fixed sentence. Refinement is disabled in the fixture. This verifies application flow, not real speech recognition, model execution, Bluetooth, wake behavior, or Android message handoff.

## Native transport

Faceclaw pairs with `POST /v1/faceclaw/pair`, no Origin header, JSON `{ "passphrase": "..." }`. It returns `{ "token": "..." }`. The native token is derived for Faceclaw alone; it cannot authenticate owner HTTP routes, provider provisioning, or MCP tools.

Connect to `/v1/faceclaw/events` without Origin and with WebSocket subprotocols `even-t3-v1` and `auth.<token>`. Native clients may instead use the Authorization bearer header while retaining the `even-t3-v1` subprotocol. RPC/event frames and binary voice frames match the documented [bridge protocol](../bridge/README.md#websocket-protocol). The phone should use private HTTPS/WSS outside local emulator testing.

Additional native-only RPCs:

| Method | Input | Result |
| --- | --- | --- |
| `refinement.rewrite` | `{text,instruction}` | `{text}` |
| `refinement.cancel` | `{}` | `{cancelled}` |
| `faceclaw.tools.register` | `{projectId,tools:[{name,description,inputSchema}]}` | `{registered:true}` |
| `faceclaw.tools.result` | `{callId,result:{content,isError?}}` | `{accepted:true}` |

Only one authenticated phone connection may register tools. Registration requires the exact server-configured `BRIDGE_FACECLAW_PROJECT_ID`. Tool events are `faceclaw.tool.call` with `callId`, `name`, `arguments`, `projectId`, `issuedAt`, and `expiresAt`. Provenance is either a `threadId` or a `providerSessionId` plus `bindingKind: "provider-session"`. A provider-session is not a T3 thread ID. The phone must enforce call expiry and consume each call ID before invoking its existing MCP handler, then return the result. The bridge never retries a dispatched action and rejects repeated MCP request IDs, duplicate results, results from a different phone, and disconnected calls. Timeout/drop means the action's result is unknown, not permission to repeat it.

## On-demand Luna refinement

Refinement and the provider launcher below are supported on macOS and Linux only.

Set `BRIDGE_REFINEMENT_CODEX_PATH` to the absolute path of an installed Codex CLI that already has a working login. Restart the development bridge with that optional setting. Refinement always selects `gpt-5.6-luna`, reasoning `low`, normal service tier. It creates no ordinary T3 conversation and requires no new API key. Input is bounded to 8,000 transcript characters and 2,000 instruction characters, with one job at a time, a 45-second generation deadline, and explicit cancel/disconnect cleanup. Allow at least 60 seconds for the client RPC deadline, including the isolation preflight.

Each job first checks the installed CLI against a loopback mock provider and requires the actual outgoing request to contain no tools and the exact model/reasoning. Only then is the real transcript submitted. This fails closed if a future runtime introduces tools. The job ignores user configuration and rules, disables MCP/plugins/apps/shell/browser/agent tools, removes apply_patch and auxiliary tools through a private model catalog, and runs in an empty temporary directory with read-only sandboxing. The existing Codex login is retained; bridge/T3/API secrets are omitted from the child environment. Audio and draft text are never logged. Temporary output is removed on completion, failure, or cancellation. The phone must retain its original draft on every failure and require a later tap to send.

The actual installed CLI was exercised on September 6, 2026: the probe observed no tools, and a live Luna/low request successfully rewrote a sample typo through the existing login. This establishes local account availability, not a guarantee for another account or future model catalog. CLI configuration references: [configuration](https://developers.openai.com/codex/config-reference/) and [commands](https://developers.openai.com/codex/cli/reference/).

## Automatically expose glasses tools to a T3 Codex provider

The bridge supports a separate generated Codex launcher executable. T3 starts Codex app-server per provider runtime and supports launch-time MCP configuration. The launcher authenticates to the bridge before starting app-server, obtains a project-scoped provider-session capability, injects the Faceclaw MCP server, and keeps that capability leased while the provider is running. The first assistant turn can use glasses tools. T3 continues to own its conversation and normal agent orchestration.

1. Set `BRIDGE_FACECLAW_PROJECT_ID` to the existing T3 general-assistant project ID in the development bridge's environment. Keep its workspace root fixed. Pair Faceclaw and enable its device-tool integration for the same project.
2. In a local owner shell, provide `BRIDGE_TOKEN` and `BRIDGE_FACECLAW_PROJECT_ID` for this bridge using the existing private environment mechanism. Also set `FACECLAW_WORKSPACE_ROOT` to the exact project's absolute directory, `FACECLAW_CODEX_PATH` to the absolute real Codex executable, and optionally `FACECLAW_BRIDGE_ORIGIN` to the numeric-loopback HTTP origin (default `http://127.0.0.1:8787`). Never paste real credentials into a conversation, issue, or command argument.
3. After building the bridge, run the following with a **new** private destination directory:

```sh
node bridge/dist/src/faceclaw-setup.js /absolute/private/path/faceclaw-provider
```

4. In a separate T3 Codex provider configuration, select the generated `codex-faceclaw.mjs` as the Codex executable. In Faceclaw's T3 assistant settings select that provider/model and the configured assistant project. Existing T3 providers remain unchanged. Restart an existing provider session after changing its executable.

The generated `launcher.json` is owner-only and contains a project-specific bootstrap credential, never the master bridge credential. Setup refuses to overwrite an existing profile. Outside the configured project or for non-app-server commands, the wrapper runs normal Codex without Faceclaw tools. Inside the project, a bridge failure stops provider startup instead of silently dropping the intended tool configuration. The scoped input stream rejects attempts to switch the provider to another project directory. It preserves T3's existing MCP arguments and credentials.

`/v1/faceclaw/provider-session` requires the distinct project launcher credential and validates the configured project's current T3 workspace against the canonical cwd. The resulting provider capability is opaque to the model except for the bearer needed by MCP; a separate lease secret remains in the launcher. Leases expire after 90 seconds without renewal, are revoked when the provider exits, and have a 24-hour maximum lifetime. Bridge restart invalidates every active tool capability. Start a fresh provider session afterward.

The actual installed Codex app-server was tested with an isolated Codex state directory: MCP initialize, initialized, and tools/list completed; thread/start succeeded; the lease was revoked at process exit. An automated test also exercises launcher → bridge → authenticated phone tool → result → revocation. Connecting this generated provider in the user's T3 UI and exercising physical glasses remains an integration check. Automatic injection currently targets the Codex provider, not Claude or other providers.

### Authorization boundary and limitations

The launcher bootstrap credential, exact server-selected project, and server-issued provider session establish authorization. A cwd string or project instructions alone do not establish it. Project instructions may express the user's consent for immediate actions, including message sends; the adapter imposes no blanket second confirmation. Phone tool implementations retain their own validation and Android permission checks.

T3 does not include its own thread ID in the provider subprocess handshake. Therefore automatic grants identify an authenticated provider session within the configured project, including any Codex children hosted there, without claiming a specific T3 thread. The local OS account owning the launcher configuration is trusted. Other unrestricted code running as that same user can read its files; this mechanism is not an OS sandbox between mutually hostile same-user agents. Use a separate OS identity and protected service configuration if that isolation is required.

For explicit external adapters, owner-only `POST /v1/faceclaw/tool-credential` with the master bridge bearer and `{threadId}` issues a one-hour capability bound to an existing allowed T3 thread in the configured project. This endpoint is never exposed to the phone or ordinary project agents. It is optional; the generated launcher handles normal automatic integration. Both grant types use the standard POST MCP endpoint `/v1/faceclaw/mcp`; native/Hub/companion credentials cannot authorize it. In-memory replay receipts and process-specific signatures prevent transport retries and invalidate old calls across bridge restarts. They cannot determine whether a model intentionally issues a new, semantically identical action with a new request ID.

## Plan approval and session controls

The separate native Faceclaw T3 client can select plan mode while reviewing a draft, change an idle session's reasoning, and review a completed plan. These controls require the updated bridge.

The bridge accepts `plan.approve` with the thread ID, plan ID, and exact revision shown in the review. It freshly verifies project visibility, thread identity, completion, and the plan text. Invalid, changed, already implemented, oversized, or older-turn plans cannot be approved. Structured plan text is limited to 64,000 characters.

The installed T3 contract uses `thread.interaction-mode.set` followed by `message.dispatch` with `sourcePlanRef: { threadId, planId }`. A plan is actionable while T3 reports it `active`. The implementation message includes the reviewed plan text, and the thread keeps its existing runtime permissions. Stable command IDs deduplicate implementation intents across reconnects and bridge restarts. Native Faceclaw persists an approval lock in its existing encrypted draft store before dispatch. Uncertain dispatches remain locked and require checking T3 before another attempt.

T3 has no atomic revision precondition or combined mode-change-and-start operation in this installed contract. The bridge checks the revision immediately before dispatch, but another T3 client can change a plan or session concurrently. The implementation message still carries the text that was reviewed. If mode switching succeeds and turn start fails, the selected mode can remain changed. The bridge does not retry the turn automatically. A successful dispatch receipt confirms command acceptance, not provider completion.
