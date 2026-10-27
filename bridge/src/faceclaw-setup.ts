import { assertPosixFeature } from './platform-support.js';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launcherToken } from './faceclaw.js';
import { validateLauncherConfig } from './faceclaw-launcher.js';

/** Generates a new private launcher profile. Never edits an existing T3/Codex
 * configuration and never prints its credential. BRIDGE_TOKEN stays out of it. */
export async function createLauncherProfile(destination: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  assertPosixFeature('The Faceclaw provider launcher', 'the generated launcher profile');
  if (!isAbsolute(destination)) throw new Error('Destination must be absolute');
  const projectId = env.BRIDGE_FACECLAW_PROJECT_ID;
  const ownerToken = env.BRIDGE_TOKEN;
  if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId) || !ownerToken || !/^[A-Za-z0-9_-]{32,256}$/.test(ownerToken)) {
    throw new Error('Set BRIDGE_TOKEN and BRIDGE_FACECLAW_PROJECT_ID in the local owner environment');
  }
  const config = validateLauncherConfig({
    bridgeOrigin: env.FACECLAW_BRIDGE_ORIGIN ?? 'http://127.0.0.1:8787',
    codexPath: env.FACECLAW_CODEX_PATH,
    workspaceRoot: env.FACECLAW_WORKSPACE_ROOT,
    launcherToken: launcherToken(ownerToken, projectId),
  });
  config.workspaceRoot = await realpath(config.workspaceRoot);
  config.codexPath = await realpath(config.codexPath);
  await mkdir(destination, { mode: 0o700 });
  const path = join(destination, 'codex-faceclaw.mjs');
  await writeFile(join(destination, 'launcher.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const moduleUrl = new URL('./faceclaw-launcher.js', import.meta.url).href;
  const entry = `#!/usr/bin/env node\nimport {runFaceclawLauncher} from ${JSON.stringify(moduleUrl)};\nrunFaceclawLauncher(${JSON.stringify(join(destination, 'launcher.json'))}, process.argv.slice(2)).catch(()=>{process.stderr.write('Faceclaw provider launch failed. Check the local bridge and launcher configuration.\\n');process.exitCode=1;});\n`;
  await writeFile(path, entry, { mode: 0o700, flag: 'wx' });
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createLauncherProfile(process.argv[2] ?? '').then(path => {
    process.stdout.write(`Created private Faceclaw Codex launcher: ${path}\nSelect this executable for a separate T3 Codex provider. Existing providers were not changed.\n`);
  }).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Launcher setup failed'}\n`); process.exitCode = 1; });
}
