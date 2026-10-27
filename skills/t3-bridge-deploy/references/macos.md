# macOS agent procedure

T3 Code is assumed installed and authenticated. Work from the repository root. Inspect `scripts/install.sh --help` and `scripts/install.sh --dry-run` first. The existing installer owns credential prompts, user LaunchAgent registration, Tailscale mapping checks, dependency installation, runtime staging, and packaging.

## Prerequisites

Discover Homebrew using `command -v brew` and its documented Apple Silicon/Intel installation locations. If absent, use the official installer from https://brew.sh after inspecting its instructions; administrator approval belongs to the user. Do not create a second Homebrew installation.

The installer uses Homebrew for missing Node.js and Tailscale and `bridge/scripts/setup-whisper.mjs` for whisper.cpp/model setup. A working Node.js must satisfy the bridge's `engines` field. Check `tailscale status --json` selectively for online state and this device's DNS name, without printing the full peer inventory. Finish the Tailscale login and HTTPS prompt if required.

T3 normally lives under `/Applications` or the user's Applications folder, uses `~/.t3`, and listens at `http://127.0.0.1:3773`. Inspect the running T3's actual app bundle, base directory, and loopback origin. Preserve its existing state; do not migrate or duplicate `.t3` to make detection pass.

For a custom installation, pass `--t3-app-path /absolute/path/to/T3.app`, `--t3-base-dir /absolute/existing/state/directory`, and `--t3-url http://127.0.0.1:PORT` to both the dry run and real installer. These non-secret selections are validated and persisted into the LaunchAgent and private deployment state. `T3_APP_PATH`, `T3_BASE_DIR`, and `T3_BASE_URL` environment selectors are also accepted at install time; explicit flags take precedence. On an update, omitted selectors reuse the saved selection. The installer keeps the service environment cleared and passes only its explicit allowlist. Custom directories must be normalized absolute paths without symlinks; resolve the real path before installing. The launcher reads the app's `CFBundleExecutable`, so the bundle name need not match the executable name. Numeric loopback HTTP origins are required; remote T3 endpoints are unsupported by the managed authentication flow.

## Install and verify

```sh
./scripts/install.sh --dry-run
./scripts/install.sh
./scripts/service.sh status
npm run connection-info
node scripts/verify-deployment.mjs
```

Run the real installer in an interactive terminal so the user can choose the passphrase in its hidden local prompt. Do not capture that input in the agent's transcript. If the available terminal cannot collect private input, let the user run that one command locally and continue with non-secret verification afterward.

The service label is `com.daenonjanis.even-t3-bridge`. Its reverse-DNS identifier is part of compatibility, not a requirement to use the maintainer's account. The per-user data directory is `~/Library/Application Support/Even T3 Bridge`; generated packages are under its artifacts directory. Use script output for exact filenames and URLs.

Operation:

```sh
./scripts/service.sh start
./scripts/service.sh stop
./scripts/service.sh restart
./scripts/service.sh status
./scripts/service.sh logs
```

Use the filtered status/log helpers; avoid raw launchctl or environment dumps. Run `npm run connection-info` to print the T3 bridge URL again.

For a requested uninstall, inspect `scripts/uninstall.sh` and its options first. Default removal retains credentials and Tailscale Serve. Use `--purge-secrets` or `--remove-tailscale-serve` only for explicitly requested removal of those resources.

Sources: https://brew.sh ; https://tailscale.com/docs/install/mac ; https://tailscale.com/docs/reference/tailscale-cli/serve
