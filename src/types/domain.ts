export interface GitProject {
  id: string;
  name: string;
  path: string;
  remote?: SshConnection;
  groupId?: string;
  favorite: boolean;
  lastOpenedAt?: string;
  createdAt: string;
  updatedAt: string;
  status?: GitStatusSummary;
  statusError?: string;
}

export interface SshConnection {
  type: "ssh";
  host: string;
  username?: string;
  port?: number;
  identityFile?: string;
  connectionEnabled?: boolean;
}

export interface RepositoryTarget {
  path: string;
  remote?: SshConnection;
}

export interface RemoteProjectInput {
  host: string;
  username?: string;
  port?: number;
  repositoryPath: string;
  identityFile?: string;
}

export interface RemoteProjectTestResult extends GitOperationResult {
  repositoryRoot?: string;
  projectName?: string;
}

export interface GitStatusSummary {
  currentBranch: string | null;
  headHash?: string;
  unborn?: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  hasConflicts: boolean;
  conflictedCount: number;
  operationState?: GitOperationState;
  mergeSourceBranch?: string;
  mergeTargetBranch?: string;
}

export type GitOperationState = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";
export type GitMergeStrategy = "ff" | "no-ff";
export type GitMergeMode = "up-to-date" | "fast-forward" | "merge-commit";
export type GitPullStrategy = "ff-only" | "rebase" | "rebase-autostash";

export interface GitPushOptions {
  forceWithLease?: boolean;
}

export interface GitMergePreview {
  sourceBranch: string;
  targetBranch: string;
  targetUpstream?: string;
  targetAhead: number;
  targetBehind: number;
  mode: GitMergeMode;
}

export interface CommitNode {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  body?: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  refs: CommitRef[];
  lane: number;
  color: string;
  files: ChangedFile[];
}

export interface CommitRef {
  type: "head" | "localBranch" | "remoteBranch" | "tag";
  name: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted";
  staged: boolean;
}

export interface DiffLine {
  type: "context" | "add" | "delete";
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface ConflictFileDetails {
  path: string;
  baseContent?: string;
  currentContent?: string;
  incomingContent?: string;
  resultContent?: string;
  baseExists: boolean;
  currentExists: boolean;
  incomingExists: boolean;
  resultExists: boolean;
  currentLabel: string;
  incomingLabel: string;
  editable: boolean;
  isBinary: boolean;
  token: string;
}

export interface ConflictResolutionInput {
  choice: "content" | "current" | "incoming";
  content?: string;
  expectedToken: string;
}

export interface FilePreview {
  type: "image" | "video" | "pdf" | "document" | "spreadsheet" | "presentation";
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
  sourceDescription: string;
}

export interface WorktreeState {
  stagedFiles: ChangedFile[];
  unstagedFiles: ChangedFile[];
}

export interface BranchInfo {
  name: string;
  fullName: string;
  type: "local" | "remote";
  current: boolean;
  upstream?: string;
  upstreamMissing?: boolean;
  headHash: string;
  ahead?: number;
  behind?: number;
  merged?: boolean;
}

export interface ProjectGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export interface ProjectLibraryState {
  groups: ProjectGroup[];
  recentProjectIds: string[];
}

export interface UiPreferences {
  theme: "system" | "light" | "dark";
  language: "zh-CN";
  bottomConsoleVisible: boolean;
  sidebarWidth: number;
  rightPanelWidth: number;
  consoleHeight: number;
  fontSize: number;
  fontFamily: string;
  diffViewMode: "split" | "inline";
  diffWrap: boolean;
  pullStrategy: GitPullStrategy;
  density: "compact" | "comfortable";
  sidebarPosition: "left" | "right";
  confirmDestructiveActions: boolean;
  shortcuts: Record<string, string>;
}

export interface RepositoryCreationResult {
  result: GitOperationResult;
  project?: GitProject;
}

export interface GitStashEntry {
  selector: string;
  hash: string;
  subject: string;
  createdAt: string;
}

export interface GitStashDetails {
  selector: string;
  files: ChangedFile[];
  diff: DiffLine[];
}

export interface GitStashCreateOptions {
  message?: string;
  includeUntracked?: boolean;
  keepIndex?: boolean;
}

export type GitRebaseAction = "pick" | "edit" | "squash" | "fixup" | "drop";

export interface GitRebasePlanItem {
  hash: string;
  shortHash: string;
  subject: string;
  action: GitRebaseAction;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrls: string[];
  pushUrls: string[];
  explicitPushUrls: string[];
  defaultBranch?: string;
  defaultFetch?: boolean;
  defaultPush?: boolean;
}

export interface GitRemoteUpdateInput {
  name?: string;
  fetchUrl?: string;
  pushUrl?: string | null;
}

export interface GitTagInfo {
  name: string;
  hash: string;
  targetHash: string;
  annotated: boolean;
  subject?: string;
  taggerDate?: string;
}

export interface GitReflogEntry {
  selector: string;
  hash: string;
  action: string;
  message: string;
  authorName: string;
  authorDate: string;
}

export interface GitLinkedWorktree {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  lockedReason?: string;
  prunableReason?: string;
}

export interface GitWorktreeAddOptions {
  path: string;
  ref?: string;
  newBranch?: string;
  detach?: boolean;
  force?: boolean;
}

export interface GitWorktreeMoveOptions {
  worktreePath: string;
  destinationPath: string;
}

export type GitSubmoduleState = "initialized" | "uninitialized" | "modified" | "conflicted";

export interface GitSubmoduleInfo {
  path: string;
  url: string;
  branch?: string;
  hash: string;
  state: GitSubmoduleState;
  description?: string;
}

export interface GitSubmoduleUpdateOptions {
  paths?: string[];
  initialize?: boolean;
  recursive?: boolean;
  remote?: boolean;
}

export interface GitSubmoduleAddOptions {
  url: string;
  path: string;
  branch?: string;
  name?: string;
  force?: boolean;
}

export interface GitLfsFileStatus {
  path: string;
  status?: string;
  staged: boolean;
}

export interface GitLfsStatus {
  installed: boolean;
  initialized: boolean;
  version: string;
  files: GitLfsFileStatus[];
}

export interface GitLfsLock {
  id: string;
  path: string;
  owner: string;
  lockedAt?: string;
}

export interface GitLfsMigrateOptions {
  include: string[];
  exclude?: string[];
  everything?: boolean;
  rewriteHistory: true;
}

export interface GitIgnoreDocument {
  exists: boolean;
  content: string;
  revision: string;
}

export type GitSigningFormat = "openpgp" | "ssh" | "x509";

export interface GitSigningConfig {
  commitGpgSign?: boolean;
  tagGpgSign?: boolean;
  signingKey?: string;
  format?: GitSigningFormat;
}

export interface GitSigningConfigUpdate {
  commitGpgSign?: boolean | null;
  tagGpgSign?: boolean | null;
  signingKey?: string | null;
  format?: GitSigningFormat | null;
}

export interface GitIdentityValidationIssue {
  field: "name" | "email";
  messageZh: string;
}

export interface GitIdentityConfig {
  name?: string;
  email?: string;
  localName?: string;
  localEmail?: string;
  valid: boolean;
  issues: GitIdentityValidationIssue[];
}

export interface GitIdentityUpdate {
  name: string;
  email: string;
}

export type GitHostingProvider = "github" | "gitlab" | "gitee";

export interface GitHostingLinks {
  provider: GitHostingProvider;
  ownerPath: string;
  repositoryName: string;
  repositoryUrl: string;
  commitsUrl: string;
  branchesUrl: string;
  pullRequestsUrl: string;
  issuesUrl: string;
  commitUrl?: string;
  branchUrl?: string;
}

export interface GitHostingAccountSummary {
  provider: GitHostingProvider;
  host: string;
  login: string;
  configured: true;
  updatedAt: string;
}

export type GitHostingChangeState = "open" | "closed" | "merged";
export type GitHostingReviewEvent = "approve" | "request-changes";
export type GitHostingMergeMethod = "merge" | "squash" | "rebase";
export type GitHostingMergeReadiness = "allowed" | "blocked" | "unknown";

export interface GitHostingProviderCapabilities {
  draft: boolean;
  reviewEvents: readonly GitHostingReviewEvent[];
  mergeMethods: readonly GitHostingMergeMethod[];
}

export const GIT_HOSTING_PROVIDER_CAPABILITIES: Readonly<Record<GitHostingProvider, GitHostingProviderCapabilities>> = {
  github: { draft: true, reviewEvents: ["approve", "request-changes"], mergeMethods: ["squash", "merge", "rebase"] },
  gitlab: { draft: true, reviewEvents: ["approve", "request-changes"], mergeMethods: ["squash", "merge"] },
  gitee: { draft: true, reviewEvents: ["approve"], mergeMethods: ["squash", "merge", "rebase"] }
};

export interface GitHostingChangeRequest {
  id: number;
  number: number;
  title: string;
  state: GitHostingChangeState;
  draft: boolean;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  webUrl: string;
  createdAt: string;
  updatedAt: string;
  mergeReadiness: GitHostingMergeReadiness;
  mergeStatus?: string;
  reviewStatus?: string;
}

export interface GitHostingCreateChangeInput {
  title: string;
  body?: string;
  sourceBranch: string;
  targetBranch: string;
  sourceRemoteUrl?: string;
  draft?: boolean;
}

export interface GitHostingReviewInput {
  number: number;
  headSha: string;
  event: GitHostingReviewEvent;
  body?: string;
}

export interface GitHostingMergeInput {
  number: number;
  headSha: string;
  method: GitHostingMergeMethod;
}

export interface SshHostKeyFingerprint {
  algorithm: string;
  bits: number;
  fingerprint: string;
}

export interface SshHostInspection {
  token: string;
  host: string;
  port: number;
  status: "trusted" | "unknown" | "changed";
  currentFingerprints: SshHostKeyFingerprint[];
  scannedFingerprints: SshHostKeyFingerprint[];
  expiresAt: string;
}

export interface GitCloneOptions {
  branch?: string;
  depth?: number;
  recurseSubmodules?: boolean;
}

export type GitHistoryFilterMode = "auto" | "all" | "custom";

export interface GitHistoryFilter {
  mode: GitHistoryFilterMode;
  refIds?: string[];
}

export interface GitHistoryQuery {
  filter?: GitHistoryFilter;
  skip?: number;
  limit?: number;
  search?: string;
  author?: string;
  after?: string;
  before?: string;
  path?: string;
}

export interface GitHistoryPage {
  commits: CommitNode[];
  hasMore: boolean;
  nextSkip: number;
}

export interface GitBlameLine {
  lineNumber: number;
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  content: string;
}

export interface GitHistoryRef {
  id: string;
  name: string;
  type: "branch" | "remoteBranch" | "tag";
  revision: string;
  category: "branches" | "remote branches" | "tags";
  current?: boolean;
  upstream?: boolean;
}

export interface CommitInput {
  subject: string;
  body?: string;
  amend?: boolean;
  pushAfterCommit?: boolean;
}

export interface CommitMessageInput {
  subject: string;
  body?: string;
}

export type GitResetMode = "soft" | "mixed" | "hard";
export type CommitGraphAction =
  | "copyHash"
  | "copyMessage"
  | "amendMessage"
  | "revert"
  | "cherryPick"
  | "createBranch"
  | "resetSoft"
  | "resetMixed"
  | "resetHard";

export interface GitOperationResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  messageZh?: string;
}

export interface TerminalSessionInfo {
  sessionId: string;
  shell: string;
  cwd: string;
  trustedPromptMarkers: boolean;
}

export interface TerminalHistoryEntry {
  id: string;
  command: string;
  executedAt: string;
}

export interface TerminalDataEvent {
  sessionId: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

export type MainView = "history" | "workspace";
