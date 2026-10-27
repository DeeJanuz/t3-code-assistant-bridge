// These optional features protect their state with POSIX ownership and mode
// checks and launch helper executables. Windows equivalents are not
// implemented, so they fail closed there instead of running unprotected.
export const POSIX_ONLY_REASON = "supported only on macOS and Linux";

export function assertPosixFeature(feature: string, settings: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`${feature} is ${POSIX_ONLY_REASON}; leave ${settings} unset on Windows`);
  }
}
