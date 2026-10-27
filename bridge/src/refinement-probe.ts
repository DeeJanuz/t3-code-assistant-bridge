import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from './security.js';

/** Inspect the actual installed CLI request before any real transcript reaches
 * a model. No model runs: the loopback provider returns an error and exits.
 * Fail closed if a CLI update/configuration adds tools or changes the model. */
export async function verifyToolFreeExecutable(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<void> {
  let observed = false;
  let safe = false;
  let stopChild: () => void = () => {};
  const path = `/${randomUUID()}`;
  const server = createServer((request, response) => {
    void (async () => {
      let bytes = 0; const chunks: Buffer[] = [];
      try {
        for await (const raw of request) {
          const chunk = Buffer.from(raw); bytes += chunk.length;
          if (bytes > 256 * 1024) throw new Error();
          chunks.push(chunk);
        }
        if (request.url !== path + '/responses') throw new Error();
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown; reasoning?: { effort?: unknown }; tools?: unknown };
        observed = true;
        safe = body.model === 'gpt-5.6-luna' && body.reasoning?.effort === 'low' &&
          (body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0));
      } catch { safe = false; }
      response.writeHead(400); response.end('{}'); stopChild();
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
    const probeArgs = [...args.slice(0, -1), '--config', 'model_provider="faceclaw_probe"', '--config',
      `model_providers.faceclaw_probe={name="Faceclaw isolation probe",base_url="${base}",wire_api="responses",requires_openai_auth=false}`,
      '--config', 'features.enable_request_compression=false', '-'];
    await new Promise<void>(resolve => {
      const child = spawn(executable, probeArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      stopChild = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* exited */ } };
      let outputBytes = 0;
      const consume = (data: Buffer) => { outputBytes += data.length; if (outputBytes > 256 * 1024) stopChild(); };
      child.stdout.on('data', consume); child.stderr.on('data', consume); child.stdin.on('error', () => {});
      child.on('error', () => {});
      const timer = setTimeout(stopChild, 10_000);
      signal.addEventListener('abort', stopChild, { once: true });
      child.once('close', () => { clearTimeout(timer); signal.removeEventListener('abort', stopChild); resolve(); });
      if (signal.aborted) stopChild();
      child.stdin.end('Rewrite the sample word hello.');
    });
    if (signal.aborted) throw new ApiError(409, 'refinement_cancelled', 'Refinement was cancelled');
    if (!observed || !safe) throw new ApiError(503, 'refinement_isolation_failed', 'The installed Codex runtime did not pass the tool isolation check');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
