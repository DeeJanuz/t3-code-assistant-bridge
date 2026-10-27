import { createRequire } from 'node:module';
import { tailscaleOrigins } from './deployment-helpers.mjs';
import { nativeToken } from './portable-deployment.mjs';

function rpc(socket, id, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('message', received); socket.off('close', closed); socket.off('error', closed); };
    const closed = () => { cleanup(); reject(new Error('Provider verification connection closed')); };
    const received = (raw) => {
      let response;
      try { response = JSON.parse(raw.toString()); } catch { return; }
      if (response?.type !== 'response' || response.id !== id) return;
      cleanup(); resolve(response);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Provider verification timed out')); }, timeoutMs);
    socket.on('message', received); socket.once('close', closed); socket.once('error', closed);
    try { socket.send(JSON.stringify({ v: 1, type: 'request', id, method, params })); }
    catch { cleanup(); reject(new Error('Provider verification connection closed')); }
  });
}

/** Reads only readiness and transcribes synthetic silence. Never sends a T3 message. */
export async function verifyProviders(config, token, dependencies = {}) {
  const { httpsOrigin, eventsUrl } = tailscaleOrigins(config.host, config.httpsPort);
  const request = dependencies.request ?? fetch;
  const response = await request(`${httpsOrigin}/v1/status`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  await response.body?.cancel();
  if (response.status !== 200) throw new Error('Authenticated T3 readiness check failed');
  const WebSocket = dependencies.WebSocket ?? createRequire(new URL('../bridge/package.json', import.meta.url))('ws');
  const socket = new WebSocket(eventsUrl, ['even-t3-v1', `auth.${nativeToken(token)}`], { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15000 });
  // Suppress raw socket errors: URLs and server responses may contain private data.
  socket.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Authenticated WSS connection failed')); };
      const timer = setTimeout(failed, 15000);
      socket.once('open', opened); socket.once('error', failed); socket.once('close', failed);
    });
    const started = await rpc(socket, 'verify-voice-start', 'voice.start');
    if (started?.error || started?.result?.format !== 'pcm_s16le') throw new Error('Whisper verification capture failed');
    socket.send(Buffer.alloc(32000));
    const finished = await rpc(socket, 'verify-voice-finish', 'voice.finish', {}, 90000);
    if (typeof finished?.result?.text !== 'string' && finished?.error?.code !== 'no_speech') throw new Error('Local Whisper inference check failed');
    return { t3: 'ready', whisper: 'synthetic silence inference passed', transport: 'authenticated private HTTPS and WSS passed' };
  } finally { socket.terminate(); }
}
