import type { DatabaseSync } from 'node:sqlite';
import { AgentTokens } from './agent-tokens.js';
import { ApprovalQueue } from './approval-queue.js';
import { AuditLog } from './audit-log.js';
import type { AuditLogOptions } from './audit-log.js';
import { openDatabase } from './db.js';
import type { Clock, OpenDatabaseOptions } from './db.js';
import { HostCache } from './host-cache.js';
import { PolicyRevisions } from './policy-revisions.js';
import { ProcessRegistry } from './process-registry.js';
import { SandboxRegistry } from './sandbox-registry.js';
import { Snapshots } from './snapshots.js';
import { TemplatePins } from './template-pins.js';
import { TemplateTrust } from './template-trust.js';

export interface StateStoreOptions extends OpenDatabaseOptions {
  /** Clock override (tests); defaults to `Date.now`. */
  now?: Clock;
  audit?: AuditLogOptions;
}

/**
 * Facade over all repositories sharing one connection. Each process (CLI, MCP server,
 * GUI) opens its own `StateStore` on the same file; SQLite WAL handles the concurrency.
 */
export class StateStore {
  readonly db: DatabaseSync;
  readonly sandboxes: SandboxRegistry;
  readonly approvals: ApprovalQueue;
  readonly audit: AuditLog;
  readonly templateTrust: TemplateTrust;
  readonly templatePins: TemplatePins;
  readonly policyRevisions: PolicyRevisions;
  readonly processes: ProcessRegistry;
  readonly hosts: HostCache;
  readonly agentTokens: AgentTokens;
  readonly snapshots: Snapshots;
  private closed = false;

  private constructor(db: DatabaseSync, opts: StateStoreOptions) {
    const ctx = { db, now: opts.now ?? Date.now };
    this.db = db;
    this.sandboxes = new SandboxRegistry(ctx);
    this.approvals = new ApprovalQueue(ctx);
    this.audit = new AuditLog(ctx, opts.audit);
    this.templateTrust = new TemplateTrust(ctx);
    this.templatePins = new TemplatePins(ctx);
    this.policyRevisions = new PolicyRevisions(ctx);
    this.processes = new ProcessRegistry(ctx);
    this.hosts = new HostCache(ctx);
    this.agentTokens = new AgentTokens(ctx);
    this.snapshots = new Snapshots(ctx);
  }

  /** Open (creating and migrating if needed) the database at `path`; `:memory:` is allowed. */
  static open(path: string, opts: StateStoreOptions = {}): StateStore {
    return new StateStore(openDatabase(path, opts), opts);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
