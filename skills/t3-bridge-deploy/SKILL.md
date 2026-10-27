---
name: t3-bridge-deploy
description: Install and configure the Faceclaw T3 Bridge on Windows, macOS, or Linux, including missing prerequisites, private Tailscale transport, local speech transcription, startup at sign-in, and the phone handoff for the Faceclaw T3 app. Assumes T3 Code and an authenticated agent provider already work on this computer.
---

# Install the Faceclaw T3 Bridge

Complete the computer setup for the user. Do not turn this into a human terminal tutorial. Assume T3 Code is already installed; preserve its installation, projects, sessions, credentials, and provider settings. This skill also works when its text is pasted into a T3 conversation rather than installed in a skill directory.

## Locate the source and detect the host

Canonical source: `https://github.com/DeeJanuz/faceclaw-t3-bridge`. The phone side is the Faceclaw host from `https://github.com/DeeJanuz/faceclaw` plus the T3 app from `https://github.com/DeeJanuz/faceclaw-t3-app`.

Identify the actual OS, architecture, user home, installed T3 version/server entry, and existing bridge service before changing anything. If this is an existing checkout, inspect its remote and preserve local changes. Otherwise clone the canonical repository into a stable user-owned applications/projects directory. Do not install a persistent service from a temporary folder. Use the latest non-draft release tag that includes this skill, or the user's explicitly selected revision. Report the chosen revision.

Read this checkout's platform reference before installing:

- macOS: `skills/t3-bridge-deploy/references/macos.md`
- Windows or Linux: `skills/t3-bridge-deploy/references/windows-linux.md`

If only this file was attached, clone the repository first and read those files from the clone. Check the scripts' `--help` output against the selected revision; do not invent flags from memory.

## Complete the authorized setup

An installation request includes installing missing prerequisites and setting up this user's bridge startup. Reuse compatible installed software. Obtain prerequisites from official projects or the host's trusted package manager. OS elevation dialogs, Tailscale sign-in/HTTPS enablement, and Android permission prompts may require the user; ask only for the specific interaction needed and continue independent work.

1. Confirm the installed T3 Code server can run and an agent/provider is authenticated. Do not reinstall T3 or create a replacement workspace. If its current CLI/API is incompatible with the checked-out bridge, report that compatibility blocker rather than accessing private T3 databases or bypassing authentication.
2. Install/discover Git, Node.js 22.16+ (an actively supported Node 22 or 24 release), Tailscale, and whisper.cpp's **whisper-server**. Read the platform reference for prerequisites. T3 alone does not include all these dependencies.
3. Join this computer to the user's Tailscale network through its official login flow. Confirm MagicDNS/HTTPS availability. Keep the bridge on numeric loopback, default `127.0.0.1:8787`, and expose it privately through Tailscale Serve on default HTTPS port 8443. Never use Funnel, public bind addresses, URL credentials, or a maintainer's hostname.
4. Install locked npm dependencies, build the bridge, and install the checksum-verified local Whisper model through the repository helper. Use the macOS installer or the Windows/Linux portable installer as directed. Inspect its dry run, then perform the install. Do not overwrite an unrelated service, occupied port, or Serve mapping. Resolve such conflicts with the user using concrete non-secret details.
5. Verify the startup registration, loopback health, private Serve mapping, native pairing, browser-origin and unauthenticated rejection, and the bridge's T3/Whisper readiness. Use repository verification commands, not raw credential/config dumps. Distinguish a loaded process from working T3 and speech providers. Leave a partial failure clearly reported; do not claim success from a dry run.

## Credential handling

The macOS installer collects a passphrase through a hidden local prompt. Windows/Linux generate credentials into a user-private file. Never ask for a passphrase in chat or place it in shell arguments, environment dumps, source files, plist/task definitions, logs, or screenshots. Do not display the credential file through an agent tool. On macOS, use the passphrase the user entered or direct them to the local plaintext `credentials/pairing-passphrase` file in the install directory. On Windows/Linux, direct them to the local `credentials.json` file and have them privately copy only its `pairingPassphrase` value into the T3 app; keep the other token private. Provide paths without reading the files through an agent tool. Do not transmit signing keys or T3 credentials to GitHub.

Tailscale Serve can require elevation. If the portable install has already created the user service but Serve lacks permission, elevate only the reviewed Serve command. Do not run the whole Linux installer as root or overwrite its private files. Re-run the verification helper after fixing permissions.

## Phone handoff

Return a short completion report containing:

- Installed revision and which checks actually passed; missing physical-device checks or provider readiness failures.
- How the service starts and its status/start/stop commands. Startup is **at user sign-in**, not a promise of operation before login. T3 Code must be running, the computer awake, and Tailscale connected.
- **T3 bridge URL:** the actual `wss://<computer>.<tailnet>.ts.net:<port>/v1/faceclaw/events` printed by the verified installer.
- The local passphrase retrieval instruction without the passphrase.

The remaining user actions are:

1. Sign into Tailscale on Android using the same tailnet.
2. Install the Faceclaw host and the T3 app from their release pages. In Faceclaw, approve the T3 app and grant the features the user wants.
3. In the T3 app's settings, enter the **T3 bridge URL** and the bridge **pairing passphrase**. Select the assistant project, model, and reasoning level.
4. Verify reading a conversation, dictation/review/cancel, and an intentional test message chosen by the user. Do not send a real message merely to test installation.

## Update or remove

The macOS installer supports rerunning after a reviewed source update. The Windows/Linux portable installer is first-install-only and refuses to overwrite existing configuration. For a portable update, stop its user service, preserve credentials/config, update the existing checkout without discarding user edits, reinstall locked dependencies, rebuild, restart, and verify. Review changes to installer/config schema before reusing an older configuration.

For removal, follow the platform reference and the user's requested scope. Disable/remove only this bridge's service and exact Serve mapping. Keep credentials and project data unless their deletion was explicitly requested. Never reset all Tailscale Serve handlers or delete T3 projects.
