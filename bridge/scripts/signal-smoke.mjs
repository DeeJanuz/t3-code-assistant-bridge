// No-account runtime check. Requires an explicitly selected executable and JRE.
// It never reads installed bridge configuration or runs linking/sending methods.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SignalCli } from '../dist/src/signal-cli.js';

const executable = process.env.SIGNAL_SMOKE_CLI_PATH;
if (!executable || !isAbsolute(executable) || !process.env.JAVA_HOME || !isAbsolute(process.env.JAVA_HOME)) throw new Error('Set absolute SIGNAL_SMOKE_CLI_PATH and JAVA_HOME for this isolated check');
const directory = mkdtempSync(join(tmpdir(), 'faceclaw-signal-no-account-'));
const cli = new SignalCli(executable, directory);
try {
  cli.start(() => { throw new Error('Unexpected receive event in empty account directory'); });
  const deadline = Date.now() + 20_000;
  while (!cli.ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(cli.ready, true, cli.health);
  assert.deepEqual(await cli.request('version'), { version: '0.14.7' });
  assert.deepEqual(await cli.request('listAccounts'), []);
  await cli.resetData();
  process.stdout.write('Signal CLI 0.14.7: supervised version, empty accounts, receive subscription, shutdown and local cleanup passed. No account linked or messages sent.\n');
} finally { cli.stop(); rmSync(directory, { recursive: true, force: true }); }
