import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RefinementService, refinementArgs, refinementCatalog } from '../src/refinement.js';

test('refinement removes tool/config exposure and fixes exact model and reasoning', () => {
  const args = refinementArgs('/tmp/refinement-test');
  assert(args.includes('--ignore-user-config')); assert(args.includes('--ignore-rules')); assert(args.includes('--ephemeral'));
  assert(args.includes('mcp_servers={}')); assert(args.includes('features.shell_tool=false')); assert(args.includes('features.plugins=false'));
  assert(args.includes('web_search="disabled"')); assert(args.includes('model_reasoning_effort="low"'));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-luna');
  assert.equal(refinementCatalog.models[0]!.apply_patch_tool_type, null);
  assert.deepEqual(refinementCatalog.models[0]!.experimental_supported_tools, []);
});

test('refinement is opt-in, bounds untrusted text, and never returns a partial failed draft', { skip: process.platform === 'win32' && 'Luna refinement is supported only on macOS and Linux' }, async () => {
  await assert.rejects(new RefinementService(undefined).rewrite({ text: 'hi', instruction: 'fix' }, new AbortController().signal), /not configured/);
  const dir = await mkdtemp(join(tmpdir(), 'refinement-test-'));
  const executable = join(dir, 'fake-codex');
  try {
    const fake = `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv;
const probe=args.find(x=>x.startsWith('model_providers.faceclaw_probe='));
if(probe){const base=JSON.parse(probe.match(/base_url=("[^"]+")/)[1]);fetch(base+'/responses',{method:'POST',body:JSON.stringify({model:'gpt-5.6-luna',reasoning:{effort:'low'},tools:[]})}).catch(()=>{});}
else { const path=args[args.indexOf('--output-last-message')+1]; let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const parsed=JSON.parse(input);if(parsed.transcript==='fail'){process.stderr.write('sensitive upstream body');process.exit(1);} if(parsed.transcript==='hang') {setInterval(()=>{},1000);return;} fs.writeFileSync(path,JSON.stringify({text:parsed.transcript.toUpperCase()}));}); }
`;
    await writeFile(executable, fake, { mode: 0o700 });
    const service = new RefinementService(executable, 5000);
    await assert.rejects(service.rewrite({ text: 'a'.repeat(8001), instruction: 'fix' }, new AbortController().signal), /Invalid/);
    assert.deepEqual(await service.rewrite({ text: 'hello', instruction: 'uppercase' }, new AbortController().signal), { text: 'HELLO' });
    await assert.rejects(service.rewrite({ text: 'fail', instruction: 'fix' }, new AbortController().signal), error => error instanceof Error && !error.message.includes('sensitive') && error.message.includes('unchanged'));
    const abort = new AbortController();
    const pending = service.rewrite({ text: 'hang', instruction: 'fix' }, abort.signal);
    await assert.rejects(service.rewrite({ text: 'hi', instruction: 'fix' }, new AbortController().signal), /in progress/);
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(pending, /cancelled/);
    const timeout = new RefinementService(executable, 100);
    await assert.rejects(timeout.rewrite({ text: 'hang', instruction: 'fix' }, new AbortController().signal), /timed out/);
    await writeFile(executable, fake.replace('tools:[]', "tools:[{type:'function',name:'shell'}]"));
    await assert.rejects(service.rewrite({ text: 'hello', instruction: 'fix' }, new AbortController().signal), /isolation check/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
