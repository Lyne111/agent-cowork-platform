export type Provider = 'codex' | 'antigravity' | 'deepseek-harness';
export type ProfileRole = 'implementer' | 'reviewer' | 'acceptance';
export type TaskStatus = 'pending' | 'running' | 'blocked' | 'awaiting_acceptance' | 'completed' | 'cancelled';
export type RunStatus = 'queued' | 'sending' | 'accepted' | 'running' | 'waiting_user' | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'unverified';
export type RunRole = 'implement' | 'review';
export type Source = 'user' | 'agent' | 'tool' | 'system';
export interface Project { id: string; name: string; path: string; baseCommit: string; createdAt: string }
export interface RoleProfile { id: string; version: number; name: string; role: ProfileRole; provider: Provider; model: string | null; instructions: string; enabled: boolean; createdAt: string; updatedAt: string }
export interface RuleRevision { id: string; revisionId: string; version: number; scope: 'global' | 'project' | 'role'; projectId: string | null; profileId: string | null; kind: 'rule' | 'preference' | 'fact' | 'experience'; content: string; source: string; confirmed: boolean; createdAt: string }
export interface Task { id: string; projectId: string; title: string; goal: string; criteria: string; ownerId: string; reviewerIds: string[]; ownerGeneration: number; version: number; flow: number; status: TaskStatus; frozen: boolean; freezeReason: 'recovery' | 'stop' | 'error' | null; cancelRequested: boolean; artifactId: string | null; createdAt: string; updatedAt: string }
export interface ContextSnapshot { goal: string; criteria: string; project: Project; profile: RoleProfile; rules: RuleRevision[]; artifactId: string | null; decisions: string[]; hash: string }
export interface Usage { inputTokens?: number; outputTokens?: number; source: string; complete: boolean }
export interface Run { id: string; taskId: string; projectId: string; profileId: string; profileVersion: number; provider: Provider; model: string | null; role: RunRole; flow: number; ownerGeneration: number; status: RunStatus; workspacePath: string; artifactId: string | null; context: ContextSnapshot; nativeSessionId: string | null; nativeTurnId: string | null; evidence: string | null; error: string | null; usage: Usage | null; createdAt: string; updatedAt: string }
export interface Command { id: string; kind: string; payloadHash: string; taskId: string | null; runId: string | null; status: 'pending' | 'sending' | 'accepted' | 'finished' | 'unverified' | 'cancelled'; result: unknown; createdAt: string }
export interface Event { id: string; seq: number; projectId: string; taskId: string; runId: string | null; source: Source; type: string; payloadHash?: string; text: string; nativeId: string | null; createdAt: string }
export interface ArtifactFile { path: string; sha256: string; size: number }
export interface Artifact { id: string; taskId: string; projectId: string; runId: string; version: number; baseCommit: string; path: string; hash: string; files: ArtifactFile[]; summary: string; diff: string; createdAt: string }
export interface Review { id: string; taskId: string; runId: string | null; skipped?: boolean; artifactId: string; profileId: string; verdict: 'pass' | 'changes_requested'; text: string; createdAt: string }
export interface Approval { id: string; runId: string; taskId: string; projectId: string; nativeId: string; kind: string; prompt: string; options: string[]; status: 'pending' | 'answered' | 'expired'; answer: string | null; createdAt: string }
export interface Question { id: string; runId: string; taskId: string; projectId: string; nativeId: string; prompt: string; status: 'pending' | 'answered' | 'expired'; answer: string | null; createdAt: string }
export interface Acceptance { id: string; taskId: string; artifactId: string; decision: 'accepted'; comment: string; createdAt: string }
export interface Snapshot { projects: Project[]; profiles: RoleProfile[]; rules: RuleRevision[]; tasks: Task[]; runs: Run[]; commands: Command[]; events: Event[]; artifacts: Artifact[]; reviews: Review[]; approvals: Approval[]; questions: Question[]; acceptances: Acceptance[]; paused: boolean }
export interface RunEventInput { id: string; runId: string; type: string; source: Source; text: string; status?: RunStatus; nativeId?: string; nativeSessionId?: string; nativeTurnId?: string; evidence?: string; usage?: Usage }
