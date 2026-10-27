# Windows and Linux agent procedure

The portable installer is first-install-only. It registers a service for the current user and refuses conflicting files, occupied bridge ports, unsafe paths, or unrelated Tailscale handlers. Do not run the Linux installer as root. Read `node scripts/install-portable.mjs --help` from the selected checkout before executing.

## Install missing prerequisites

Use installed compatible tools first. Resolve each executable to an absolute path for startup, because login services have a different PATH from the agent shell.

**Windows:** Use PowerShell and official package sources. `winget` can install `Git.Git`, `OpenJS.NodeJS.LTS`, `Tailscale.Tailscale`, and `Kitware.CMake` when missing. Confirm exact IDs and package versions through winget before use. For building whisper.cpp, install the C++ build workload in Visual Studio Build Tools if no compatible compiler is present. The usual package is `Microsoft.VisualStudio.2022.BuildTools`; its required workload is `Microsoft.VisualStudio.Workload.VCTools`. Do not remove other workloads or change machine-wide PowerShell execution policy. User/admin installation prompts and Tailscale login may require interaction.

**Linux:** Detect the distribution and package manager. Install Git, a supported Node.js/npm, CMake, a C/C++ compiler, and Tailscale from official/vendor or distribution repositories. On Debian/Ubuntu the build prerequisites are typically `git`, `cmake`, `build-essential`, `pkg-config`, and `libcurl4-openssl-dev`; the distribution's `nodejs` may be too old, so verify the installed version. Follow https://tailscale.com/docs/install/linux for that distribution. Require a working user systemd session; do not silently install a system daemon if none exists.

**Whisper on either platform:** Use https://github.com/ggml-org/whisper.cpp. Prefer a current stable upstream release, pin the chosen tag/commit in the report, and use official release binaries only when their provenance and architecture can be verified. To build from a reviewed checkout:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_SERVER=ON
cmake --build build --config Release --parallel
```

Locate and execute `whisper-server --help` (`whisper-server.exe` on Windows). Common build locations are `build/bin/whisper-server` and `build/bin/Release/whisper-server.exe`; inspect the actual build rather than assuming a path. Keep any required DLLs alongside the Windows binary. Source: https://github.com/ggml-org/whisper.cpp/tree/master/examples/server

## Discover the existing T3 installation

Locate the installed T3 executable. A CLI installation managed by T3's boot service ships a native `t3` executable under `<base dir>/runtime/versions/<version>/t3`; pass it without `--t3-entry`. The launcher then follows T3's active runtime after each self-update. Desktop distributions use the Electron executable plus `resources/app.asar/apps/server/dist/bin.mjs` (with the host's path separators). The launcher supports a native `t3`, Electron plus an ASAR entry, or Node plus a plain JS entry. Do not pass an npm `.cmd` shim as an executable; resolve the underlying executable and JS entry.

Read only the metadata necessary to identify the user's T3 base directory (normally `.t3`), port, and installation. Do not print credentials or open private databases. Confirm that this installed version supports the launcher’s scoped auth commands. Use its existing local server at a numeric loopback URL, default `http://127.0.0.1:3773`; never point local T3 credential exchange at a network URL. T3 Code must be running; this service does not replace its startup policy.

## Prepare and install

```sh
npm ci
npm ci --prefix bridge
npm --prefix bridge run build
```

Set `WHISPER_CPP_SERVER_PATH` to the absolute discovered whisper-server path, then run `npm --prefix bridge run setup:whisper`. This helper downloads `ggml-base.en.bin` and verifies its pinned size/SHA-256; use the returned model path. Environment assignment syntax differs: PowerShell uses `$env:WHISPER_CPP_SERVER_PATH = '...'`; POSIX shells can prefix the command with `WHISPER_CPP_SERVER_PATH='...'`. This is an executable path, not a secret.

Run the portable installer with resolved absolute arguments, first with `--dry-run`, then without it:

```text
node scripts/install-portable.mjs
  --t3-executable <installed-native-t3-Electron-or-Node-executable>
  --t3-entry <server-bin.mjs-or-ASAR-entry; omit for the native t3>
  --t3-base-dir <existing-user-T3-data-directory>
  --t3-url http://127.0.0.1:3773
  --whisper-executable <absolute-whisper-server-path>
  --whisper-model <verified-ggml-base.en.bin-path>
  --tailscale-executable <absolute-tailscale-path>
  --https-port 8443
  --bridge-port 8787
```

The block shows arguments, not a directly executable multiline shell command. Pass them as a native argument list, or use correct quoting and the chosen shell's line continuation. Never interpolate user paths into evaluated shell code.

User data goes under `%LOCALAPPDATA%\Even T3 Bridge` on Windows or `~/.local/share/even-t3-bridge` on Linux. Generated credentials and configuration live in `service/credentials.json` and `service/portable-config.json`. The installer reports their paths, not their values. Have the user privately copy `pairingPassphrase` from the credential file into the T3 app; do not read it into the agent transcript.

If Serve needs additional permission, keep the user service/config and elevate only the exact reviewed command:

```text
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

Use the chosen ports. Do not overwrite an existing handler. Verify afterward:

```sh
node scripts/portable-info.mjs --verify
```

The verification command emits the T3 bridge URL, verifies local native pairing and rejection without authentication, checks T3 through private HTTPS, and exercises Whisper with synthetic silence through private WSS. Also inspect startup registration and service status; these checks do not replace a physical glasses test.

## Operate and remove

Linux:

```sh
systemctl --user status even-t3-bridge.service
systemctl --user start even-t3-bridge.service
systemctl --user stop even-t3-bridge.service
systemctl --user restart even-t3-bridge.service
```

Windows PowerShell:

```powershell
Get-ScheduledTask -TaskName 'Even T3 Bridge' | Get-ScheduledTaskInfo
Start-ScheduledTask -TaskName 'Even T3 Bridge'
Stop-ScheduledTask -TaskName 'Even T3 Bridge'
```

Startup is at the current user's sign-in. Linux linger is optional and must match the user's requested deployment; do not enable it just to make a CI test pass. Windows uses an interactive, limited-privilege task, not a stored account password.

For a requested removal, Linux `systemctl --user disable --now even-t3-bridge.service` disables/stops startup; Windows `Disable-ScheduledTask -TaskName 'Even T3 Bridge'` disables it. Removing the exact Windows task uses `Unregister-ScheduledTask -TaskName 'Even T3 Bridge' -Confirm:$false` after confirming it belongs to this install. Remove only the identified unit/task and requested private files. Retain T3 data and unrelated Tailscale handlers. Confirm exact resource paths before deleting anything.

Sources: https://tailscale.com/docs/install/windows ; https://tailscale.com/docs/install/linux ; https://tailscale.com/docs/reference/tailscale-cli/serve ; https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal
