import { randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { findProject } from './normalize.js';
import { ApiError, secretMatches } from './security.js';
import { launcherToken, mintToolToken, type ToolBinding } from './faceclaw.js';
import type { BridgeConfig, T3Client } from './types.js';

/** A launcher capability authorizes only this project's device tools. It does
 * not grant T3 API access or mint phone credentials. The local account owning
 * the private launcher config is trusted; cwd alone is not authentication. */
export class FaceclawProviderGrants {
  private grants = new Map<string, { binding: ToolBinding; leaseUntil: number; leaseToken: string }>();
  constructor(private readonly config: BridgeConfig, private readonly client: T3Client, private readonly signingSecret: string) {}
  async issue(token: string | undefined, params: Record<string, unknown>): Promise<ToolBinding & { token: string; leaseToken: string }> {
    const projectId = this.config.faceclawProjectId;
    if (!projectId || !secretMatches(token, launcherToken(this.config.bridgeToken, projectId))) throw new ApiError(401, 'unauthorized', 'Project launcher credential required');
    const cwd = params.cwd;
    if (typeof cwd !== 'string' || cwd.length > 4096 || !isAbsolute(cwd) || Object.keys(params).length !== 1) throw new ApiError(400, 'invalid_request', 'A project working directory is required');
    const project = findProject(await this.client.shell(), projectId, this.config);
    if (!project.workspaceRoot || await realpath(cwd).catch(() => '') !== await realpath(project.workspaceRoot).catch(() => null)) {
      throw new ApiError(403, 'tool_scope_denied', 'Provider is outside the configured assistant project');
    }
    const now = Date.now();
    for (const [id, grant] of this.grants) if (grant.leaseUntil <= now || grant.binding.expiresAt <= now) this.grants.delete(id);
    if (this.grants.size >= 16) throw new ApiError(429, 'provider_limit', 'Too many active assistant providers');
    const providerSessionId = randomUUID();
    const binding: ToolBinding = { projectId, providerSessionId, bindingKind: 'provider-session', expiresAt: now + 24 * 60 * 60_000 };
    const leaseToken = randomBytes(32).toString('base64url');
    this.grants.set(providerSessionId, { binding, leaseUntil: now + 90_000, leaseToken });
    return { ...binding, token: mintToolToken(this.signingSecret, binding), leaseToken };
  }
  validate(binding: ToolBinding): void {
    const grant = binding.providerSessionId ? this.grants.get(binding.providerSessionId) : undefined;
    if (!grant || grant.binding.projectId !== binding.projectId || grant.binding.expiresAt !== binding.expiresAt ||
        grant.leaseUntil <= Date.now() || grant.binding.expiresAt <= Date.now()) throw new ApiError(403, 'provider_expired', 'Provider capability expired; reconnect the assistant');
  }
  renew(binding: ToolBinding, leaseToken: unknown): { renewed: true } {
    this.validate(binding);
    this.authorizeLease(binding, leaseToken);
    this.grants.get(binding.providerSessionId!)!.leaseUntil = Date.now() + 90_000;
    return { renewed: true };
  }
  revoke(binding: ToolBinding, leaseToken: unknown): { revoked: true } {
    this.validate(binding);
    this.authorizeLease(binding, leaseToken);
    this.grants.delete(binding.providerSessionId!);
    return { revoked: true };
  }
  private authorizeLease(binding: ToolBinding, leaseToken: unknown): void {
    if (typeof leaseToken !== 'string' || !secretMatches(leaseToken, this.grants.get(binding.providerSessionId!)!.leaseToken)) {
      throw new ApiError(401, 'unauthorized', 'Provider lease credential required');
    }
  }
}
