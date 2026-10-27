#!/usr/bin/env node
// Owner CLI. Invitation secrets are read from private files, never argv or logs.
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dataDirectory, cleanPath } from './portable-deployment.mjs';
import { readPrivateFile } from './portable-service.mjs';
import { PeerStore, identity, peerHash, peerSecret, peerOrigin, readPeerFile, writePeerFile, validPeerToken } from '../bridge/dist/src/peer-store.js';

async function post(origin, route, data, token) {
  const response = await fetch(new URL(route, peerOrigin(origin)), { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Peer exchange failed. Check both services and invitation expiry.'); }
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 16_384) throw new Error('Invalid peer response'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function main(args = process.argv.slice(2)) {
  const [command, argument] = args;
  const mac = process.platform === 'darwin' && !process.env.BRIDGE_SERVICE_CONFIG;
  const serviceFile = process.env.BRIDGE_SERVICE_CONFIG || (mac ? path.join(dataDirectory(), 'deployment-state.json') : path.join(dataDirectory(), 'service', 'portable-config.json'));
  const config = JSON.parse(await readPrivateFile(serviceFile));
  const directory = config.peerDirectory || path.join(path.dirname(serviceFile), 'peers');
  const setEnabled = async enabled => {
    if (mac) { await writePeerFile(path.join(directory, 'settings.json'), { enabled }); return; }
    const { peerDirectory: _, ...local } = config;
    await writePeerFile(serviceFile, enabled ? { ...local, peerDirectory: directory } : local);
  };
  const store = new PeerStore(directory);
  if (command === 'init') {
    const response = await fetch(new URL('/.well-known/t3/environment', config.t3BaseUrl || 'http://127.0.0.1:3773'), { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Start local T3 before initializing peers');
    const descriptor = await response.json();
    const origin = peerOrigin(`https://${config.host}:${config.httpsPort}`);
    await store.initialize({ environmentId: descriptor.environmentId, label: descriptor.label, origin });
    await setEnabled(true);
    console.log('Peer identity initialized. Restart the bridge service to enable peer endpoints.');
    return;
  }
  if (command === 'invite') {
    const file = path.join(directory, 'invitation.json');
    await writePeerFile(file, await store.invite());
    console.log(`Invitation saved to ${file}. Transfer privately and accept within five minutes. Do not paste its contents into chat.`);
    return;
  }
  if (command === 'accept') {
    if (!argument) throw new Error('Usage: peers.mjs accept /absolute/path/to/invitation.json');
    const invite = JSON.parse(await readPeerFile(cleanPath(path.resolve(argument))));
    if (invite.version !== 1 || !validPeerToken(invite.secret) || typeof invite.id !== 'string' || !/^[a-f0-9-]{36}$/.test(invite.id)) throw new Error('Invalid invitation');
    const remote = identity(invite.identity), state = await store.read();
    let entry = state.peers.find(p => p.bridgeId === remote.bridgeId);
    if (entry && (entry.transactionId !== invite.id || entry.origin !== remote.origin || entry.environmentId !== remote.environmentId)) throw new Error('Peer already enrolled with a different invitation');
    if (!entry) {
      if (invite.expiresAt <= Date.now()) throw new Error('Invitation expired');
      store.assertNew(state, remote);
      const transactionFile = path.join(directory, `accept-${invite.id}.json`);
      let transaction;
      try { transaction = JSON.parse(await readPeerFile(transactionFile)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; transaction = { token: peerSecret(), remote }; await writePeerFile(transactionFile, transaction); }
      if (!validPeerToken(transaction.token) || JSON.stringify(transaction.remote) !== JSON.stringify(remote)) throw new Error('Invalid pending transaction');
      const result = await post(remote.origin, '/v1/peer/pair', { version: 1, id: invite.id, secret: invite.secret, token: transaction.token, identity: state.identity });
      if (JSON.stringify(identity(result.identity)) !== JSON.stringify(remote) || !validPeerToken(result.token)) throw new Error('Peer identity changed during pairing');
      entry = { ...remote, state: 'pending', incomingHash: peerHash(transaction.token), outgoingToken: result.token, transactionId: invite.id };
      await store.update(current => { store.assertNew(current, remote); current.peers.push(entry); });
      await rm(transactionFile, { force: true });
    }
    const confirmed = await post(remote.origin, '/v1/peer/confirm', {}, entry.outgoingToken);
    if (JSON.stringify(identity(confirmed)) !== JSON.stringify(remote)) throw new Error('Peer identity changed');
    await store.update(current => {
      const peer = current.peers.find(p => p.bridgeId === remote.bridgeId && p.transactionId === invite.id);
      if (!peer) throw new Error('Peer was revoked during pairing');
      peer.state = 'paired';
    });
    console.log(`Paired with ${remote.label}. Run status on both computers to inspect connectivity.`);
    return;
  }
  if (command === 'list' || command === 'status') {
    const state = await store.read();
    console.log(JSON.stringify({ identity: state.identity, peers: state.peers.map(({ bridgeId, environmentId, label, origin, state }) => ({ bridgeId, environmentId, label, origin, state })) }, null, 2));
    if (command === 'status') {
      const credentials = mac ? { bridgeToken: await readPeerFile(path.join(dataDirectory(), 'credentials', 'bridge-token')) }
        : JSON.parse(await readPrivateFile(path.join(path.dirname(serviceFile), 'credentials.json')));
      const response = await fetch(`http://127.0.0.1:${config.bridgePort}/v1/environments`, {
        headers: { Authorization: `Bearer ${credentials.bridgeToken}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Could not inspect running bridge');
      console.log(JSON.stringify(await response.json(), null, 2));
    }
    return;
  }
  if (command === 'revoke') {
    if (!argument) throw new Error('Usage: peers.mjs revoke BRIDGE_ID');
    await store.revoke(argument);
    console.log('Peer revoked locally. Revoke the reciprocal entry on the other computer to remove both grants.');
    return;
  }
  if (command === 'enable') {
    await store.read();
    await setEnabled(true);
    console.log('Peer federation enabled. Restart the bridge service.');
    return;
  }
  if (command === 'disable') {
    await setEnabled(false);
    console.log('Peer federation disabled in configuration. Restart the bridge; pairings are preserved.');
    return;
  }
  throw new Error('Usage: peers.mjs init | invite | accept FILE | list | status | revoke BRIDGE_ID | enable | disable');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Peer setup failed'); process.exitCode = 1; });
}
