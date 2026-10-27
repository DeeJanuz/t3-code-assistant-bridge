# Faceclaw T3 Bridge

Connects the [Faceclaw](https://github.com/DeeJanuz/faceclaw) T3 app on Even Realities G2 glasses to an existing T3 Code installation. The glasses can read and continue conversations, start sessions, dictate and review replies, answer plan questions, change models, and expose glasses tools to T3 agents.

This is an independent community project, not an official T3 Code or Even Realities product. For the Even Hub app, use the separate [T3 Code Assistant Bridge](https://github.com/DeeJanuz/t3-code-assistant-bridge).

## How it fits together

- **Faceclaw host and T3 app (phone):** [Faceclaw](https://github.com/DeeJanuz/faceclaw) owns the glasses connection. The [T3 app](https://github.com/DeeJanuz/faceclaw-t3-app) draws the T3 screens and talks to this bridge.
- **Bridge (computer):** Connects to the local T3 Code server and to explicitly paired bridges on your other computers, and runs local Whisper transcription. T3 credentials stay on the computer. The phone gets its own scoped token.
- **T3 Code:** Owns projects, conversations, models, and agent execution. T3 Code and a working agent provider must already be installed.

The bridge listens on loopback only. Phones reach it through Tailscale Serve over private HTTPS/WSS with normal certificate validation. Keep T3 Code running and the computer awake while using the assistant.

## Install

T3 Code and a working agent provider are assumed to be installed.

1. Give [SKILL.md](skills/t3-bridge-deploy/SKILL.md) to your T3 Code agent and ask it to install the Faceclaw T3 Bridge on this computer. It installs missing prerequisites (Node.js, Tailscale, whisper.cpp), configures startup at sign-in, and verifies the result. On macOS you can also run `./scripts/install.sh --dry-run` and then `./scripts/install.sh` yourself.
2. The installer prints a **T3 bridge URL** such as `wss://YOUR-COMPUTER.YOUR-TAILNET.ts.net:8443/v1/faceclaw/events`. Run `npm run connection-info` to print it again.
3. On the phone, join the same tailnet in Tailscale, install Faceclaw and the T3 app, and approve the T3 app in Faceclaw.
4. In the T3 app's settings, enter the T3 bridge URL and your pairing passphrase. The passphrase is exchanged for a scoped token and is not stored. Do not paste credentials into conversations, issues, or screenshots.

## Develop and verify

Run from this repository:

```sh
npm ci --prefix bridge
npm run check:all
```

For isolated Faceclaw integration testing:

```sh
npm --prefix bridge run build
node scripts/faceclaw-dev-server.mjs
```

The fixture runs on loopback port 18790 with synthetic projects, conversations, and responses. It does not load installed configuration, real credentials, or user T3 data. See the [local UI testing instructions](docs/faceclaw.md#local-ui-testing) for connection details and fixture limitations.

The fixture checks application flow. Real speech recognition, model execution, and Bluetooth behavior still require integration testing with the relevant services and hardware. Run `npm run check:all` after runtime changes.

## Pair computer bridges

Install a bridge on each T3 computer, then follow [peer setup and revocation](docs/peers.md). The bridge the phone connects to aggregates paired computers without T3 Connect credentials or an open T3 desktop window, and routes each session to the computer that owns it.

## Connect Faceclaw

Faceclaw pairs through `/v1/faceclaw/pair` and connects to `/v1/faceclaw/events`. Requests with a browser `Origin` header are rejected. Use the [Faceclaw integration guide](docs/faceclaw.md) for native transport, optional draft refinement, and provider setup that exposes glasses tools to T3.

The optional Signal service supports the Faceclaw messaging app's legacy bridge mode; new installs of that app connect to Signal directly. The app has its own phone setup screen. On the glasses, New conversation opens its contact/group directory with voice search; the home list shows retained conversations in newest-message order. The bridge supplies `lastMessageAt` from retained messages, so contact sync and unsent drafts do not create chats. Signal history from before linking is unavailable (`historyImport: false`), and a chat leaves this list when its final retained message expires or is deleted. See the [Signal guide](docs/signal.md) for setup, retention and protocol details.

## Documentation

- [Optional Signal service, APK protocol and scoped assistant tools](docs/signal.md)
- [Faceclaw integration and local testing](docs/faceclaw.md)
- [Computer bridge internals and protocol](bridge/README.md)
- [Bridge federation across computers](docs/peers.md)
- [Assistant context directory](docs/assistant-context.md)

The bridge requires T3 Code orchestration protocol 2 (orchestration V2, T3 Code 0.0.46 and newer). T3's orchestration API is not a stable third-party SDK. Rerun compatibility checks after upgrading T3 Code; see [T3 compatibility](bridge/README.md#t3-compatibility).

## License

[MIT](LICENSE). You may use, modify, redistribute, or sell the original code while retaining its license notice. No monetization restriction or copyleft requirement is added. Libraries and external services retain their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).

## Transcript token usage

Normalized transcripts include `tokenUsage: { contextTokens, contextWindowTokens, totalTokens, latestTotalTokens, updatedAt }`, with nullable values. The bridge reads T3 Code provider turns: the newest `tokenUsage.usedTokens` and `maxTokens` supply context occupancy and capacity. V2 reports no cumulative counter, so thread-lifetime usage is the sum of each provider turn's complete `turnTokenUsage` input and output tokens, and it is unknown once any turn reported partial or no usage. `latestTotalTokens` is that running sum at the newest report. It never adds occupancy snapshots or cached/reasoning subtotals. Compaction can reduce context without reducing the lifetime total. The glasses use the latest counter to display usage since an observed model switch. Providers without the corresponding fields remain unknown. Raw provider payloads are not forwarded.

The source contract was checked against T3 Code `0.0.46-nightly.20261013.3053` (`orchestrationV2.ts`, `providerRuntime.ts`). Deploy the rebuilt bridge with the matching T3 APK to enable its CTX/TOTAL header.

### Assistant questions in ordinary sessions

Pending V2 `user_input` runtime requests are exposed for running turns in both `default` and `plan` interaction modes. The existing `pendingPlanInput` and `plan.submit` wire names remain for compatibility. Answers still require the current request identity and revision, session/project authorization, review, and explicit submission through `runtime-request.respond`. Approval events and free-form transcript text do not become questions. Restart the bridge after rebuilding to activate this behavior; use a T3 APK that displays pending-question alerts.
