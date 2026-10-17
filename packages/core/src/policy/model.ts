import type {
  AccessMode,
  IsolationLevel,
  NetworkMode,
  SecretInjection,
  WorkspaceMode,
} from '../types.js';

export const APPROVAL_MODES = ['strict', 'medium', 'open'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * A profile after `extends` resolution and defaulting. Same shape as the
 * policy.yaml profile, but every field is present. Safe defaults for fields
 * that are missing from the whole chain: no templates, no secrets, no mounts,
 * network `none`, workspace `empty` only, host `local`, isolation `container`.
 */
export interface ResolvedProfile {
  name: string;
  approval: ApprovalMode;
  /** Template names, or `['*']` for any. */
  templates: string[];
  limits: {
    sandboxes: number;
    cpus: number;
    /** As written, e.g. `8g`. */
    memory: string;
    /** As written, e.g. `4h`. */
    ttl: string;
    memoryBytes: number;
    ttlMs: number;
  };
  workspace: {
    /** As written (`~` unexpanded); see `AgentContext.workspaceRoots` for canonical roots. */
    roots: string[];
    modes: WorkspaceMode[];
  };
  network: {
    modes: NetworkMode[];
    allow_presets: string[];
    /** Extra allowed destinations; the single entry `*` means "any destination". */
    allow: string[];
  };
  images: {
    /**
     * Registries (and path prefixes) free image names of template bases may come from, e.g.
     * `docker.io/library` or `ghcr.io/my-org`; `['*']` = any. Base images of the built-in
     * templates are always accepted.
     */
    registries: string[];
  };
  /** `null` = additional mounts denied. */
  mounts: null | { roots: string[]; access: AccessMode[] };
  secrets: {
    /** Secret refs, or `['*']` for any. */
    allowed: string[];
    inject: SecretInjection[];
  };
  isolation: {
    /** Minimum isolation for every sandbox of this profile. */
    min: IsolationLevel;
    /** Minimum isolation when network mode is `open`. */
    network_open: IsolationLevel;
    /** Minimum isolation when additional mounts are present. */
    mounts: IsolationLevel;
    /** Minimum isolation when a secret is injected as env or file. */
    secrets_env: IsolationLevel;
  };
  /** Host ids, or `['*']` for any. */
  hosts: string[];
  exec: { approval: boolean };
}

export interface ContextDef {
  profile: string;
  /** Overrides the profile's `hosts` for this context when present. */
  hosts?: string[];
}

export type PolicySource = { kind: 'default' } | { kind: 'file'; path: string };

export interface Policy {
  profiles: Readonly<Record<string, ResolvedProfile>>;
  /** Always contains `human`. */
  contexts: Readonly<Record<string, ContextDef>>;
  source: PolicySource;
  /** sha256 hex of the policy text (the built-in text for the default policy); audit revision. */
  contentHash: string;
}

export type ContextKind = 'human' | 'agent';

/** Who is asking, with fully merged rights. */
export interface AgentContext {
  id: string;
  kind: ContextKind;
  profileName: string;
  profile: ResolvedProfile;
  /** `human` or `agent:<id>`. */
  owner: string;
  allowedHosts: string[];
  /** Canonical (symlink-free, absolute) workspace roots. */
  workspaceRoots: string[];
  /** Canonical mount roots (empty when mounts are denied). */
  mountRoots: string[];
}
