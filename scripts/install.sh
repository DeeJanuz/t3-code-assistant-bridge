#!/bin/zsh

set -euo pipefail
set +x
umask 077

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h}"
source "$SCRIPT_DIR/lib/common.sh"

DRY_RUN=false
HTTPS_PORT=8443
BRIDGE_PORT=8787
REPLACE_TAILSCALE_HANDLER=false
ARCHIVE_PROJECT_ID=""
ARCHIVE_WORKSPACE_ROOT=""
ROLLBACK_SERVICE_INSTALL=false
CUSTOM_T3_APP_PATH="${T3_APP_PATH:-}"
CUSTOM_T3_BASE_DIR="${T3_BASE_DIR:-}"
CUSTOM_T3_BASE_URL="${T3_BASE_URL:-}"

rollback_service_install() {
  local original_status=$?
  if [[ "$ROLLBACK_SERVICE_INSTALL" == true && "$DRY_RUN" != true ]]; then
    set +e
    /bin/launchctl disable "$GUI_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1
    if launchctl_loaded; then
      /bin/launchctl bootout "$GUI_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1
    fi
    local rollback_port_state="occupied"
    local rollback_agent_unloaded=false
    for attempt in {1..20}; do
      rollback_port_state="$(bridge_port_owner_state "$BRIDGE_PORT" 2>/dev/null)"
      if ! launchctl_loaded; then rollback_agent_unloaded=true; else rollback_agent_unloaded=false; fi
      [[ "$rollback_port_state" == "free" && "$rollback_agent_unloaded" == true ]] && break
      /bin/sleep 0.25
    done
    if [[ "$rollback_port_state" == "free" && "$rollback_agent_unloaded" == true ]]; then
      print -u2 -- "Install failed. The bridge LaunchAgent was disabled and unloaded. Review the private Tailscale Serve mapping before retrying."
    else
      print -u2 -- "Install failed. The bridge LaunchAgent was disabled and unloaded, but its port remains occupied. No unknown process was killed."
    fi
    set -e
  fi
  return "$original_status"
}

trap rollback_service_install EXIT

usage() {
  print -- "Usage: scripts/install.sh [--dry-run] [--https-port PORT] [--bridge-port PORT] [--archive-project-id ID --archive-workspace-root DIRECTORY] [--t3-app-path APP_BUNDLE] [--t3-base-dir DIRECTORY] [--t3-url LOOPBACK_ORIGIN] [--replace-tailscale-handler]"
}

while (( $# > 0 )); do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      ;;
    --https-port)
      (( $# >= 2 )) || fail "--https-port requires a value."
      HTTPS_PORT="$2"
      shift
      ;;
    --bridge-port)
      (( $# >= 2 )) || fail "--bridge-port requires a value."
      BRIDGE_PORT="$2"
      shift
      ;;
    --archive-project-id)
      (( $# >= 2 )) || fail "--archive-project-id requires a value."
      ARCHIVE_PROJECT_ID="$2"
      shift
      ;;
    --archive-workspace-root)
      (( $# >= 2 )) || fail "--archive-workspace-root requires a value."
      ARCHIVE_WORKSPACE_ROOT="$2"
      shift
      ;;
    --t3-app-path)
      (( $# >= 2 )) || fail "--t3-app-path requires a value."
      CUSTOM_T3_APP_PATH="$2"
      shift
      ;;
    --t3-base-dir)
      (( $# >= 2 )) || fail "--t3-base-dir requires a value."
      CUSTOM_T3_BASE_DIR="$2"
      shift
      ;;
    --t3-url)
      (( $# >= 2 )) || fail "--t3-url requires a value."
      CUSTOM_T3_BASE_URL="$2"
      shift
      ;;
    --replace-tailscale-handler)
      REPLACE_TAILSCALE_HANDLER=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unsupported argument: $1"
      ;;
  esac
  shift
done

if [[ -n "$ARCHIVE_PROJECT_ID" || -n "$ARCHIVE_WORKSPACE_ROOT" ]]; then
  [[ -n "$ARCHIVE_PROJECT_ID" && -n "$ARCHIVE_WORKSPACE_ROOT" ]] || fail "Both archive flags are required."
  [[ "$ARCHIVE_PROJECT_ID" != *[^A-Za-z0-9_-]* && ${#ARCHIVE_PROJECT_ID} -le 128 ]] || fail "Archive project ID is invalid."
  [[ "$ARCHIVE_WORKSPACE_ROOT" == /* && -d "$ARCHIVE_WORKSPACE_ROOT" && ! -L "$ARCHIVE_WORKSPACE_ROOT" ]] || fail "Archive workspace must be an existing local directory."
  [[ "${ARCHIVE_WORKSPACE_ROOT:A}" == "$ARCHIVE_WORKSPACE_ROOT" && "$ARCHIVE_WORKSPACE_ROOT" != *$'\n'* && "$ARCHIVE_WORKSPACE_ROOT" != *$'\r'* ]] || fail "Archive workspace path must be normalized without symlinks."
fi

validate_install_targets
# Reuse only this user's private saved selection on updates. Explicit flags or
# environment selectors take precedence; unrelated launchd environment stays cleared.
if [[ -f "$SERVICE_STATE_PATH" && ! -L "$SERVICE_STATE_PATH" && "$(/usr/bin/stat -f '%u' "$SERVICE_STATE_PATH")" == "$(/usr/bin/id -u)" && "$(/usr/bin/stat -f '%Lp' "$SERVICE_STATE_PATH")" == "600" ]]; then
  [[ -n "$CUSTOM_T3_APP_PATH" ]] || CUSTOM_T3_APP_PATH="$(/usr/bin/plutil -extract t3AppPath raw -o - "$SERVICE_STATE_PATH" 2>/dev/null || true)"
  [[ -n "$CUSTOM_T3_BASE_DIR" ]] || CUSTOM_T3_BASE_DIR="$(/usr/bin/plutil -extract t3BaseDir raw -o - "$SERVICE_STATE_PATH" 2>/dev/null || true)"
  [[ -n "$CUSTOM_T3_BASE_URL" ]] || CUSTOM_T3_BASE_URL="$(/usr/bin/plutil -extract t3BaseUrl raw -o - "$SERVICE_STATE_PATH" 2>/dev/null || true)"
fi
CUSTOM_T3_BASE_URL="${CUSTOM_T3_BASE_URL:-http://127.0.0.1:3773}"
for custom_path in "$CUSTOM_T3_APP_PATH" "$CUSTOM_T3_BASE_DIR"; do
  [[ -z "$custom_path" ]] && continue
  [[ "$custom_path" == /* && -d "$custom_path" && "${custom_path:A}" == "$custom_path" && "$custom_path" != *$'\n'* && "$custom_path" != *$'\r'* ]] || fail "Custom T3 paths must be existing normalized absolute directories without symlinks."
done
if [[ -n "$CUSTOM_T3_APP_PATH" ]]; then
  [[ "$CUSTOM_T3_APP_PATH" == *.app && -f "$CUSTOM_T3_APP_PATH/Contents/Info.plist" && -f "$CUSTOM_T3_APP_PATH/Contents/Resources/app.asar" ]] || fail "Custom T3 app must contain its installed metadata and server archive."
  custom_executable="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$CUSTOM_T3_APP_PATH/Contents/Info.plist" 2>/dev/null)" || fail "Custom T3 app executable metadata is missing."
  [[ -n "$custom_executable" && "$custom_executable" != */* && "$custom_executable" != *\\* && "$custom_executable" != *$'\n'* && "$custom_executable" != *$'\r'* && -x "$CUSTOM_T3_APP_PATH/Contents/MacOS/$custom_executable" ]] || fail "Custom T3 app executable is invalid."
fi
validate_port "$HTTPS_PORT" "HTTPS port"
validate_port "$BRIDGE_PORT" "bridge port"
[[ "$HTTPS_PORT" != "$BRIDGE_PORT" ]] || fail "HTTPS and bridge ports must differ."
[[ "$REPO_ROOT" == /* && -f "$REPO_ROOT/bridge/src/faceclaw.ts" && -f "$REPO_ROOT/bridge/package.json" ]] || fail "Run the installer from a complete Faceclaw T3 Bridge checkout."
[[ "$REPO_ROOT" != *$'\n'* && "$REPO_ROOT" != *$'\r'* ]] || fail "Repository path contains invalid data."
RUNTIME_DIR="$APP_SUPPORT_DIR/runtime"
if [[ -e "$RUNTIME_DIR" ]]; then
  [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]] || fail "Installed runtime target is invalid."
  [[ -d "$USER_HOME/.Trash" && ! -L "$USER_HOME/.Trash" ]] || fail "User Trash directory is unavailable. Runtime files were not changed."
fi

run_or_print() {
  if $DRY_RUN; then
    print -n -- "DRY RUN:"
    printf ' %q' "$@"
    print
  else
    "$@"
  fi
}

ensure_homebrew() {
  if command_path brew >/dev/null; then return; fi
  fail "Homebrew is required. Install it from https://brew.sh, then run this installer again."
}

ensure_node() {
  NODE_PATH="$(command_path node || true)"
  if [[ -n "$NODE_PATH" ]]; then
    local version major minor remainder
    version="$($NODE_PATH -p 'process.versions.node')"
    major="${version%%.*}"
    remainder="${version#*.}"
    minor="${remainder%%.*}"
    if (( major > 22 || (major == 22 && minor >= 16) )); then
      return
    fi
  fi
  ensure_homebrew
  run_or_print "$(command_path brew)" install node
  if $DRY_RUN; then
    NODE_PATH="node"
    return
  fi
  NODE_PATH="$(command_path node || true)"
  [[ -n "$NODE_PATH" ]] || fail "Node was not found after installation."
}

ensure_tailscale() {
  if command_path tailscale >/dev/null; then return; fi
  ensure_homebrew
  run_or_print "$(command_path brew)" install --cask tailscale-app
  if ! $DRY_RUN && ! command_path tailscale >/dev/null; then
    fail "The Tailscale CLI was not found after installation. Open Tailscale once, then rerun this installer."
  fi
}

if $DRY_RUN; then
  note "Dry run. No packages, credentials, services, proxies, or files will change."
fi

# This uses only macOS system tools, so it runs before Homebrew or Node can be
# installed. Unknown listeners are never killed.
EARLY_PORT_STATE="$(bridge_port_owner_state "$BRIDGE_PORT")"
if [[ "$EARLY_PORT_STATE" == "occupied" ]]; then
  if $DRY_RUN; then
    note "DRY RUN: installation would refuse bridge port $BRIDGE_PORT because a manual or unknown listener owns it"
  else
    fail "Bridge port $BRIDGE_PORT is already used by a process outside this LaunchAgent. Stop the manually started bridge, or choose another --bridge-port. No process was stopped."
  fi
fi

ensure_homebrew
NODE_PATH=""
ensure_node
"$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" t3-environment "$CUSTOM_T3_APP_PATH" "$CUSTOM_T3_BASE_DIR" "$CUSTOM_T3_BASE_URL" >/dev/null || fail "Custom T3 configuration is invalid; use an exact numeric loopback HTTP origin."
ensure_tailscale

if $DRY_RUN; then
  TAILSCALE_HOST="your-mac.your-tailnet.ts.net"
else
  TAILSCALE_HOST="$("$(command_path tailscale)" status --json | "$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" tailscale-host)" || \
    fail "Tailscale is not ready. Open Tailscale, sign in, connect this Mac, then rerun the installer."
fi

TAILSCALE="$(command_path tailscale || print tailscale)"
if $DRY_RUN; then
  note "DRY RUN: inspect Tailscale Serve port $HTTPS_PORT and refuse an unrelated handler"
else
  SERVE_PORT_STATE="$("$TAILSCALE" serve status --json | "$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" serve-port-state "$TAILSCALE_HOST" "$HTTPS_PORT" "$BRIDGE_PORT")"
  if [[ "$SERVE_PORT_STATE" == "conflict" && "$REPLACE_TAILSCALE_HANDLER" != true ]]; then
    fail "Tailscale Serve port $HTTPS_PORT already has an unrelated handler. Choose another --https-port or rerun with --replace-tailscale-handler after reviewing 'tailscale serve status'."
  fi
  [[ "$SERVE_PORT_STATE" == "empty" || "$SERVE_PORT_STATE" == "ours" || "$SERVE_PORT_STATE" == "conflict" ]] || fail "Could not verify the existing Tailscale Serve handler."
fi

if $DRY_RUN; then
  note "DRY RUN: inspect bridge port $BRIDGE_PORT and refuse an unknown listener"
else
  ROLLBACK_SERVICE_INSTALL=true
  BRIDGE_PORT_STATE="$("$NODE_PATH" "$SCRIPT_DIR/port-preflight.mjs" "$SERVICE_LABEL" "$GUI_DOMAIN" "$BRIDGE_PORT")"
  if [[ "$BRIDGE_PORT_STATE" == "occupied" ]]; then
    fail "Bridge port $BRIDGE_PORT is already used by a process outside this LaunchAgent. Stop the manually started bridge, or choose another --bridge-port. No process was stopped."
  fi
  [[ "$BRIDGE_PORT_STATE" == "free" || "$BRIDGE_PORT_STATE" == "owned" ]] || fail "Could not verify bridge port ownership."
fi

if $DRY_RUN; then
  note "DRY RUN: request a hidden 12 to 256 character pairing passphrase twice"
  note "DRY RUN: store passphrase and generated bridge token in user-only files with mode 0600"
else
  existing_passphrase=false
  if secret_has passphrase; then existing_passphrase=true; fi
  while true; do
    if $existing_passphrase; then
      print -n -- "New pairing passphrase, 12 to 256 characters. Leave blank to keep the current value: "
    else
      print -n -- "Pairing passphrase, 12 to 256 characters: "
    fi
    IFS= read -r -s passphrase
    print
    if [[ -z "$passphrase" && "$existing_passphrase" == true ]]; then break; fi
    if (( ${#passphrase} < 12 || ${#passphrase} > 256 )); then
      note "Passphrase must be 12 to 256 characters."
      continue
    fi
    print -n -- "Confirm pairing passphrase: "
    IFS= read -r -s confirmation
    print
    if [[ "$passphrase" != "$confirmation" ]]; then
      unset passphrase confirmation
      note "Passphrases did not match."
      continue
    fi
    secret_store passphrase "$passphrase"
    unset passphrase confirmation
    break
  done
  if ! secret_has token; then
    bridge_token="$(/usr/bin/openssl rand -base64 48 | /usr/bin/tr '+/' '-_' | /usr/bin/tr -d '=\n')"
    [[ ${#bridge_token} -ge 32 ]] || fail "Could not generate a bridge token."
    secret_store token "$bridge_token"
    unset bridge_token
  fi
fi

run_or_print /usr/bin/install -d -m 700 "$APP_SUPPORT_DIR" "$LOG_DIR" "$USER_HOME/Library/LaunchAgents"
run_or_print "$(command_path npm || print npm)" ci --prefix "$REPO_ROOT/bridge"
run_or_print "$NODE_PATH" "$REPO_ROOT/bridge/scripts/setup-whisper.mjs"
run_or_print "$(command_path npm || print npm)" --prefix "$REPO_ROOT/bridge" run build

RUNTIME_BRIDGE_DIR="$RUNTIME_DIR/bridge"
RUNTIME_SCRIPT_DIR="$RUNTIME_DIR/scripts"
if $DRY_RUN; then
  RUNTIME_STAGING="$APP_SUPPORT_DIR/runtime.staging.DRY_RUN"
else
  RUNTIME_STAGING="$(/usr/bin/mktemp -d "$APP_SUPPORT_DIR/runtime.staging.XXXXXX")"
fi
STAGING_BRIDGE_DIR="$RUNTIME_STAGING/bridge"
STAGING_SCRIPT_DIR="$RUNTIME_STAGING/scripts"
run_or_print /usr/bin/install -d -m 700 "$STAGING_BRIDGE_DIR" "$STAGING_BRIDGE_DIR/scripts" "$STAGING_SCRIPT_DIR/lib"
run_or_print /bin/cp -f "$REPO_ROOT/bridge/package.json" "$REPO_ROOT/bridge/package-lock.json" "$STAGING_BRIDGE_DIR/"
run_or_print /usr/bin/ditto "$REPO_ROOT/bridge/dist" "$STAGING_BRIDGE_DIR/dist"
run_or_print /bin/cp -f "$REPO_ROOT/bridge/scripts/start-with-t3.mjs" "$STAGING_BRIDGE_DIR/scripts/start-with-t3.mjs"
run_or_print /bin/cp -f "$SCRIPT_DIR/portable-deployment.mjs" "$SCRIPT_DIR/deployment-helpers.mjs" "$STAGING_SCRIPT_DIR/"
run_or_print /bin/cp -f "$SCRIPT_DIR/run-service.sh" "$STAGING_SCRIPT_DIR/run-service.sh"
run_or_print /bin/cp -f "$SCRIPT_DIR/lib/common.sh" "$STAGING_SCRIPT_DIR/lib/common.sh"
run_or_print /bin/chmod 700 "$STAGING_SCRIPT_DIR/run-service.sh"
run_or_print "$(command_path npm || print npm)" ci --omit=dev --prefix "$STAGING_BRIDGE_DIR"

if $DRY_RUN; then
  note "DRY RUN: generate $LAUNCH_AGENT_PATH without credentials; persist validated custom T3 app/base/origin selections"
else
  TEMP_PLIST="$(/usr/bin/mktemp "$APP_SUPPORT_DIR/launch-agent.XXXXXX")"
  "$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" launch-agent \
    "$TEMP_PLIST" \
    "$SERVICE_LABEL" \
    "$RUNTIME_SCRIPT_DIR/run-service.sh" \
    "$RUNTIME_BRIDGE_DIR" \
    "$NODE_PATH" \
    "$LOG_DIR/bridge.log" \
    "$LOG_DIR/bridge.error.log" \
    "$TAILSCALE_HOST" \
    "$HTTPS_PORT" \
    "$BRIDGE_PORT" \
    "$ARCHIVE_PROJECT_ID" \
    "$ARCHIVE_WORKSPACE_ROOT" \
    "$CUSTOM_T3_APP_PATH" \
    "$CUSTOM_T3_BASE_DIR" \
    "$CUSTOM_T3_BASE_URL"
  /usr/bin/plutil -lint "$TEMP_PLIST" >/dev/null
  /bin/chmod 600 "$TEMP_PLIST"
fi

if $DRY_RUN; then
  note "DRY RUN: recheck port ownership, stop only the installed LaunchAgent, promote the staged runtime, and require loopback health before enabling Tailscale Serve"
else
  BRIDGE_PORT_STATE="$("$NODE_PATH" "$SCRIPT_DIR/port-preflight.mjs" "$SERVICE_LABEL" "$GUI_DOMAIN" "$BRIDGE_PORT")"
  [[ "$BRIDGE_PORT_STATE" == "free" || "$BRIDGE_PORT_STATE" == "owned" ]] || fail "Bridge port $BRIDGE_PORT changed owners during installation. Stop the manual or unknown listener and rerun. No process was stopped."
  if launchctl_loaded; then
    /bin/launchctl bootout "$GUI_DOMAIN/$SERVICE_LABEL"
    PRIOR_AGENT_UNLOADED=false
    for attempt in {1..20}; do
      BRIDGE_PORT_STATE="$("$NODE_PATH" "$SCRIPT_DIR/port-preflight.mjs" "$SERVICE_LABEL" "$GUI_DOMAIN" "$BRIDGE_PORT")"
      if ! launchctl_loaded; then PRIOR_AGENT_UNLOADED=true; else PRIOR_AGENT_UNLOADED=false; fi
      [[ "$BRIDGE_PORT_STATE" == "free" && "$PRIOR_AGENT_UNLOADED" == true ]] && break
      /bin/sleep 0.25
    done
    [[ "$BRIDGE_PORT_STATE" == "free" && "$PRIOR_AGENT_UNLOADED" == true ]] || fail "The prior LaunchAgent did not fully unload or release bridge port $BRIDGE_PORT. No unknown process was killed."
  fi
  if [[ -d "$RUNTIME_DIR" ]]; then
    TRASH_HOLDER="$(/usr/bin/mktemp -d "$USER_HOME/.Trash/Even T3 Bridge replaced runtime.XXXXXX")"
    /bin/mv "$RUNTIME_DIR" "$TRASH_HOLDER/runtime"
  fi
  /bin/mv "$RUNTIME_STAGING" "$RUNTIME_DIR"
  /bin/mv -f "$TEMP_PLIST" "$LAUNCH_AGENT_PATH"
  "$NODE_PATH" -e '
    const fs = require("fs");
    const [file, host, httpsPort, bridgePort, archiveProjectId, archiveWorkspaceRoot, t3AppPath, t3BaseDir, t3BaseUrl] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({ host, httpsPort: Number(httpsPort), bridgePort: Number(bridgePort), archiveProjectId: archiveProjectId || null, archiveWorkspaceRoot: archiveWorkspaceRoot || null, t3AppPath, t3BaseDir, t3BaseUrl }, null, 2) + "\n", { mode: 0o600 });
  ' "$SERVICE_STATE_PATH" "$TAILSCALE_HOST" "$HTTPS_PORT" "$BRIDGE_PORT" "$ARCHIVE_PROJECT_ID" "$ARCHIVE_WORKSPACE_ROOT" "$CUSTOM_T3_APP_PATH" "$CUSTOM_T3_BASE_DIR" "$CUSTOM_T3_BASE_URL"
  /bin/launchctl enable "$GUI_DOMAIN/$SERVICE_LABEL"
  /bin/launchctl bootstrap "$GUI_DOMAIN" "$LAUNCH_AGENT_PATH"
  /bin/launchctl kickstart -k "$GUI_DOMAIN/$SERVICE_LABEL"

  BRIDGE_HEALTHY=false
  for attempt in {1..120}; do
    if /usr/bin/curl --silent --show-error --fail --max-time 1 "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
      BRIDGE_HEALTHY=true
      break
    fi
    /bin/sleep 0.5
  done
  if [[ "$BRIDGE_HEALTHY" != true ]]; then
    fail "The LaunchAgent was installed, but the loopback bridge did not become healthy. Tailscale Serve was not changed. Check scripts/service.sh logs, then rerun the installer."
  fi
fi

# Configure the tailnet listener only after the trusted loopback service has
# passed its health check. This is the final mutating step so a later install
# failure cannot leave a newly exposed stale or absent backend.
run_or_print "$TAILSCALE" serve --bg "--https=$HTTPS_PORT" "http://127.0.0.1:$BRIDGE_PORT"
ROLLBACK_SERVICE_INSTALL=false

if $DRY_RUN; then
  WSS_URL="$("$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" events-url "$TAILSCALE_HOST" "$HTTPS_PORT")"
  note "T3 bridge URL: $WSS_URL"
else
  "$SCRIPT_DIR/show-connection-info.sh"
  note "From the Faceclaw T3 Bridge repository root, rerun this connection check any time with: npm run connection-info"
  note "Service installed. T3 Code must be running for the bridge to connect."
  note "In the T3 app's settings, enter the T3 bridge URL above and your pairing passphrase."
fi
