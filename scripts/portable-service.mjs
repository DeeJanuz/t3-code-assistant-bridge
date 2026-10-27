import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridgeEnvironment, cleanPath } from './portable-deployment.mjs';

export async function readPrivateFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Invalid private configuration file');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw new Error('Configuration must be owned by this user with mode 0600');
  return readFile(file, 'utf8');
}
export async function main(configPath) {
  cleanPath(configPath);
  const config = JSON.parse(await readPrivateFile(configPath));
  const credentials = JSON.parse(await readPrivateFile(path.join(path.dirname(configPath), 'credentials.json')));
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(credentials.bridgeToken) || !/^[A-Za-z0-9_-]{12,256}$/.test(credentials.pairingPassphrase)) throw new Error('Invalid stored credentials');
  const inherited = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'XDG_RUNTIME_DIR']) {
    if (process.env[key]) inherited[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, inherited, bridgeEnvironment(config), { BRIDGE_TOKEN: credentials.bridgeToken, BRIDGE_PASSPHRASE: credentials.pairingPassphrase });
  const { main: launch } = await import('../bridge/scripts/start-with-t3.mjs');
  await launch();
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(() => { process.stderr.write('Bridge startup failed. Check private configuration and installed prerequisites.\n'); process.exitCode = 1; });
}
