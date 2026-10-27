#!/bin/zsh

set -euo pipefail
set +x
umask 077

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/lib/common.sh"

validate_install_targets

[[ -f "$SERVICE_STATE_PATH" && ! -L "$SERVICE_STATE_PATH" ]] || fail "Deployment state is missing. Run scripts/install.sh first."
[[ "$(/usr/bin/stat -f '%u' "$SERVICE_STATE_PATH")" == "$(/usr/bin/id -u)" ]] || fail "Deployment state is not owned by the current user."
[[ "$(/usr/bin/stat -f '%Lp' "$SERVICE_STATE_PATH")" == "600" ]] || fail "Deployment state must have mode 0600. Run scripts/install.sh again."

NODE_PATH="$(command_path node || true)"
[[ -n "$NODE_PATH" ]] || fail "Node.js is unavailable. Run scripts/install.sh again."
TAILSCALE="$(command_path tailscale || true)"
[[ -n "$TAILSCALE" ]] || fail "The Tailscale CLI is unavailable. Install or open Tailscale, then try again."

STORED_HOST="$(/usr/bin/plutil -extract host raw -o - "$SERVICE_STATE_PATH" 2>/dev/null)" || fail "Deployment state has no Tailscale host. Run scripts/install.sh again."
HTTPS_PORT="$(/usr/bin/plutil -extract httpsPort raw -o - "$SERVICE_STATE_PATH" 2>/dev/null)" || fail "Deployment state has no HTTPS port. Run scripts/install.sh again."
BRIDGE_PORT="$(/usr/bin/plutil -extract bridgePort raw -o - "$SERVICE_STATE_PATH" 2>/dev/null)" || fail "Deployment state has no bridge port. Run scripts/install.sh again."
validate_port "$HTTPS_PORT" "stored HTTPS port"
validate_port "$BRIDGE_PORT" "stored bridge port"

CURRENT_HOST="$("$TAILSCALE" status --json 2>/dev/null | "$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" tailscale-host)" || fail "Tailscale is unavailable or disconnected. Open Tailscale, connect this Mac, then try again."
[[ "$STORED_HOST" == "$CURRENT_HOST" ]] || fail "The bridge was installed for a different Tailscale host. Run scripts/install.sh again."

SERVE_STATE="$("$TAILSCALE" serve status --json 2>/dev/null | "$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" serve-port-state "$CURRENT_HOST" "$HTTPS_PORT" "$BRIDGE_PORT")" || fail "Tailscale Serve is unavailable. Reconnect Tailscale or run scripts/install.sh again."
[[ "$SERVE_STATE" == "ours" ]] || {
  if [[ "$SERVE_STATE" == "empty" ]]; then
    fail "The Faceclaw T3 Bridge Tailscale Serve handler is missing. Run scripts/install.sh again."
  fi
  fail "Tailscale Serve port $HTTPS_PORT does not match this Faceclaw T3 Bridge deployment. Review it before reinstalling."
}

WSS_URL="$("$NODE_PATH" "$SCRIPT_DIR/deployment-helpers.mjs" events-url "$CURRENT_HOST" "$HTTPS_PORT")" || fail "Could not create a safe bridge URL."
note "T3 bridge URL:"
note "$WSS_URL"
note "Enter this exact URL in the T3 app's bridge settings on your phone."
note "This command does not display the pairing passphrase or bearer token."
