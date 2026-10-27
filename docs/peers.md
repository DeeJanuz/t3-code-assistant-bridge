# Bridge federation over Tailscale

Supported on macOS and Linux only. Windows bridges refuse `BRIDGE_PEER_DIRECTORY`.

Each computer runs T3 and a bridge. A phone connects to one bridge, which aggregates the local environments of its explicitly paired peers. Every paired bridge can be the phone's host. T3 desktop windows may be closed; the T3 servers, bridge services, and Tailscale must remain running.

Peers export only their own local primary environment. They never export imported environments. Local T3 credentials stay on their owning computer. This deployment no longer reads or refreshes T3's CLI cloud credential, and does not depend on T3 Connect.

## Enroll two computers

Update and build this checkout on both computers. Preserve the installed service configuration, phone pairing, T3 data, and existing Tailscale Serve mapping. Windows/Linux portable installs run from the checkout. The macOS installer stages a runtime copy: update that runtime using the existing installer before restarting its LaunchAgent.

```sh
npm run check:all
node scripts/peers.mjs init
```

`init` reads the local T3 descriptor and the installed bridge origin, creates a persistent bridge identity, and enables federation. It requires an existing installation and a running local T3 server. Existing peer identities are never replaced. If already initialized, use `enable` instead. `BRIDGE_SERVICE_CONFIG` can select a non-default portable configuration file; it is a file path, not a credential.

Restart the service on each computer:

- Linux/WSL: `systemctl --user restart even-t3-bridge.service`
- macOS: `scripts/service.sh restart`
- Windows: stop and restart the existing `Even T3 Bridge` scheduled task.

On computer A:

```sh
node scripts/peers.mjs invite
```

Transfer the generated private `invitation.json` file to B through a trusted channel, such as Tailscale file transfer. On Unix, the received file must belong to the current user and have mode `0600`; on Windows its ACL must allow only that user. Do not paste the contents into chat, pass the secret as a command argument, or place it in a repository.

On computer B, within five minutes:

```sh
node scripts/peers.mjs accept /absolute/path/to/invitation.json
node scripts/peers.mjs status
```

Run `status` on A too. One acceptance establishes both directions. A retry of the same invitation and transaction resumes an interrupted exchange; it does not mint duplicate peer grants. An unfinished exchange remains pending/unavailable. If a failure happens after confirmation on one computer, the other may show paired configuration but cannot connect until the pending side completes. Rerun `accept` with the same invitation file. If the initial exchange expired before it was recorded, revoke any pending entry on A and create a fresh invitation. Remove transferred invitation files after completion.

For three computers, pair A–B, A–C, and B–C. There is no tailnet scan or implicit enrollment. At most 32 peers and 16 unexpired invitations are permitted per bridge.

## Behavior and trust

Pairing grants the named peer access to permitted local T3 projects, transcripts, models, and session actions. Both the host's project restrictions and the owning bridge's project restrictions apply. The owner re-reads local thread state before mutations. Peers cannot call phone, Signal, voice, provider-tool, pairing-administration, or arbitrary HTTP/dispatch operations through the peer channel.

The private protocol uses `/v1/peer/events`, WebSocket subprotocol `faceclaw-peer-v1`, and a dedicated per-peer bearer credential. Phone/browser credentials do not authorize that endpoint. Peer credentials do not authorize phone/browser routes. `/v1/peer/pair` accepts a single-use invitation; `/v1/peer/confirm` completes that exact peer grant. All peer endpoints reject browser Origin headers. Network clients require exact HTTPS Tailscale origins, normal TLS validation, and no redirects.

The host polls each peer independently and shares a bounded recent snapshot across phone clients. A sleeping, disconnected, or incompatible peer remains visible as unavailable; healthy environments remain usable. Sessions are identified by environment ID plus thread ID, including phone navigation, plan drafts, and subscriptions. A changed bridge/environment identity requires owner inspection and re-enrollment.

Remote actions are never replayed automatically. `peer_operation_uncertain` means the action may have been accepted before the connection failed. Refresh the session and inspect T3 before trying again. Revocation blocks new requests and closes peer sockets; an already accepted local operation may finish.

The standalone T3 APK must be updated with environment-aware routing. It displays the owning computer and unavailable peers. Select another host deliberately in phone settings; changing hosts clears the old workspace and subscriptions. Legacy selections without an environment ID still target the current host's local primary environment. Assistant/device-tool integration and phone services remain local to that host.

## Inspect, revoke, or roll back

```sh
node scripts/peers.mjs list
node scripts/peers.mjs status
node scripts/peers.mjs revoke BRIDGE_ID
node scripts/peers.mjs disable
```

`list` shows configuration only; `status` also reads the running environment catalog. Neither prints credentials. Revoke on both computers to remove both directional grants. A local revocation closes that relationship's sockets and removes its imported environment. File changes are observed while the service is running.

`disable`, followed by a service restart, restores local-only operation while retaining pairing records. `enable` and restart restore the configuration. Neither operation changes T3 sessions or credentials. A crash while writing configuration can leave a `write.lock` directory; verify no CLI/service writer remains before removing that lock. Do not delete `peers.json` to clear a lock.

Credentials and pending exchanges live in an owner-only `peers` directory beside the portable service configuration, or under `~/Library/Application Support/Even T3 Bridge/peers` on macOS. Back up that directory privately if needed. Do not copy a bridge identity to a different computer.
