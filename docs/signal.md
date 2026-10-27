# Signal service and independent APK

Supported on macOS and Linux only. Windows bridges refuse the Signal settings.

Signal runs as an optional service in this bridge, independent of T3 or an agent provider. The separately installed Signal APK uses Faceclaw for glasses rendering, input, notifications and reviewed dictation. Its credential cannot use the T3, native Faceclaw, phone or owner APIs.

## Runtime setup

This implementation supports **signal-cli 0.14.7 with Java 25**, installed separately. New versions require the compatibility checks before changing the version gate. signal-cli is unofficial and older releases can stop working with Signal. Follow the [pinned upstream installation requirements](https://github.com/AsamK/signal-cli/blob/v0.14.7/README.md). No Signal executable, account or Java runtime is bundled into the bridge package.

The verified JVM archive is [signal-cli-0.14.7.tar.gz](https://github.com/AsamK/signal-cli/releases/download/v0.14.7/signal-cli-0.14.7.tar.gz), SHA-256 `0e1eefdf4a2109edf7c899c9d1667167c54ac12c3ec824f27db7c1dac4fa7506`. Verify the archive before extracting it into a new private tools directory. Use a Java 25 distribution suitable for the computer's architecture; no global Java switch is required. On macOS ARM64 the isolated check also verified Temurin JRE 25.0.4.1+1, archive SHA-256 `5b02bcc908da092e7e00b9772d4f9bbb87f44a60b7c90f7cf5a91a1d98f37e1b`.

Set these trusted process environment values when starting the bridge:

```text
BRIDGE_SIGNAL_CLI_PATH=/absolute/path/to/signal-cli-0.14.7/bin/signal-cli
BRIDGE_SIGNAL_DATA_DIR=/absolute/private/path/to/faceclaw-signal-data
JAVA_HOME=/absolute/path/to/Java25/Home
```

Both Signal variables are required together; omitting them disables Signal and leaves existing setup unchanged. Use a dedicated directory outside source control, owned by the bridge user with mode `0700`. Do not point it at an existing Signal Desktop or signal-cli account directory. The current protected-storage implementation targets macOS/Linux. Existing managed installers do not yet expose Signal options; configure an explicitly selected development/service launch environment without replacing existing T3 or service settings. `npm --prefix bridge run build` followed by `npm --prefix bridge start` runs the ordinary bridge entry point using that environment. A missing T3 token does not prevent Signal startup.

The bridge remains on loopback. The APK reaches its existing private HTTPS origin through Tailscale Serve, with normal certificate verification. No signal-cli TCP, HTTP or D-Bus listener is opened. The child process has a private data/config root, scrubbed/discarded logs, disabled send log, and disabled attachment/avatar/sticker/story downloads. It never inherits bridge credentials or agent-provider tokens. Automatic read receipts are disabled; displaying a popup does not mark a conversation read.

Open `http://127.0.0.1:<bridge-port>/signal/setup` **on the bridge computer**. Sign in using the local bridge owner credential, not a T3 provider token or phone pairing passphrase. Setup sessions expire after 15 minutes and stay in browser memory. Remote/proxied and cross-origin setup requests are rejected, including a forwarded non-loopback Host header.

1. Link with the QR code through the official Signal app's Linked devices screen. No primary-account registration route exists. If linking completed but the bridge restarted before recording it, use the explicit recovery action to adopt the one account in the dedicated directory.
2. Refresh contacts and groups. Create a two-minute, one-use APK pairing code and enter it with the private HTTPS origin in Faceclaw's Signal setup. Only the resulting Signal-scoped credential belongs on the phone.
3. Choose retention (1–365 days, default 30) and sender/message versus sender-only glasses previews. Configure forwarding and official-Signal notification suppression in the selected Faceclaw host.
4. Optional assistant access: select conversations, issue a separate assistant credential and connect the MCP endpoint below. Revoke that credential to disable future reads/drafts without disconnecting the APK.

Deleting local Signal data requires the account-specific destructive confirmation in setup. It revokes credentials and clears integration history/drafts/send metadata before deleting the dedicated signal-cli account artifacts. Remove the bridge entry from Linked devices on the official phone too. This action does **not** delete or unregister the primary Signal account. Interrupted/oversized cleanup leaves access revoked and reports that offline cleanup is needed.

## APK protocol, version 1

Native requests use `POST`, `Content-Type: application/json`, no `Origin` header and no query-string parameters. Use the separately issued bearer token on every RPC. No reusable credential appears in a URL or QR code. The short-lived Signal device-link QR is shown only inside authenticated local setup.

`POST /v1/signal/pair` with `{ "code": "one-use-code" }` returns `{ "token", "credentialId", "accountId", "protocolVersion": 1 }`.

`POST /v1/signal/rpc` with `{ "id": "request-id", "method": "snapshot", "params": {} }` returns `{ "id", "ok": true, "result": ... }`. Failure uses an appropriate HTTP status and `{ "id", "ok": false, "error": { "code", "message" } }`. Authentication/body errors can omit `id`/`ok` and include the ordinary bridge `requestId`; handle HTTP status first. Never treat a network failure during a send as a safe retry.

| Method | Parameters | Result |
| --- | --- | --- |
| `status` | `{}` | Account, readiness/health, retention, preview and expiry policy |
| `snapshot` | `{page?: number, snapshotCursor?: string}` | Account, cursor, preview, retentionDays, conversations, messages, drafts, operations, nextPage |
| `events` | `{cursor: string}` | Cursor, reset, events, preview, retentionDays |
| `conversations` | `{}` | Conversations |
| `history` | `{conversationId, page?, snapshotCursor?}` | Messages, cursor, nextPage |
| `recipients` | `{}` | Fresh known contacts/groups, app only |
| `conversation.open` | `{recipientId}` | Conversation |
| `draft.set` | `{conversationId, text}` | Draft; empty text removes it |
| `send` | `{accountId, conversationId, text, operationId}` | Operation, app only |
| `operation.get` | `{operationId}` | Caller-owned operation |

Conversation: `{id,title,kind:"direct"|"group",disappearing,expirationSeconds,lastMessageAt?}`. IDs are opaque and account-specific. Message: `{id,conversationId,sender,text,timestamp,expiresAt,outgoing}`; timestamps are Unix milliseconds. Draft: `{conversationId,text,expiresAt,version}`. Each replacement gets a new opaque version so an old review cannot authorize a recreated draft. Operation: `{operationId,conversationId,status:"pending"|"sent"|"unknown",createdAt,timestamp?}`.

Conversation collections retain the known recipient directory for compatibility, including contacts, groups and Note to Self that have no messages. `lastMessageAt` is present only when the bridge retains a real incoming or confirmed outgoing message for that conversation; its value is the greatest retained sent timestamp. Collections sort by that timestamp descending, then opaque ID ascending, with inactive recipients last. The glasses home filters to entries with activity and places New conversation first; its recipient picker uses the full directory. Opening a recipient, saving a draft or refreshing contacts does not create activity. Clients replacing conversation objects must clear an earlier `lastMessageAt` when the field is absent. Message additions, expiry and deletion also produce conversation events so this metadata stays current. Older bridges omit the field; clients can derive activity from their complete retained message snapshot.

Activity is computed from existing encrypted messages without a schema migration or extra retained metadata. Deleting or expiring the newest message falls back to the next retained message; removing the last one removes that chat from the glasses home while leaving the recipient available for a new conversation. The permanent send ledger never keeps an otherwise expired chat active. The bridge has no import of phone history from before linking, so the glasses list only reflects conversations observed within its retained history and cannot reproduce an older official Signal inbox.

Snapshots/history page at 64 items per collection. Page zero establishes the cursor; later pages must pass it as `snapshotCursor`. A state change returns `409 snapshot_changed`, requiring a new page-zero snapshot. Gather all pages before replacing local state. Do not generate alerts for snapshot history. Events process at most 64 source records per poll; returned cursor advances only through processed records. Event shapes are `{sequence,type:"message",message}`, `{sequence,type:"remove",messageId}`, `{sequence,type:"operation",operation}`, and `{sequence,type:"conversation",conversation}`. A cursor gap, bridge history change or settings change can return `reset:true`; replace local content through a snapshot. Cursor never grants authority.

Only fresh incoming `message` events may alert; outgoing messages, historical snapshots and reconnect backlogs must not wake the glasses. Enforce `expiresAt` locally when offline, withdraw deleted/expired notifications and invalidate drafts/reply targets. The selected Faceclaw host owns the notification permission and exact conversation routing. All sends stay on the APK → bridge → signal-cli path.

## Assistant tools and confirmations

`POST /v1/signal/mcp` provides stateless Streamable HTTP MCP (`2025-03-26`) using `Authorization: Bearer <separate-assistant-credential>`. The endpoint accepts only assistant credentials. Standard `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call` are supported. Configure the provider's HTTP MCP connection with:

```json
{
  "url": "http://127.0.0.1:8787/v1/signal/mcp",
  "headers": { "Authorization": "Bearer <separately-issued-assistant-credential>" }
}
```

This is the connection descriptor; the enclosing provider configuration varies. Prefer a provider-supported secret environment variable/header binding over committing a literal credential. Keep remote providers on the private HTTPS origin. Configuration is never installed or modified automatically.

Tools: `signal_status`, `signal_conversations`, `signal_history`, `signal_draft`. There is no send tool. Reads and drafts are limited to the owner's selected conversations and rechecked on every request. Treat conversation text as untrusted data. Content copied into an assistant conversation follows the provider's retention and cannot be retracted by later revocation.

The dashboard fetches the actual saved draft, displays its account, recipient and exact text, then binds Send to an owner-session-specific review that expires within 60 seconds. A review is one use. A changed draft, expired draft, account reset, owner logout or grant revocation invalidates it. Assistant text claiming approval cannot create a review or dispatch a send. Authorization is checked again after asynchronous timer lookup and immediately before dispatch.

## Retention, failure and compatibility limits

The bridge uses a new encrypted `FCS1` envelope/schema version 1, not the existing T3 database. AES-256-GCM authenticated snapshots use an owner-only local key, atomic temporary-file replacement and file/directory fsync. One writer owns the directory. Pending sends recovered after a process crash become `unknown`; they are never replayed. Corrupt, missing-key or unsupported-version storage fails closed. No existing schema, migration or production data is changed. Keep full-disk encryption enabled and exclude this directory, account artifacts and temporary files from general backups. This integration creates no history backups. Required Signal account keys have a separate lifetime from message TTL.

History is kept **up to** the configured retention, with earlier Signal expiry/removal. Capacity bounds are 5,000 messages/8 MiB of message text, 128 drafts, 2,000 conversations, 20,000 send operations and 50,000 deletion tombstones. Oldest messages can leave history earlier at the message cap, with matching withdrawal events. Operation identities and keyed fingerprints contain no message text and persist to prevent replay; exhausting this ledger blocks new sends. Tombstones expire after 366 days, beyond the maximum history window. Cleanup is bounded; corrupt/full storage stops safe progress rather than dropping idempotency records.

The pinned [data-message JSON](https://github.com/AsamK/signal-cli/blob/v0.14.7/src/main/java/org/asamk/signal/json/JsonDataMessage.java) contains `expiresInSeconds`, while [sent-message JSON](https://github.com/AsamK/signal-cli/blob/v0.14.7/src/main/java/org/asamk/signal/json/JsonSyncDataMessage.java) omits `expirationStartTimestamp`. Therefore this implementation expires timed incoming content from its authenticated sent timestamp, capped by local receipt time, instead of extending it to an unknown read-start. Timed outgoing content uses the earlier pre-dispatch time with freshly queried `messageExpirationTime`. This can remove timed messages before the official clients do, including before they are read here. Missing timer data and view-once content are not retained. Known expiry continues while the phone or bridge is offline through absolute deadlines. Exact read-start parity and historical phone-history import are not promised.

Author-bound remote deletes remove observed content and drafts, and durable tombstones prevent stale replay. The pinned JSON surface does not expose all official client local-delete synchronization fields; local-only deletion on another device is not equivalent to Signal's remote-delete event. Group admin-delete and edit synchronization need additional validation before this integration can claim complete deletion/edit parity. Do not infer support from the underlying protocol when its JSON event is absent.

Send intent is persisted before dispatch. An operation ID cannot be reused with different account/recipient/text or by another credential. Only an exact response with a valid timestamp and exclusively `SUCCESS` results marks a send sent; partial group failures remain `unknown`. A timeout, process exit or malformed result remains unknown and does not replay. An exact late RPC result can reconcile the same operation for two minutes and add its confirmed outgoing message within the original expiry and any shorter current retention, honoring deletion tombstones. It never sends again or makes expired content visible. After restart, a coincidentally matching sent sync message is not treated as proof for an unrelated operation. `sent` means signal-cli confirmed its send, not that the recipient read it. Offline attempts that never dispatched are rejected and stay drafts until the user explicitly sends again.

Recovery: stop the bridge before restoring a matching encrypted snapshot/key pair. Do not restore a stale send ledger into a live account, which could lose operation deduplication; keep restored operation IDs unknown and reconcile manually. A normal crashed writer PID is reclaimed under an exclusive recovery lock. If the process crashed during that short lock-recovery section, inspect and remove the stale `recovery.lock` offline after verifying no writer exists. Disabling Signal in the launch environment is the rollback; it leaves private data intact. Never downgrade an unknown schema or run simultaneous versions against one directory.

## Verification

```sh
npm run check:all
npm --prefix bridge run build
node scripts/signal-dev-server.mjs
```

The fixture serves `http://127.0.0.1:18791/signal/setup` with public synthetic owner credential `fixture-signal-owner-token-for-local-tests-only`, fake contacts/messages and a reviewable assistant draft. It uses a temporary private store, never loads installed configuration and never contacts Signal. Exit removes its temporary data. Chrome UI review covers setup rendering, edit/selection preservation through polling and exact-message confirmation.

For a real executable **without an account**, set absolute `SIGNAL_SMOKE_CLI_PATH` and `JAVA_HOME`, then run `node bridge/scripts/signal-smoke.mjs`. The check creates a fresh temporary directory, verifies version, empty accounts, receive subscription and supervised shutdown, and removes the fixture. macOS ARM64 passed with the pinned runtimes above. Real account linking, live messages, disappearing read-start parity, hardware notifications and multi-device behavior still require explicitly selected integration testing; none was performed with personal data during development.
