# Third-party notices

Original code in this repository is MIT licensed. Dependencies and assets keep their own licenses; the project license does not replace them.

| Component | License | Notice |
| --- | --- | --- |
| ws | MIT | License installed with the locked npm dependency |
| qrcode 1.5.4 (local Signal linking QR) | MIT | License installed with the locked npm dependency |

Node.js, T3 Code, Tailscale, whisper.cpp, and Whisper model weights are installed separately and retain their upstream licenses. This repository does not redistribute those executables or model weights. Development tools installed through npm retain their package licenses.

Signal support invokes a separately installed signal-cli 0.14.7 executable (GPLv3), with its libsignal dependencies, over JSON-RPC. signal-cli and Java are not bundled into this repository's release package and keep their upstream licenses. Review their distribution requirements before separately shipping either runtime.

Weather and city data come from Open-Meteo and GeoNames. The default weather integration uses Open-Meteo's noncommercial service; that service's terms apply independently of this source code's MIT license. See [Open-Meteo terms](https://open-meteo.com/en/terms).
