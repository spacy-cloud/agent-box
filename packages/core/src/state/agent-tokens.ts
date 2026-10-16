import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RepoContext } from './db.js';
import { sha256Hex } from './canonical.js';
import { num, numOrNull } from './json.js';
import type { Row } from './json.js';

export const TOKEN_PREFIX = 'abox_';
/** `last_used_at` is refreshed at most this often, so `verify()` stays read-mostly. */
const LAST_USED_GRANULARITY_MS = 60_000;

/** Token metadata. The plaintext token is never stored; only its sha256 hash. */
export interface AgentTokenInfo {
  id: string;
  contextId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

function toInfo(r: Row): AgentTokenInfo {
  return {
    id: r['id'] as string,
    contextId: r['context_id'] as string,
    label: r['label'] as string,
    createdAt: num(r['created_at']),
    lastUsedAt: numOrNull(r['last_used_at']),
    revokedAt: numOrNull(r['revoked_at']),
  };
}

/** Bearer tokens for the MCP HTTP transport. */
export class AgentTokens {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  /** Create a token. The plaintext is returned exactly once and cannot be recovered later. */
  create(contextId: string, label: string): AgentTokenInfo & { token: string } {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const id = randomUUID();
    this.ctx.db
      .prepare(
        'INSERT INTO agent_tokens (id, context_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, contextId, label, sha256Hex(token), this.ctx.now());
    return { ...this.getInfo(id)!, token };
  }

  /** Context id for a valid, non-revoked token; compares hashes in constant time. */
  verify(token: string): string | undefined {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 256)
      return undefined;
    const candidate = Buffer.from(sha256Hex(token), 'hex');
    let match: { id: string; contextId: string; lastUsedAt: number | null } | undefined;
    // Compare against every active token without early exit.
    for (const row of this.ctx.db
      .prepare(
        'SELECT id, context_id, token_hash, last_used_at FROM agent_tokens WHERE revoked_at IS NULL',
      )
      .all()) {
      const stored = Buffer.from(row['token_hash'] as string, 'hex');
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        match = {
          id: row['id'] as string,
          contextId: row['context_id'] as string,
          lastUsedAt: numOrNull(row['last_used_at']),
        };
      }
    }
    if (!match) return undefined;
    const now = this.ctx.now();
    if (match.lastUsedAt === null || now - match.lastUsedAt >= LAST_USED_GRANULARITY_MS) {
      try {
        this.ctx.db
          .prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?')
          .run(now, match.id);
      } catch {
        /* bookkeeping only; a busy database must not fail authentication */
      }
    }
    return match.contextId;
  }

  getInfo(id: string): AgentTokenInfo | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(id);
    return row ? toInfo(row) : undefined;
  }

  /** Returns true when an active token was revoked. */
  revoke(id: string): boolean {
    const res = this.ctx.db
      .prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.ctx.now(), id);
    return num(res.changes) > 0;
  }

  /** All tokens (including revoked), without hashes or plaintext. */
  list(): AgentTokenInfo[] {
    return this.ctx.db
      .prepare('SELECT * FROM agent_tokens ORDER BY created_at, id')
      .all()
      .map(toInfo);
  }
}
