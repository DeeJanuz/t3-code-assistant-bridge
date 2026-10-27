import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError, parseText, secretMatches } from './security.js';
import type { SignalTransport } from './signal-cli.js';
import { SignalStore, digest, newSignalState, type SignalConversation, type SignalCredential, type SignalMessage, type SignalOperation } from './signal-store.js';

const DAY = 86400_000;
const RECIPIENT = /^(?:\+[1-9][0-9]{5,15}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const GROUP = /^[A-Za-z0-9+/]{1,126}={0,2}$/;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ApiError(400, 'invalid_id', 'Invalid identifier');
  return value;
}
function page(params: Record<string, unknown>, sequence: number): number {
  const value = params.page ?? 0;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1000) throw new ApiError(400, 'invalid_page', 'Invalid page');
  if (value !== 0 && params.snapshotCursor !== String(sequence)) throw new ApiError(409, 'snapshot_changed', 'Snapshot changed; restart from page zero');
  return Number(value);
}
const opaque = (value: string): string => digest(value).slice(0, 40);
const messageId = (account: string, conversationId: string, author: string, timestamp: number): string => opaque(`${account}:${conversationId}:${author}:${timestamp}`);
const publicConversation = ({ id, title, kind, disappearing, expirationSeconds }: SignalConversation, lastMessageAt?: number) =>
  ({ id, title, kind, disappearing, expirationSeconds, ...(lastMessageAt === undefined ? {} : { lastMessageAt }) });
const publicMessage = ({ author: _author, ...message }: SignalMessage) => message;
const publicOperation = ({ fingerprint: _fingerprint, owner: _owner, ...operation }: SignalOperation) => operation;
function sentTimestamp(value: unknown, now: number): number {
  const result = record(value);
  if (!Number.isSafeInteger(result.timestamp) || Number(result.timestamp) <= 0 || Number(result.timestamp) > now + 300_000 || !Array.isArray(result.results) ||
    result.results.length === 0 || result.results.some(r => record(r).type !== 'SUCCESS')) throw new Error('Signal send is partial or unconfirmed');
  return Number(result.timestamp);
}

export class SignalService {
  private timer: NodeJS.Timeout | null = null;
  private codes = new Map<string, { accountId: string; expiresAt: number }>();
  private link: { uri: string; expiresAt: number; status: 'waiting' | 'linked' | 'failed' } | null = null;
  private failure: string | null = null;
  private generation = 0;
  constructor(readonly store: SignalStore, readonly transport: SignalTransport, private readonly now: () => number = Date.now) {}
  start(): void {
    this.transport.start(value => {
      try { this.ingest(value); } catch { this.failure = 'receive-storage-failed'; this.transport.stop(); }
    });
    this.timer = setInterval(() => {
      for (const [key, code] of this.codes) if (code.expiresAt <= this.now()) this.codes.delete(key);
      if (this.link && (this.link.expiresAt <= this.now() || this.link.status !== 'waiting')) this.link.uri = '';
      try { this.store.prune(this.now()); } catch { this.failure = 'storage-failed'; this.transport.stop(); }
    }, 1000);
    this.timer.unref();
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.transport.stop(); this.store.close(); }
  status() {
    return { protocolVersion: 1, accountId: this.store.state.accountId, ready: this.transport.ready && this.store.state.accountId !== null && this.failure === null,
      health: this.failure ?? this.transport.health, retentionDays: this.store.state.retentionDays, preview: this.store.state.preview,
      disappearingMessages: 'conservative-sent-time-expiry', historyImport: false, sendReplay: false };
  }
  private account(): string {
    const account = this.store.state.accountId;
    if (!account) throw new ApiError(409, 'signal_unlinked', 'Link Signal in the bridge setup dashboard');
    return account;
  }
  authenticate(token: string | undefined): SignalCredential {
    this.store.prune(this.now());
    if (!token || token.length > 256) throw new ApiError(401, 'unauthorized', 'Signal credential required');
    const credential = this.store.state.credentials.find(c => secretMatches(digest(token), c.digest));
    if (!credential || credential.accountId !== this.account()) throw new ApiError(401, 'unauthorized', 'Signal credential was revoked');
    return credential;
  }
  private current(credential: SignalCredential, conversation?: string): void {
    if (!this.store.state.credentials.includes(credential) || credential.accountId !== this.account()) throw new ApiError(401, 'unauthorized', 'Signal credential was revoked');
    if (conversation && credential.kind === 'assistant' && !credential.conversations.includes(conversation)) throw new ApiError(403, 'conversation_denied', 'Conversation is not enabled for assistant access');
  }
  createPairing() {
    this.account();
    for (const [key, value] of this.codes) if (value.expiresAt <= this.now()) this.codes.delete(key);
    if (this.codes.size >= 8) throw new ApiError(429, 'too_many_codes', 'Wait for existing pairing codes to expire');
    const code = randomBytes(16).toString('hex'), expiresAt = this.now() + 120_000;
    this.codes.set(digest(code), { accountId: this.account(), expiresAt });
    return { code, expiresAt };
  }
  pair(body: Record<string, unknown>) {
    if (Object.keys(body).length !== 1 || typeof body.code !== 'string') throw new ApiError(401, 'pairing_failed', 'Pairing failed');
    const key = digest(body.code), entry = this.codes.get(key);
    if (!entry || entry.expiresAt <= this.now() || entry.accountId !== this.account()) throw new ApiError(401, 'pairing_failed', 'Pairing failed');
    this.codes.delete(key);
    return this.issue('app', []);
  }
  private issue(kind: 'app' | 'assistant', conversations: string[]) {
    if (this.store.state.credentials.length >= 32) throw new ApiError(409, 'credential_limit', 'Revoke an old credential first');
    const token = `fcs_${randomBytes(32).toString('base64url')}`, credentialId = randomUUID(), accountId = this.account();
    this.store.state.credentials.push({ id: credentialId, digest: digest(token), kind, conversations, accountId }); this.store.commit();
    return { token, credentialId, accountId, protocolVersion: 1 };
  }
  private conversation(conversationId: unknown): SignalConversation {
    const conversation = this.store.state.conversations.find(c => c.id === id(conversationId));
    if (!conversation) throw new ApiError(404, 'conversation_missing', 'Conversation is unavailable');
    return conversation;
  }
  private ensureConversation(kind: 'direct' | 'group', target: string, title: string, expirationSeconds = 0): SignalConversation {
    if (!(kind === 'direct' ? RECIPIENT : GROUP).test(target) || !Number.isSafeInteger(expirationSeconds) || expirationSeconds < 0 || expirationSeconds > 365 * 86400) throw new ApiError(502, 'invalid_recipient', 'Signal returned invalid recipient metadata');
    const conversationId = opaque(`${this.account()}:${kind}:${target}`);
    let conversation = this.store.state.conversations.find(c => c.id === conversationId);
    if (!conversation) {
      if (this.store.state.conversations.length >= 2000) throw new ApiError(409, 'conversation_limit', 'Conversation limit reached');
      conversation = { id: conversationId, title: title.slice(0, 160) || 'Signal', kind, target, disappearing: expirationSeconds > 0, expirationSeconds };
      this.store.state.conversations.push(conversation); this.store.event({ type: 'conversation', conversationId });
    } else {
      const old = JSON.stringify(conversation);
      conversation.title = conversation.self ? 'Note to Self' : title.slice(0, 160) || conversation.title;
      if (expirationSeconds > 0) { conversation.disappearing = true; conversation.expirationSeconds = expirationSeconds; }
      if (JSON.stringify(conversation) !== old) this.store.event({ type: 'conversation', conversationId });
    }
    return conversation;
  }
  private visible(credential: SignalCredential, conversationId: string): boolean { return credential.kind === 'app' || credential.conversations.includes(conversationId); }
  /** Activity follows retained content, not contact sync, drafts or the permanent send ledger. */
  private conversationViews(conversations: SignalConversation[]) {
    const latest = new Map<string, number>(), now = this.now();
    for (const message of this.store.state.messages) {
      if (message.expiresAt <= now || !Number.isSafeInteger(message.timestamp) || message.timestamp <= 0 || message.timestamp > now + 300_000) continue;
      latest.set(message.conversationId, Math.max(latest.get(message.conversationId) ?? 0, message.timestamp));
    }
    return conversations.map(c => publicConversation(c, latest.get(c.id))).sort((a, b) =>
      (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.id.localeCompare(b.id));
  }
  private conversationView(conversation: SignalConversation) { return this.conversationViews([conversation])[0]!; }
  async rpc(credential: SignalCredential, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.current(credential); this.store.prune(this.now());
    switch (method) {
      case 'status': return this.status();
      case 'snapshot': {
        const currentPage = page(params, this.store.state.sequence), start = currentPage * 64, end = start + 64;
        const conversations = this.conversationViews(this.store.state.conversations.filter(c => this.visible(credential, c.id)));
        const messages = this.store.state.messages.filter(m => this.visible(credential, m.conversationId));
        const drafts = this.store.state.drafts.filter(d => d.owner === credential.id && this.visible(credential, d.conversationId));
        const operations = this.store.state.operations.filter(o => o.owner === credential.id && this.visible(credential, o.conversationId));
        return { accountId: this.account(), cursor: String(this.store.state.sequence), preview: this.store.state.preview, retentionDays: this.store.state.retentionDays,
          conversations: conversations.slice(start, end), messages: messages.slice(start, end).map(publicMessage),
          drafts: drafts.slice(start, end).map(({ owner: _owner, ...d }) => d), operations: operations.slice(start, end).map(publicOperation),
          nextPage: Math.max(conversations.length, messages.length, drafts.length, operations.length) > end ? currentPage + 1 : null };
      }
      case 'conversations': return { conversations: this.conversationViews(this.store.state.conversations.filter(c => this.visible(credential, c.id))) };
      case 'history': {
        const conversation = this.conversation(params.conversationId); this.current(credential, conversation.id);
        const currentPage = page(params, this.store.state.sequence), start = currentPage * 64;
        const messages = this.store.state.messages.filter(m => m.conversationId === conversation.id);
        return { messages: messages.slice(start, start + 64).map(publicMessage), cursor: String(this.store.state.sequence), nextPage: messages.length > start + 64 ? currentPage + 1 : null };
      }
      case 'events': {
        if (typeof params.cursor !== 'string' || !/^\d{1,16}$/.test(params.cursor)) throw new ApiError(400, 'invalid_cursor', 'Invalid event cursor');
        const cursor = Number(params.cursor), state = this.store.state;
        const reset = cursor > state.sequence || cursor < (state.events[0]?.sequence ?? state.sequence + 1) - 1;
        const events: unknown[] = [];
        const source = reset ? [] : state.events.filter(e => e.sequence > cursor).slice(0, 64);
        if (!reset) for (const event of source) {
          if (event.type === 'remove') { events.push(event); continue; } // Opaque tombstones contain no conversation content.
          if (event.type === 'message') {
            const message = state.messages.find(m => m.id === event.messageId);
            if (message && this.visible(credential, message.conversationId)) events.push({ sequence: event.sequence, type: event.type, message: publicMessage(message) });
          } else if (event.type === 'operation') {
            const operation = state.operations.find(o => o.operationId === event.operationId && o.owner === credential.id);
            if (operation && this.visible(credential, operation.conversationId)) events.push({ sequence: event.sequence, type: event.type, operation: publicOperation(operation) });
          } else {
            const conversation = state.conversations.find(c => c.id === event.conversationId);
            if (conversation && this.visible(credential, conversation.id)) events.push({ sequence: event.sequence, type: event.type, conversation: this.conversationView(conversation) });
          }
        }
        return { cursor: String(reset ? state.sequence : source.at(-1)?.sequence ?? state.sequence), reset, events, preview: state.preview, retentionDays: state.retentionDays };
      }
      case 'recipients': {
        if (credential.kind !== 'app') throw new ApiError(403, 'app_only', 'App capability required');
        await this.refreshRecipients(); this.current(credential);
        return { recipients: this.conversationViews(this.store.state.conversations) };
      }
      case 'conversation.open': {
        const conversation = this.conversation(params.recipientId); this.current(credential, conversation.id);
        return { conversation: this.conversationView(conversation) };
      }
      case 'draft.set': {
        const conversation = this.conversation(params.conversationId); this.current(credential, conversation.id);
        const text = params.text === '' ? '' : parseText(params, 8000);
        const remaining = this.store.state.drafts.filter(d => d.owner !== credential.id || d.conversationId !== conversation.id);
        if (text && remaining.length >= 128) throw new ApiError(409, 'draft_limit', 'Remove an old draft first');
        const expiresAt = Math.min(this.now() + Math.min(this.store.state.retentionDays * DAY, conversation.expirationSeconds > 0 ? conversation.expirationSeconds * 1000 : Infinity),
          ...this.store.state.messages.filter(m => m.conversationId === conversation.id).map(m => m.expiresAt));
        const draft = { conversationId: conversation.id, text, expiresAt, owner: credential.id, version: randomUUID() };
        this.store.state.drafts = text ? [...remaining, draft] : remaining; this.store.state.sequence++; this.store.commit();
        return { draft: { conversationId: draft.conversationId, text, expiresAt, version: draft.version } };
      }
      case 'send': {
        if (credential.kind !== 'app') throw new ApiError(403, 'confirmation_required', 'Assistant drafts must be reviewed and sent in the bridge dashboard');
        return { operation: await this.send(credential, params) };
      }
      case 'operation.get': {
        const operation = this.store.state.operations.find(o => o.operationId === id(params.operationId) && o.owner === credential.id);
        if (!operation) throw new ApiError(404, 'operation_missing', 'Send operation not found');
        this.current(credential, operation.conversationId); return { operation: publicOperation(operation) };
      }
      default: throw new ApiError(404, 'method_not_found', 'Signal method not found');
    }
  }
  private async send(credential: SignalCredential, params: Record<string, unknown>) {
    const account = this.account(), conversation = this.conversation(params.conversationId);
    this.current(credential, conversation.id);
    if (params.accountId !== account) throw new ApiError(409, 'account_changed', 'Signal account changed');
    const text = parseText(params, 8000), operationId = id(params.operationId);
    const fingerprint = this.store.fingerprint(JSON.stringify([account, conversation.id, text]));
    const existing = this.store.state.operations.find(o => o.operationId === operationId);
    if (existing) {
      if (existing.owner !== credential.id || existing.fingerprint !== fingerprint) throw new ApiError(409, 'operation_conflict', 'Operation ID is already in use');
      return publicOperation(existing);
    }
    if (!this.transport.ready || this.failure) throw new ApiError(503, 'signal_offline', 'Save a draft and explicitly send after reconnecting');
    // Fresh CLI-local timer and membership, followed by a new grant check. Never
    // use stale recipient state to assign a longer retention period to a send.
    const metadata = await this.transport.request(conversation.kind === 'group' ? 'listGroups' : 'listContacts', { account,
      ...(conversation.kind === 'group' ? { groupId: [conversation.target] } : {
        recipient: [conversation.self ? account : conversation.target], ...(conversation.self ? { allRecipients: true } : {}) }) });
    this.current(credential, conversation.id);
    if (credential.kind === 'assistant' && (Number(params.expiresAt) <= this.now() || !Number.isSafeInteger(params.expiresAt) ||
      !this.store.state.drafts.some(d => d.owner === credential.id && d.conversationId === conversation.id &&
        d.version === params.draftVersion && d.text === text && d.expiresAt > this.now()))) throw new ApiError(409, 'draft_changed', 'Draft changed or review expired while preparing the send; review again');
    const target = Array.isArray(metadata) ? metadata.map(record).find(c => conversation.kind === 'group' ?
      c.id === conversation.target && c.isMember === true && c.isBlocked !== true && c.isTerminated !== true :
      (c.uuid === conversation.target || c.number === conversation.target) && c.isBlocked !== true &&
        (!conversation.self || c.number === account)) : undefined;
    const timer = target?.messageExpirationTime;
    if (!Number.isSafeInteger(timer) || Number(timer) < 0 || Number(timer) > 365 * 86400) throw new ApiError(409, 'timer_unknown', 'Recipient timer or membership is unavailable; refresh Signal contacts');
    conversation.disappearing = Number(timer) > 0;
    conversation.expirationSeconds = Number(timer);
    // Another request may have persisted this operation while metadata loaded.
    const concurrent = this.store.state.operations.find(o => o.operationId === operationId);
    if (concurrent) {
      if (concurrent.owner !== credential.id || concurrent.fingerprint !== fingerprint) throw new ApiError(409, 'operation_conflict', 'Operation ID is already in use');
      return publicOperation(concurrent);
    }
    if (!this.transport.ready || this.failure) throw new ApiError(503, 'signal_offline', 'Save a draft and explicitly send after reconnecting');
    if (this.store.state.operations.length >= 20_000) throw new ApiError(409, 'operation_limit', 'Send ledger is full; export metadata and reset offline before more sends');
    const operation: SignalOperation = { operationId, conversationId: conversation.id, fingerprint, owner: credential.id, status: 'pending', createdAt: this.now() };
    const expiresAt = operation.createdAt + Math.min(this.store.state.retentionDays * DAY, Number(timer) > 0 ? Number(timer) * 1000 : Infinity);
    this.store.state.operations.push(operation); this.store.event({ type: 'operation', operationId }); this.store.commit();
    // No await between checking current grant and dispatch. Revocation cannot interleave.
    try {
      this.current(credential, conversation.id);
      const result = await this.transport.request('send', { account, message: text,
        ...(conversation.kind === 'group' ? { groupId: conversation.target } : conversation.self ? { noteToSelf: true } : { recipient: [conversation.target] }) }, 30_000,
      late => this.reconcileResult(operation, account, late, text, expiresAt));
      operation.status = 'sent'; operation.timestamp = sentTimestamp(result, this.now());
      this.store.state.drafts = this.store.state.drafts.filter(d => d.owner !== credential.id || d.conversationId !== conversation.id);
      this.addMessage(conversation, account, 'You', text, operation.timestamp, expiresAt, true);
    } catch { operation.status = 'unknown'; }
    this.store.event({ type: 'operation', operationId }); this.store.commit();
    // A response after revocation must not return content or re-authorize anything.
    this.current(credential, conversation.id);
    return publicOperation(operation);
  }
  private reconcileResult(operation: SignalOperation, account: string, result: unknown, text: string, expiresAt: number): void {
    try {
      if (this.store.state.accountId !== account) return;
      if (!this.store.state.operations.includes(operation) || operation.status !== 'unknown') return;
      const timestamp = sentTimestamp(result, this.now()), conversation = this.store.state.conversations.find(c => c.id === operation.conversationId);
      if (!conversation) return;
      // Exact late confirmation can restore the originally dispatched content only
      // within its original deadline and any subsequently shortened retention.
      this.addMessage(conversation, account, 'You', text, timestamp,
        Math.min(expiresAt, operation.createdAt + this.store.state.retentionDays * DAY), true);
      operation.timestamp = timestamp; operation.status = 'sent';
      this.store.state.drafts = this.store.state.drafts.filter(d => d.owner !== operation.owner || d.conversationId !== operation.conversationId);
      this.store.event({ type: 'operation', operationId: operation.operationId }); this.store.commit();
    } catch { /* Keep unknown unless the exact late RPC result proves success. */ }
  }
  async refreshRecipients(): Promise<void> {
    const account = this.account(), generation = this.generation;
    const [contacts, groups, ownRecipients] = await Promise.all([this.transport.request('listContacts', { account }),
      this.transport.request('listGroups', { account }), this.transport.request('listContacts', { account, recipient: [account], allRecipients: true })]);
    if (this.account() !== account || this.generation !== generation) return;
    for (const entry of Array.isArray(contacts) ? contacts.slice(0, 2000) : []) {
      const contact = record(entry), target = str(contact.uuid) || str(contact.number);
      if (!target || contact.isBlocked === true) continue;
      this.ensureConversation('direct', target, str(contact.name) || str(record(contact.profile).givenName) || str(contact.number) || 'Signal contact', Math.max(0, Number(contact.messageExpirationTime) || 0));
    }
    for (const entry of Array.isArray(groups) ? groups.slice(0, 2000) : []) {
      const group = record(entry), target = str(group.id);
      if (!target || group.isMember !== true || group.isBlocked === true) continue;
      this.ensureConversation('group', target, str(group.name) || 'Signal group', Math.max(0, Number(group.messageExpirationTime) || 0));
    }
    // signal-cli 0.14.7 excludes self from its default contact list. An explicit
    // allRecipients lookup exposes the same contact timer used by sendSelfMessage.
    // Bind by the linked account number, retain its normal opaque direct-chat ID,
    // and never invent a disabled timer when metadata is missing.
    const own = Array.isArray(ownRecipients) ? ownRecipients.map(record).filter(c => c.number === account && c.isBlocked !== true) : [];
    if (own.length === 1) {
      const contact = own[0]!, timer = contact.messageExpirationTime, target = str(contact.uuid) || str(contact.number);
      if (RECIPIENT.test(target) && Number.isSafeInteger(timer) && Number(timer) >= 0 && Number(timer) <= 365 * 86400) {
        const conversation = this.ensureConversation('direct', target, 'Note to Self', Number(timer));
        const previous = JSON.stringify(publicConversation(conversation));
        conversation.self = true; conversation.title = 'Note to Self';
        conversation.disappearing = Number(timer) > 0; conversation.expirationSeconds = Number(timer);
        if (JSON.stringify(publicConversation(conversation)) !== previous) this.store.event({ type: 'conversation', conversationId: conversation.id });
      }
    }
    this.store.commit();
  }
  private addMessage(conversation: SignalConversation, author: string, sender: string, text: string, timestamp: number, expiresAt: number, outgoing: boolean): void {
    const msgId = messageId(this.account(), conversation.id, author, timestamp), state = this.store.state;
    if (state.tombstones.some(t => t.id === msgId)) return;
    const existing = state.messages.find(m => m.id === msgId);
    if (existing) { existing.expiresAt = Math.min(existing.expiresAt, expiresAt); return; }
    if (expiresAt <= this.now() || timestamp < this.now() - state.retentionDays * DAY) return;
    let contentBytes = state.messages.reduce((n, m) => n + Buffer.byteLength(m.text), 0) + Buffer.byteLength(text.slice(0, 8000));
    while (state.messages.length >= 5000 || contentBytes > 8 * 1024 * 1024) {
      const first = state.messages[0];
      if (first) { contentBytes -= Buffer.byteLength(first.text); this.store.remove(first.id, this.now()); } else break;
    }
    state.messages.push({ id: msgId, conversationId: conversation.id, author, sender: sender.slice(0, 160), text: text.slice(0, 8000), timestamp, expiresAt, outgoing });
    this.store.event({ type: 'message', messageId: msgId });
    this.store.event({ type: 'conversation', conversationId: conversation.id });
  }
  ingest(value: unknown): void {
    const root = record(value), payload = record(root.result ?? root), envelope = record(payload.envelope);
    if (!this.store.state.accountId || str(payload.account) !== this.store.state.accountId) return;
    const sync = record(envelope.syncMessage), outgoing = Object.keys(record(sync.sentMessage)).length > 0;
    const data = record(outgoing ? sync.sentMessage : envelope.dataMessage);
    const author = outgoing ? this.account() : str(envelope.sourceUuid) || str(envelope.sourceNumber) || str(envelope.source);
    const timestamp = Number(data.timestamp), group = record(data.groupInfo);
    const target = str(group.groupId) || (outgoing ? str(data.destinationUuid) || str(data.destinationNumber) || str(data.destination) : author);
    if (!RECIPIENT.test(author) || !(str(group.groupId) ? GROUP : RECIPIENT).test(target) || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > this.now() + 300_000) return;
    const expiresSeconds = Number(data.expiresInSeconds);
    // Unknown timer fields fail closed; never assign the 30-day TTL to timed data.
    if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 0 || expiresSeconds > 365 * 86400 || data.viewOnce === true) return;
    const kind = str(group.groupId) ? 'group' : 'direct';
    const known = this.store.state.conversations.find(c => c.kind === kind && c.target === target);
    const conversation = this.ensureConversation(kind, target,
      kind === 'group' ? str(group.groupName) || known?.title || 'Signal group' :
        (outgoing ? '' : str(envelope.sourceName)) || known?.title || target, expiresSeconds);
    const deleted = Number(record(data.remoteDelete).timestamp);
    if (Number.isSafeInteger(deleted) && deleted > 0) this.store.remove(messageId(this.account(), conversation.id, author, deleted), this.now());
    if (data.isExpirationUpdate === true) { conversation.disappearing = expiresSeconds > 0; conversation.expirationSeconds = expiresSeconds; }
    // JSON omits expirationStartTimestamp. Sent-time TTL is intentionally earlier
    // than read-start; never extends lifetime for delayed/offline/linked deliveries.
    const expiresAt = Math.min(timestamp + this.store.state.retentionDays * DAY, expiresSeconds > 0 ? Math.min(timestamp, this.now()) + expiresSeconds * 1000 : Infinity);
    if (typeof data.message === 'string' && data.message.length > 0) this.addMessage(conversation, author,
      outgoing ? 'You' : str(envelope.sourceName) || author, data.message, timestamp, expiresAt, outgoing);
    this.store.prune(this.now()); this.store.commit();
  }
  adminSnapshot() {
    this.store.prune(this.now());
    return { ...this.status(), conversations: this.conversationViews(this.store.state.conversations),
      credentials: this.store.state.credentials.map(({ digest: _digest, ...c }) => c),
      drafts: this.store.state.drafts.filter(d => this.store.state.credentials.some(c => c.id === d.owner && c.kind === 'assistant')),
      link: this.link && { status: this.link.status, expiresAt: this.link.expiresAt, ...(this.link.status === 'waiting' && this.link.expiresAt > this.now() ? { uri: this.link.uri } : {}) } };
  }
  async admin(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'status': return this.adminSnapshot();
      case 'pairing.create': return this.createPairing();
      case 'recipients.refresh': await this.refreshRecipients(); return this.adminSnapshot();
      case 'settings': {
        if (!Number.isInteger(params.retentionDays) || Number(params.retentionDays) < 1 || Number(params.retentionDays) > 365 || !['message', 'sender'].includes(str(params.preview))) throw new ApiError(400, 'invalid_settings', 'Retention must be 1–365 days and preview message or sender');
        this.store.state.retentionDays = Number(params.retentionDays); this.store.state.preview = params.preview as 'message' | 'sender';
        for (const m of this.store.state.messages) m.expiresAt = Math.min(m.expiresAt, m.timestamp + this.store.state.retentionDays * DAY);
        for (const d of this.store.state.drafts) d.expiresAt = Math.min(d.expiresAt, this.now() + this.store.state.retentionDays * DAY);
        this.store.prune(this.now()); this.store.state.sequence++; this.store.state.events = []; this.store.commit(); return this.status();
      }
      case 'assistant.grant': {
        if (!Array.isArray(params.conversations) || params.conversations.length === 0 || params.conversations.length > 100) throw new ApiError(400, 'invalid_grant', 'Select 1–100 conversations');
        const conversations = [...new Set(params.conversations.map(c => this.conversation(c).id))];
        return this.issue('assistant', conversations);
      }
      case 'credential.revoke': {
        const credentialId = id(params.credentialId);
        this.store.state.credentials = this.store.state.credentials.filter(c => c.id !== credentialId);
        this.store.state.drafts = this.store.state.drafts.filter(d => d.owner !== credentialId); this.store.commit(); return { revoked: true };
      }
      case 'assistant.send': {
        const credential = this.store.state.credentials.find(c => c.id === params.credentialId && c.kind === 'assistant');
        const draft = this.store.state.drafts.find(d => d.owner === credential?.id && d.conversationId === params.conversationId && d.expiresAt > this.now());
        if (!credential || !draft || params.text !== draft.text || params.draftVersion !== draft.version || params.accountId !== this.account()) throw new ApiError(409, 'draft_changed', 'Draft or access changed; review again');
        return { operation: await this.send(credential, params) };
      }
      case 'link.start': {
        if (this.store.state.accountId || (this.link?.status === 'waiting' && this.link.expiresAt > this.now())) throw new ApiError(409, 'already_linked', 'An account or linking flow already exists');
        const accounts = await this.transport.request('listAccounts');
        if (Array.isArray(accounts) && accounts.length) throw new ApiError(409, 'existing_account', 'Existing Signal CLI account requires explicit adoption');
        const result = record(await this.transport.request('startLink')), uri = str(result.deviceLinkUri);
        if (!uri.startsWith('sgnl://linkdevice?') || uri.length > 4096) throw new ApiError(502, 'invalid_link', 'Signal returned an invalid linking URI');
        const link = { uri, expiresAt: this.now() + 120_000, status: 'waiting' as const }; this.link = link;
        void this.transport.request('finishLink', { deviceLinkUri: uri, deviceName: 'Faceclaw Bridge' }, 120_000).then(async () => {
          await this.adoptAccount(); if (this.link === link) this.link.status = 'linked';
        }).catch(() => { if (this.link === link) this.link.status = 'failed'; });
        return { uri, expiresAt: link.expiresAt };
      }
      case 'account.adopt': {
        if (params.confirm !== 'ADOPT LINKED ACCOUNT') throw new ApiError(400, 'confirmation_required', 'Explicit adoption confirmation required');
        await this.adoptAccount(); return this.status();
      }
      case 'account.reset': {
        if (params.confirm !== 'DELETE LOCAL SIGNAL DATA' || params.accountId !== this.account()) throw new ApiError(400, 'confirmation_required', 'Confirm deletion of this account locally');
        if (!this.transport.resetData) throw new ApiError(503, 'reset_unavailable', 'Local reset is unavailable');
        const sequence = this.store.state.sequence + 1, retentionDays = this.store.state.retentionDays, preview = this.store.state.preview;
        this.generation++; this.store.state = { ...newSignalState(), sequence, retentionDays, preview }; this.codes.clear(); this.link = null; this.store.commit();
        // Revoke first. If deletion fails, old credentials remain invalid.
        await this.transport.resetData();
        this.transport.start(value => { try { this.ingest(value); } catch { this.failure = 'receive-storage-failed'; this.transport.stop(); } });
        return { reset: true, removeLinkedDeviceOnPhone: true };
      }
      default: throw new ApiError(404, 'method_not_found', 'Signal setup method not found');
    }
  }
  private async adoptAccount(): Promise<void> {
    const generation = this.generation;
    if (this.store.state.accountId) throw new ApiError(409, 'already_linked', 'Account is already linked');
    const accounts = await this.transport.request('listAccounts');
    if (this.generation !== generation || this.store.state.accountId) throw new ApiError(409, 'account_changed', 'Account setup changed');
    if (!Array.isArray(accounts) || accounts.length !== 1) throw new ApiError(409, 'account_count', 'Exactly one linked Signal account is required');
    const account = str(record(accounts[0]).number);
    if (!/^\+[1-9][0-9]{5,15}$/.test(account)) throw new ApiError(502, 'invalid_account', 'Invalid Signal account');
    this.store.state.accountId = account; this.store.commit(); await this.transport.request('sendSyncRequest', { account });
  }
}
