import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { RemoteProjectInput, SshConnection } from "./configStore";

export interface RepositoryTarget {
  path: string;
  remote?: SshConnection;
}

export type RepositoryLocation = string | RepositoryTarget;

export interface GitOperationResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  messageZh?: string;
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

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted";
  staged: boolean;
}

export interface CommitRef {
  type: "head" | "localBranch" | "remoteBranch" | "tag";
  name: string;
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
  type: "image" | "video";
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

export type GitLongOperationKind = "clone" | "fetch" | "pull" | "push" | "lfs-pull" | "lfs-migrate";
export type GitLongOperationPhase = "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface GitLongOperationProgress {
  id: string;
  kind: GitLongOperationKind;
  phase: GitLongOperationPhase;
  label: string;
  repositoryPath?: string;
  message?: string;
  percent?: number;
  receivedObjects?: number;
  totalObjects?: number;
  updatedAt: string;
}

export interface GitLongOperationContext {
  id: string;
  kind: GitLongOperationKind;
  label: string;
  repositoryPath?: string;
  onProgress: (progress: GitLongOperationProgress) => void;
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

export interface GitPushOptions {
  forceWithLease?: boolean;
  operation?: GitLongOperationContext;
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

interface GitRunOptions {
  timeoutMs?: number;
  stdin?: Buffer;
  operation?: GitLongOperationContext;
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
export type GitOperationState = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";
export type GitMergeStrategy = "ff" | "no-ff";
export type GitMergeMode = "up-to-date" | "fast-forward" | "merge-commit";
export type GitPullStrategy = "ff-only" | "rebase" | "rebase-autostash";

export interface GitMergePreview {
  sourceBranch: string;
  targetBranch: string;
  targetUpstream?: string;
  targetAhead: number;
  targetBehind: number;
  mode: GitMergeMode;
}

interface ManagedMergeState {
  sourceBranch: string;
  targetBranch: string;
  startedAt: string;
  mergeHead: string;
  originalHead: string;
  mergeMarkerToken: string;
}

interface ConflictSnapshot {
  path: string;
  base: Buffer | null;
  current: Buffer | null;
  incoming: Buffer | null;
  result: Buffer | null;
  token: string;
}

const fieldSeparator = "\x1f";
const recordSeparator = "\x1e";
const resetCommandTimeoutMs = 30_000;
const mergeCommandTimeoutMs = 120_000;
const remoteReadCommandTimeoutMs = 30_000;
const managedMergeStateFile = "git-ui-pro-merge-state.json";
const readOnlyGitCommands = new Set([
  "cat-file",
  "check-ref-format",
  "diff",
  "diff-tree",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "reflog",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
  "verify-commit"
]);
const maxEditableConflictBytes = 2 * 1024 * 1024;
const maxPreviewImageBytes = 25 * 1024 * 1024;
const maxPreviewVideoBytes = 80 * 1024 * 1024;

const graphColors = ["#51c2a9", "#7aa7ff", "#d69cff", "#f0c36b", "#ef6b73", "#8bd38b"];
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const fallbackPathDecoder = new TextDecoder("gb18030");
const gitOperationMarkers: Array<{ path: string; state: GitOperationState }> = [
  { path: "rebase-merge", state: "rebase" },
  { path: "rebase-apply", state: "rebase" },
  { path: "MERGE_HEAD", state: "merge" },
  { path: "CHERRY_PICK_HEAD", state: "cherry-pick" },
  { path: "REVERT_HEAD", state: "revert" },
  { path: "BISECT_LOG", state: "bisect" }
];

const skippedDirectoryNames = new Set([
  ".git",
  "node_modules",
  ".cache",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo"
]);

function createGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    LESSCHARSET: "utf-8",
    OUTPUT_CHARSET: "UTF-8"
  };

  return appendGitConfig(env, [
    ["core.quotepath", "false"],
    ["i18n.commitEncoding", "utf-8"],
    ["i18n.logOutputEncoding", "utf-8"]
  ]);
}

function appendGitConfig(env: NodeJS.ProcessEnv, entries: Array<[string, string]>): NodeJS.ProcessEnv {
  const existingCount = Number(env.GIT_CONFIG_COUNT);
  const baseIndex = Number.isInteger(existingCount) && existingCount >= 0 ? existingCount : 0;

  entries.forEach(([key, value], index) => {
    const slot = baseIndex + index;
    env[`GIT_CONFIG_KEY_${slot}`] = key;
    env[`GIT_CONFIG_VALUE_${slot}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(baseIndex + entries.length);

  return env;
}

function decodeGitOutput(buffer: Buffer): string {
  if (buffer.byteLength === 0) {
    return "";
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return process.platform === "win32" ? fallbackPathDecoder.decode(buffer) : buffer.toString("utf8");
  }
}

export class GitService {
  private readonly activeMergeRepositories = new Set<string>();
  private readonly pendingStatusRequests = new Map<string, Promise<GitStatusSummary>>();
  private readonly pendingPorcelainStatusRequests = new Map<string, Promise<string>>();
  private readonly cleanManagedMergeRepositories = new Set<string>();
  private readonly activeLongOperations = new Map<string, {
    child: ReturnType<typeof spawn>;
    context: GitLongOperationContext;
    cancelled: boolean;
  }>();

  cancelLongOperation(operationId: string): boolean {
    const active = this.activeLongOperations.get(operationId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    active.context.onProgress(operationProgress(active.context, "cancelling", "正在取消"));
    active.child.kill();
    return true;
  }

  async run(cwd: RepositoryLocation, args: string[], options: GitRunOptions = {}): Promise<GitOperationResult> {
    const result = await this.runProcess(cwd, args, options);
    return {
      ...result,
      stdout: decodeGitOutput(result.stdout)
    };
  }

  private async runBinary(
    cwd: RepositoryLocation,
    args: string[],
    options: GitRunOptions = {}
  ): Promise<Omit<GitOperationResult, "stdout"> & { stdout: Buffer }> {
    return this.runProcess(cwd, args, options);
  }

  private async runProcess(
    cwd: RepositoryLocation,
    args: string[],
    options: GitRunOptions = {}
  ): Promise<Omit<GitOperationResult, "stdout"> & { stdout: Buffer }> {
    if (options.operation && this.activeLongOperations.has(options.operation.id)) {
      throw new Error(`Git 后台任务编号重复：${options.operation.id}`);
    }
    return new Promise((resolve) => {
      const target = normalizeRepositoryTarget(cwd);
      const timeoutMs = options.timeoutMs ?? (target.remote && isReadOnlyGitCommand(args) ? remoteReadCommandTimeoutMs : undefined);
      const remoteCommand = target.remote ? buildRemoteGitCommand(target.path, args) : undefined;
      const executable = target.remote ? "ssh" : "git";
      const executableArgs = target.remote ? [...buildSshArgs(target.remote, true), remoteCommand!] : args;
      const command = target.remote ? `ssh ${sshDestination(target.remote)} -- git ${args.join(" ")}` : `git ${args.join(" ")}`;
      let settled = false;
      const child = spawn(executable, executableArgs, {
        cwd: target.remote ? process.cwd() : target.path,
        env: createGitEnv(),
        shell: false,
        windowsHide: true
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const finish = (result: Omit<GitOperationResult, "stdout"> & { stdout: Buffer }) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (options.operation) {
          const active = this.activeLongOperations.get(options.operation.id);
          const cancelled = active?.cancelled === true;
          this.activeLongOperations.delete(options.operation.id);
          options.operation.onProgress(operationProgress(
            options.operation,
            cancelled ? "cancelled" : result.ok ? "completed" : "failed",
            cancelled ? "已取消" : result.ok ? "已完成" : result.messageZh ?? "执行失败",
            result.ok ? 100 : undefined
          ));
        }
        resolve(result);
      };
      const timeoutId = timeoutMs
        ? setTimeout(() => {
            const timeoutText = `Git command timed out after ${Math.round(timeoutMs / 1000)}s.`;
            const stderrText = decodeGitOutput(Buffer.concat(stderrChunks));
            const stderr = stderrText ? `${stderrText}\n${timeoutText}` : timeoutText;
            child.kill();
            finish({
              ok: false,
              command,
              stdout: Buffer.concat(stdoutChunks),
              stderr,
              exitCode: -1,
              messageZh: target.remote ? "远程 Git 命令执行超时，请检查 SSH 连接后重试" : "Git 命令执行超时，请确认仓库未被其它进程锁定后重试"
            });
          }, timeoutMs)
        : undefined;

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        if (options.operation) {
          emitOperationChunk(options.operation, chunk);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        if (options.operation) {
          emitOperationChunk(options.operation, chunk);
        }
      });
      child.stdin.on("error", () => undefined);

      if (options.stdin) {
        child.stdin.end(options.stdin);
      } else {
        child.stdin.end();
      }

      child.on("error", (error) => {
        finish({
          ok: false,
          command,
          stdout: Buffer.concat(stdoutChunks),
          stderr: error.message,
          exitCode: -1,
          messageZh: target.remote ? "无法执行 SSH，请确认本机已安装 OpenSSH 并加入 PATH。" : "无法执行 Git 命令，请确认本机已安装 Git 并加入 PATH。"
        });
      });

      child.on("close", (code) => {
        const exitCode = code ?? -1;
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = decodeGitOutput(Buffer.concat(stderrChunks));
        finish({
          ok: exitCode === 0,
          command,
          stdout,
          stderr,
          exitCode,
          messageZh: exitCode === 0 ? undefined : target.remote ? toChineseSshError(stderr) : toChineseGitError(decodeGitOutput(stdout), stderr)
        });
      });

      if (options.operation) {
        this.activeLongOperations.set(options.operation.id, { child, context: options.operation, cancelled: false });
        options.operation.onProgress(operationProgress(options.operation, "running", "正在启动", 0));
      }
    });
  }

  async getVersion(): Promise<GitOperationResult> {
    return this.run(process.cwd(), ["--version"]);
  }

  async getRepositoryRoot(candidatePath: string): Promise<string> {
    const result = await this.run(candidatePath, ["rev-parse", "--show-toplevel"]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "所选目录不是 Git 仓库。");
    }
    return result.stdout.trim();
  }

  async initializeRepository(directoryPath: string, initialBranch: string): Promise<GitOperationResult> {
    const targetPath = requireAbsoluteLocalPath(directoryPath, "仓库目录");
    const branch = requireValue(initialBranch, "初始分支名");
    const validationResult = await this.run(process.cwd(), ["check-ref-format", "--branch", branch]);
    if (!validationResult.ok) {
      return {
        ...validationResult,
        messageZh: "初始分支名不合法，请检查是否包含空格、连续点号或 Git 不允许的字符。"
      };
    }

    await mkdir(targetPath, { recursive: true });
    return this.run(targetPath, ["init", `--initial-branch=${branch}`]);
  }

  async cloneRepository(
    sourceUrl: string,
    destinationPath: string,
    options: GitCloneOptions = {},
    operation?: GitLongOperationContext
  ): Promise<GitOperationResult> {
    const source = requireNonOptionValue(sourceUrl, "仓库地址");
    const destination = requireAbsoluteLocalPath(destinationPath, "克隆目录");
    if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 1)) {
      throw new Error("克隆深度必须是大于 0 的整数。");
    }

    const args = ["clone", "--progress"];
    if (options.branch) {
      args.push("--branch", requireNonOptionValue(options.branch, "克隆分支"));
    }
    if (options.depth !== undefined) {
      args.push("--depth", String(options.depth));
    }
    if (options.recurseSubmodules) {
      args.push("--recurse-submodules");
    }
    args.push("--", source, destination);

    const parentDirectory = path.dirname(destination);
    await mkdir(parentDirectory, { recursive: true });
    return this.run(parentDirectory, args, { timeoutMs: 10 * 60_000, operation });
  }

  async testRemoteRepository(input: RemoteProjectInput): Promise<GitOperationResult & { repositoryRoot?: string; projectName?: string }> {
    const validationError = validateRemoteProjectInput(input);
    if (validationError) {
      return gitFailure("ssh", validationError);
    }

    if (input.identityFile) {
      try {
        await access(input.identityFile.trim(), fsConstants.R_OK);
      } catch {
        return gitFailure("ssh", "无法读取所选 SSH 私钥，请确认文件仍然存在且当前用户有读取权限。");
      }
    }

    const target: RepositoryTarget = {
      path: input.repositoryPath.trim(),
      remote: {
        type: "ssh",
        host: input.host.trim(),
        username: input.username?.trim() || undefined,
        port: input.port,
        identityFile: input.identityFile?.trim() || undefined
      }
    };
    const result = await this.run(target, ["rev-parse", "--show-toplevel"], { timeoutMs: 20_000 });
    if (!result.ok) {
      return result;
    }

    const repositoryRoot = result.stdout.trim();
    return {
      ...result,
      repositoryRoot,
      projectName: path.posix.basename(repositoryRoot) || target.remote!.host
    };
  }

  async getStatus(repositoryPath: RepositoryLocation): Promise<GitStatusSummary> {
    const requestKey = this.mergeRepositoryKey(repositoryPath);
    const pendingRequest = this.pendingStatusRequests.get(requestKey);
    if (pendingRequest) {
      return { ...(await pendingRequest) };
    }

    const request = this.loadStatus(repositoryPath).finally(() => {
      if (this.pendingStatusRequests.get(requestKey) === request) {
        this.pendingStatusRequests.delete(requestKey);
      }
    });
    this.pendingStatusRequests.set(requestKey, request);
    return { ...(await request) };
  }

  private async loadStatus(repositoryPath: RepositoryLocation): Promise<GitStatusSummary> {
    const summary = parseStatus(await this.getPorcelainStatus(repositoryPath));
    summary.operationState = await this.getOperationState(repositoryPath);
    const repositoryKey = this.mergeRepositoryKey(repositoryPath);
    if (summary.operationState === "merge") {
      this.cleanManagedMergeRepositories.delete(repositoryKey);
      const managedState = await this.readCurrentManagedMergeState(repositoryPath, summary.currentBranch);
      summary.mergeSourceBranch = managedState?.sourceBranch;
      summary.mergeTargetBranch = managedState?.targetBranch;
    } else if (!this.cleanManagedMergeRepositories.has(repositoryKey)) {
      await this.clearManagedMergeState(repositoryPath);
    }
    return summary;
  }

  private async getPorcelainStatus(repositoryPath: RepositoryLocation): Promise<string> {
    const requestKey = this.mergeRepositoryKey(repositoryPath);
    const pendingRequest = this.pendingPorcelainStatusRequests.get(requestKey);
    if (pendingRequest) {
      return pendingRequest;
    }

    const request = this.run(repositoryPath, ["status", "--porcelain=v2", "--branch"])
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.messageZh ?? "无法读取仓库状态。");
        }
        return result.stdout;
      })
      .finally(() => {
        if (this.pendingPorcelainStatusRequests.get(requestKey) === request) {
          this.pendingPorcelainStatusRequests.delete(requestKey);
        }
      });
    this.pendingPorcelainStatusRequests.set(requestKey, request);
    return request;
  }

  private async getOperationState(repositoryPath: RepositoryLocation): Promise<GitOperationState | undefined> {
    const result = await this.run(repositoryPath, ["rev-parse", ...gitOperationMarkers.flatMap((marker) => ["--git-path", marker.path])]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取 Git 操作状态。");
    }

    const markerPaths = result.stdout.split(/\r?\n/).filter(Boolean);
    if (markerPaths.length !== gitOperationMarkers.length) {
      throw new Error("Git 返回的操作状态路径不完整。");
    }
    const target = normalizeRepositoryTarget(repositoryPath);
    if (target.remote) {
      const checks = markerPaths
        .map((markerPath, index) => `if test -e ${shellQuote(resolveGitReportedPath(repositoryPath, markerPath))}; then printf '${index}\\n'; fi`)
        .join("; ");
      const checkResult = await runSshShell(target.remote, checks, { timeoutMs: 10_000 });
      if (!checkResult.ok) {
        throw new Error(checkResult.messageZh ?? "无法检查远程仓库的 Git 操作状态。");
      }
      const firstMarker = checkResult.stdout.toString("utf8").split(/\r?\n/).find(Boolean);
      if (firstMarker === undefined) {
        return undefined;
      }
      const markerIndex = Number(firstMarker);
      if (!Number.isInteger(markerIndex) || !gitOperationMarkers[markerIndex]) {
        throw new Error("远程仓库返回了无效的 Git 操作状态。");
      }
      return gitOperationMarkers[markerIndex].state;
    }

    for (const [index, marker] of gitOperationMarkers.entries()) {
      const markerPath = markerPaths[index];
      if (!markerPath) {
        continue;
      }

      const markerTargetPath = resolveGitReportedPath(repositoryPath, markerPath);
      if (await pathExists(markerTargetPath)) {
        return marker.state;
      }
    }

    return undefined;
  }

  async getHistory(repositoryPath: RepositoryLocation, filter: GitHistoryFilter = { mode: "auto" }): Promise<CommitNode[]> {
    const history: CommitNode[] = [];
    let skip = 0;
    while (true) {
      const page = await this.getHistoryPage(repositoryPath, { filter, skip, limit: 500 });
      history.push(...page.commits);
      if (!page.hasMore) {
        return history;
      }
      if (!Number.isInteger(page.nextSkip) || page.nextSkip <= skip) {
        throw new Error("提交历史分页位置没有向后推进，已停止读取。");
      }
      skip = page.nextSkip;
    }
  }

  async getHistoryPage(repositoryPath: RepositoryLocation, query: GitHistoryQuery = {}): Promise<GitHistoryPage> {
    const skip = query.skip ?? 0;
    if (!Number.isInteger(skip) || skip < 0) {
      throw new Error("历史分页偏移量必须是大于或等于 0 的整数。");
    }
    const limit = requirePositiveInteger(query.limit ?? 150, "历史分页条数");
    if (limit > 500) {
      throw new Error("单次最多读取 500 条提交，请使用分页继续加载。");
    }

    const status = await this.getStatus(repositoryPath);
    const revisions = await this.getHistoryRevisions(repositoryPath, status, query.filter ?? { mode: "auto" });
    const format = ["%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%D", "%s", "%b"]
      .join(`%x${fieldSeparator.charCodeAt(0).toString(16)}`);
    const args = [
      "log",
      "--topo-order",
      "--decorate=full",
      "--date=iso-strict",
      `--skip=${skip}`,
      `--max-count=${limit + 1}`,
      `--pretty=format:${format}%x${recordSeparator.charCodeAt(0).toString(16)}`
    ];
    if (query.search?.trim()) {
      args.push("--regexp-ignore-case", "--fixed-strings", `--grep=${query.search.trim()}`);
    }
    if (query.author?.trim()) {
      args.push(`--author=${query.author.trim()}`);
    }
    if (query.after?.trim()) {
      args.push(`--since=${requireDateQuery(query.after, "开始日期", "start")}`);
    }
    if (query.before?.trim()) {
      args.push(`--until=${requireDateQuery(query.before, "结束日期", "end")}`);
    }
    args.push(...revisions);
    if (query.path?.trim()) {
      args.push("--", toGitPath(requireNonOptionValue(query.path, "历史文件路径")));
    }

    const result = await this.run(repositoryPath, args);
    if (!result.ok) {
      if (isEmptyRepositoryError(result.stderr)) {
        return { commits: [], hasMore: false, nextSkip: skip };
      }
      throw new Error(result.messageZh ?? "无法读取提交历史。" );
    }

    const parsed = parseCommitLog(result.stdout);
    const hasMore = parsed.length > limit;
    const commits = hasMore ? parsed.slice(0, limit) : parsed;
    return { commits, hasMore, nextSkip: skip + commits.length };
  }

  async getBlame(repositoryPath: RepositoryLocation, filePath: string, revision = "HEAD"): Promise<GitBlameLine[]> {
    const targetPath = toGitPath(requireNonOptionValue(filePath, "Blame 文件路径"));
    const targetRevision = requireNonOptionValue(revision, "Blame 提交引用");
    const result = await this.run(repositoryPath, ["blame", "--line-porcelain", targetRevision, "--", targetPath]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取文件 Blame。" );
    }
    return parseBlamePorcelain(result.stdout);
  }

  async getHistoryRefs(repositoryPath: RepositoryLocation): Promise<GitHistoryRef[]> {
    const [status, refsResult] = await Promise.all([
      this.getStatus(repositoryPath),
      this.run(repositoryPath, [
        "for-each-ref",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
        `--format=%(refname)${fieldSeparator}%(refname:short)${fieldSeparator}%(objectname)`
      ])
    ]);

    if (!refsResult.ok) {
      throw new Error(refsResult.messageZh ?? "无法读取图表引用列表。");
    }

    return refsResult.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line): GitHistoryRef | null => {
        const [fullName, shortName, revision] = line.split(fieldSeparator);
        if (!fullName || !shortName || fullName === "refs/remotes/origin/HEAD" || shortName.endsWith("/HEAD")) {
          return null;
        }

        if (fullName.startsWith("refs/remotes/")) {
          return {
            id: fullName,
            name: shortName,
            type: "remoteBranch",
            revision: revision ?? "",
            category: "remote branches",
            upstream: shortName === status?.upstream
          };
        }

        if (fullName.startsWith("refs/tags/")) {
          return {
            id: fullName,
            name: shortName,
            type: "tag",
            revision: revision ?? "",
            category: "tags"
          };
        }

        return {
          id: fullName,
          name: shortName,
          type: "branch",
          revision: revision ?? "",
          category: "branches",
          current: shortName === status?.currentBranch
        };
      })
      .filter((ref): ref is GitHistoryRef => Boolean(ref))
      .sort(compareHistoryRefs);
  }

  async getCommitDetails(repositoryPath: RepositoryLocation, hash: string): Promise<CommitNode> {
    const commits = await this.getSingleCommit(repositoryPath, hash);
    const commit = commits[0];
    if (!commit) {
      throw new Error("找不到指定提交。");
    }

    const filesArgs =
      commit.parents.length > 1
        ? ["diff", "--name-status", "-r", "-M", `${hash}^1`, hash]
        : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", hash];
    const filesResult = await this.run(repositoryPath, filesArgs);
    if (!filesResult.ok) {
      throw new Error(filesResult.messageZh ?? "无法读取提交变更文件。");
    }

    return {
      ...commit,
      files: parseNameStatus(filesResult.stdout)
    };
  }

  async getCommitDiff(repositoryPath: RepositoryLocation, hash: string, filePath?: string): Promise<DiffLine[]> {
    const commits = await this.getSingleCommit(repositoryPath, hash);
    const commit = commits[0];
    if (!commit) {
      throw new Error("找不到指定提交。");
    }

    const args =
      commit.parents.length > 1
        ? ["diff", "--patch", "--find-renames", "--no-ext-diff", `${hash}^1`, hash]
        : ["show", "--format=", "--patch", "--find-renames", "--no-ext-diff", hash];
    if (filePath) {
      args.push("--", filePath);
    }

    const result = await this.run(repositoryPath, args);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取提交 diff。");
    }

    return parseUnifiedDiff(result.stdout);
  }

  async getCommitFilePreview(repositoryPath: RepositoryLocation, hash: string, file: ChangedFile): Promise<FilePreview | null> {
    const targetPath = file.status === "deleted" ? file.oldPath ?? file.path : file.path;
    const media = previewMediaFromPath(targetPath);
    if (!media) {
      return null;
    }

    const revision = file.status === "deleted" ? `${hash}^` : hash;
    const result = await this.readGitBlob(repositoryPath, revision, targetPath);
    if (!result) {
      return null;
    }

    return createFilePreview(result, media, file.status === "deleted" ? "删除前版本" : "提交版本");
  }

  async getWorktree(repositoryPath: RepositoryLocation): Promise<WorktreeState> {
    const [statusOutput, untrackedResult] = await Promise.all([
      this.getPorcelainStatus(repositoryPath),
      this.run(repositoryPath, ["ls-files", "--others", "--exclude-standard"])
    ]);

    if (!untrackedResult.ok) {
      throw new Error(untrackedResult.messageZh ?? "无法扫描未跟踪文件。");
    }

    const worktree = parseWorktree(statusOutput);
    const existingPaths = new Set([...worktree.stagedFiles, ...worktree.unstagedFiles].map((file) => file.path));
    for (const filePath of untrackedResult.stdout.split(/\r?\n/).filter(Boolean)) {
      if (!existingPaths.has(filePath)) {
        worktree.unstagedFiles.push({ path: filePath, status: "untracked", staged: false });
      }
    }

    return sortWorktree(worktree);
  }

  async getWorktreeDiff(repositoryPath: RepositoryLocation, filePath: string, staged: boolean): Promise<DiffLine[]> {
    const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
    const result = await this.run(repositoryPath, args);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取文件 diff。");
    }
    const diffLines = parseUnifiedDiff(result.stdout);
    if (diffLines.length > 0 || staged) {
      return diffLines;
    }

    if (await this.isUntrackedFile(repositoryPath, filePath)) {
      return this.readFileAsAddedDiff(repositoryPath, filePath);
    }

    return diffLines;
  }

  async getConflictFileDetails(repositoryPath: RepositoryLocation, filePath: string): Promise<ConflictFileDetails> {
    const snapshot = await this.loadConflictSnapshot(repositoryPath, filePath);
    const [status, incomingLabel] = await Promise.all([
      this.getStatus(repositoryPath),
      this.getMergeHeadLabel(repositoryPath)
    ]);
    const buffers = [snapshot.base, snapshot.current, snapshot.incoming, snapshot.result].filter((value): value is Buffer => Boolean(value));
    const isBinary = buffers.some(isBinaryBuffer);
    const editable = !isBinary && buffers.every((buffer) => buffer.byteLength <= maxEditableConflictBytes);

    return {
      path: snapshot.path,
      baseContent: editable && snapshot.base ? decodeGitOutput(snapshot.base) : undefined,
      currentContent: editable && snapshot.current ? decodeGitOutput(snapshot.current) : undefined,
      incomingContent: editable && snapshot.incoming ? decodeGitOutput(snapshot.incoming) : undefined,
      resultContent: editable && snapshot.result ? decodeGitOutput(snapshot.result) : undefined,
      baseExists: Boolean(snapshot.base),
      currentExists: Boolean(snapshot.current),
      incomingExists: Boolean(snapshot.incoming),
      resultExists: Boolean(snapshot.result),
      currentLabel: status.mergeTargetBranch ?? status.currentBranch ?? "当前分支",
      incomingLabel: status.mergeSourceBranch ?? incomingLabel ?? "传入分支",
      editable,
      isBinary,
      token: snapshot.token
    };
  }

  async resolveConflictFile(repositoryPath: RepositoryLocation, filePath: string, input: ConflictResolutionInput): Promise<GitOperationResult> {
    try {
      const snapshot = await this.loadConflictSnapshot(repositoryPath, filePath);
      if (snapshot.token !== input.expectedToken) {
        return gitFailure("git add", "冲突文件已被外部修改，请重新打开后再解决。", "Conflict snapshot changed.");
      }

      let resolvedContent: Buffer | null;
      if (input.choice === "current") {
        resolvedContent = snapshot.current;
      } else if (input.choice === "incoming") {
        resolvedContent = snapshot.incoming;
      } else {
        if (typeof input.content !== "string") {
          return gitFailure("git add", "缺少合并结果内容。", "Resolved content is missing.");
        }
        if (!isEditableConflictSnapshot(snapshot)) {
          return gitFailure("git add", "该冲突文件无法作为文本编辑，请采用当前版本或传入版本。", "Conflict is binary or too large.");
        }
        if (containsConflictMarkers(input.content)) {
          return gitFailure("git add", "合并结果仍包含冲突标记，请处理全部冲突块后再保存。", "Conflict markers remain.");
        }
        resolvedContent = Buffer.from(input.content, "utf8");
      }

      if (!resolvedContent) {
        return this.run(repositoryPath, ["rm", "-f", "--", snapshot.path]);
      }

      await this.writeRepositoryFile(repositoryPath, snapshot.path, resolvedContent);
      return this.run(repositoryPath, ["add", "--", snapshot.path]);
    } catch (error) {
      return gitFailure("git add", errorMessage(error, "解决冲突文件失败。"));
    }
  }

  async getWorktreeFilePreview(repositoryPath: RepositoryLocation, file: ChangedFile): Promise<FilePreview | null> {
    const previewPath = file.status === "deleted" ? file.oldPath ?? file.path : file.path;
    const media = previewMediaFromPath(previewPath);
    if (!media) {
      return null;
    }

    if (file.staged) {
      const indexBlob = file.status === "deleted" ? null : await this.readGitBlob(repositoryPath, "", file.path, true);
      if (indexBlob) {
        return createFilePreview(indexBlob, media, "暂存版本");
      }
    }

    if (file.status !== "deleted") {
      const worktreeBlob = await this.readRepositoryFile(repositoryPath, file.path);
      if (worktreeBlob) {
        return createFilePreview(worktreeBlob, media, file.staged ? "工作区版本" : "当前工作区版本");
      }
    }

    const previousBlob = await this.readGitBlob(repositoryPath, "HEAD", file.oldPath ?? file.path);
    if (previousBlob) {
      return createFilePreview(previousBlob, media, "删除前版本");
    }

    return null;
  }

  async stageFile(repositoryPath: RepositoryLocation, file: ChangedFile): Promise<GitOperationResult> {
    const filePaths = changedFilePathspecs(repositoryPath, file);
    return this.run(repositoryPath, ["add", "--", ...filePaths]);
  }

  async stageAll(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["add", "-A"]);
  }

  async unstageFile(repositoryPath: RepositoryLocation, file: ChangedFile): Promise<GitOperationResult> {
    const filePaths = changedFilePathspecs(repositoryPath, file);
    const hasHead = await this.repositoryHasHead(repositoryPath);
    return hasHead
      ? this.run(repositoryPath, ["restore", "--staged", "--", ...filePaths])
      : this.run(repositoryPath, ["rm", "--cached", "-r", "--", ...filePaths]);
  }

  async unstageAll(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    const hasHead = await this.repositoryHasHead(repositoryPath);
    return hasHead
      ? this.run(repositoryPath, ["restore", "--staged", "--", "."])
      : this.run(repositoryPath, ["rm", "--cached", "-r", "--", "."]);
  }

  async discardFile(repositoryPath: RepositoryLocation, file: ChangedFile): Promise<GitOperationResult> {
    const filePaths = changedFilePathspecs(repositoryPath, file);
    const results: GitOperationResult[] = [];
    if (file.staged) {
      const unstageResult = await this.unstageFile(repositoryPath, file);
      results.push(unstageResult);
      if (!unstageResult.ok) {
        return unstageResult;
      }
    }

    if (file.status === "renamed") {
      const [oldPath, newPath] = filePaths;
      if (!file.oldPath || !newPath) {
        throw new Error("重命名文件缺少原路径，无法安全放弃更改。");
      }
      const restoreResult = await this.run(repositoryPath, ["restore", "--worktree", "--", oldPath]);
      results.push(restoreResult);
      if (!restoreResult.ok) {
        return combineGitResults(results, false);
      }
      const cleanResult = await this.run(repositoryPath, ["clean", "-fd", "--", newPath]);
      results.push(cleanResult);
      return combineGitResults(results, cleanResult.ok);
    }

    if (file.status === "untracked" || file.status === "added" || file.status === "copied") {
      const cleanResult = await this.run(repositoryPath, ["clean", "-fd", "--", file.path]);
      results.push(cleanResult);
      return combineGitResults(results, cleanResult.ok);
    }

    const restoreResult = await this.run(repositoryPath, ["restore", "--worktree", "--", file.path]);
    results.push(restoreResult);
    return combineGitResults(results, restoreResult.ok);
  }

  async getStashes(repositoryPath: RepositoryLocation): Promise<GitStashEntry[]> {
    const result = await this.run(repositoryPath, [
      "stash",
      "list",
      `--format=%gd${fieldSeparator}%H${fieldSeparator}%gs${fieldSeparator}%ci`
    ]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取 stash 列表。");
    }

    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line): GitStashEntry => {
        const [selector, hash, subject, createdAt] = line.split(fieldSeparator);
        return {
          selector: selector ?? "",
          hash: hash ?? "",
          subject: subject ?? "",
          createdAt: createdAt ?? ""
        };
      });
  }

  async getStashDetails(repositoryPath: RepositoryLocation, selectorOrHash: string): Promise<GitStashDetails> {
    const selector = await this.resolveStashSelector(repositoryPath, selectorOrHash);
    const [filesResult, diffResult] = await Promise.all([
      this.run(repositoryPath, ["stash", "show", "--name-status", "--include-untracked", selector]),
      this.run(repositoryPath, ["stash", "show", "--patch", "--include-untracked", "--no-ext-diff", selector])
    ]);
    if (!filesResult.ok) {
      throw new Error(filesResult.messageZh ?? "无法读取 stash 文件列表。");
    }
    if (!diffResult.ok) {
      throw new Error(diffResult.messageZh ?? "无法读取 stash 差异。");
    }
    return {
      selector,
      files: parseNameStatus(filesResult.stdout),
      diff: parseUnifiedDiff(diffResult.stdout)
    };
  }

  async createStash(repositoryPath: RepositoryLocation, options: GitStashCreateOptions = {}): Promise<GitOperationResult> {
    const args = ["stash", "push"];
    if (options.includeUntracked) {
      args.push("--include-untracked");
    }
    if (options.keepIndex) {
      args.push("--keep-index");
    }
    if (options.message?.trim()) {
      args.push("--message", options.message.trim());
    }
    return this.run(repositoryPath, args);
  }

  async applyStash(repositoryPath: RepositoryLocation, selectorOrHash: string, restoreIndex = false): Promise<GitOperationResult> {
    const stashSelector = await this.resolveStashSelector(repositoryPath, selectorOrHash);
    return this.run(repositoryPath, ["stash", "apply", ...(restoreIndex ? ["--index"] : []), stashSelector]);
  }

  async popStash(repositoryPath: RepositoryLocation, selectorOrHash: string, restoreIndex = false): Promise<GitOperationResult> {
    const stashSelector = await this.resolveStashSelector(repositoryPath, selectorOrHash);
    return this.run(repositoryPath, ["stash", "pop", ...(restoreIndex ? ["--index"] : []), stashSelector]);
  }

  async dropStash(repositoryPath: RepositoryLocation, selectorOrHash: string): Promise<GitOperationResult> {
    const stashSelector = await this.resolveStashSelector(repositoryPath, selectorOrHash);
    return this.run(repositoryPath, ["stash", "drop", stashSelector]);
  }

  async commit(repositoryPath: RepositoryLocation, input: CommitInput): Promise<GitOperationResult> {
    const subject = input.subject.trim();
    if (!subject && !input.amend) {
      throw new Error("提交标题不能为空。");
    }

    const args = ["commit"];
    if (input.amend) {
      args.push("--amend");
    }
    if (subject) {
      args.push("-m", subject);
    } else if (input.amend) {
      args.push("--no-edit");
    }
    if (input.body?.trim() && subject) {
      args.push("-m", input.body.trim());
    }

    const commitResult = await this.run(repositoryPath, args);
    if (!commitResult.ok || !input.pushAfterCommit) {
      return commitResult;
    }

    const pushResult = await this.push(repositoryPath);
    return {
      ...pushResult,
      command: `${commitResult.command} && ${pushResult.command}`,
      stdout: [commitResult.stdout, pushResult.stdout].filter(Boolean).join("\n"),
      stderr: [commitResult.stderr, pushResult.stderr].filter(Boolean).join("\n")
    };
  }

  async fetch(repositoryPath: RepositoryLocation, operation?: GitLongOperationContext): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["fetch", "--progress", "--prune"], { operation });
  }

  async fetchRemote(
    repositoryPath: RepositoryLocation,
    remoteName: string,
    prune = false,
    operation?: GitLongOperationContext
  ): Promise<GitOperationResult> {
    const remote = requireRemoteName(remoteName);
    return this.run(repositoryPath, ["fetch", "--progress", ...(prune ? ["--prune"] : []), remote], { operation });
  }

  async pull(
    repositoryPath: RepositoryLocation,
    strategy: GitPullStrategy,
    operation?: GitLongOperationContext
  ): Promise<GitOperationResult> {
    if (strategy === "ff-only") {
      return this.run(repositoryPath, ["pull", "--progress", "--ff-only"], { operation });
    }
    if (strategy === "rebase") {
      return this.run(repositoryPath, ["pull", "--progress", "--rebase"], { operation });
    }
    if (strategy === "rebase-autostash") {
      return this.run(repositoryPath, ["pull", "--progress", "--rebase", "--autostash"], { operation });
    }
    throw new Error(`不支持的拉取策略：${String(strategy)}`);
  }

  async mergeRemote(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    const repositoryKey = this.mergeRepositoryKey(repositoryPath);
    if (this.activeMergeRepositories.has(repositoryKey)) {
      return gitFailure("git merge", "当前仓库正在执行合并操作，请稍候。", "Another merge operation is already running.");
    }

    this.activeMergeRepositories.add(repositoryKey);
    try {
      let status = await this.getStatus(repositoryPath);
      const validationFailure = validateRemoteMergeStatus(status);
      if (validationFailure) {
        return validationFailure;
      }

      const fetchResult = await this.fetch(repositoryPath);
      if (!fetchResult.ok) {
        return fetchResult;
      }

      status = await this.getStatus(repositoryPath);
      const refreshedValidationFailure = validateRemoteMergeStatus(status);
      if (refreshedValidationFailure) {
        return combineGitResults([fetchResult, refreshedValidationFailure], false);
      }

      const divergenceResult = await this.run(repositoryPath, [
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${status.upstream!}`
      ]);
      if (!divergenceResult.ok) {
        return combineGitResults([fetchResult, divergenceResult], false);
      }
      const divergenceMatch = divergenceResult.stdout.trim().match(/^(\d+)\s+(\d+)$/);
      if (!divergenceMatch) {
        return combineGitResults([
          fetchResult,
          gitFailure(divergenceResult.command, "Git 返回的当前分支领先落后数量格式不正确。", divergenceResult.stdout)
        ], false);
      }
      status = {
        ...status,
        ahead: Number(divergenceMatch[1]),
        behind: Number(divergenceMatch[2])
      };
      const divergenceValidationFailure = validateRemoteMergeStatus(status, true);
      if (divergenceValidationFailure) {
        return combineGitResults([fetchResult, divergenceResult, divergenceValidationFailure], false);
      }

      if (status.behind === 0) {
        return {
          ...combineGitResults([fetchResult, divergenceResult], true),
          messageZh: "远程分支没有需要合并的新提交。"
        };
      }

      const mergeResult = await this.run(repositoryPath, ["merge", "--no-edit", status.upstream!], {
        timeoutMs: mergeCommandTimeoutMs
      });
      return combineGitResults([fetchResult, divergenceResult, mergeResult], mergeResult.ok);
    } catch (error) {
      return gitFailure("git fetch --prune ; git merge", errorMessage(error, "合并远程更改失败。"));
    } finally {
      this.activeMergeRepositories.delete(repositoryKey);
    }
  }

  async push(repositoryPath: RepositoryLocation, options: GitPushOptions = {}): Promise<GitOperationResult> {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("推送选项格式不正确。");
    }
    if (options.forceWithLease !== undefined && typeof options.forceWithLease !== "boolean") {
      throw new Error("安全强制推送选项必须是布尔值。");
    }

    const status = await this.getStatus(repositoryPath);
    const pushOptions = options.forceWithLease ? ["--force-with-lease"] : [];
    if (status.upstream || !status.currentBranch) {
      return this.run(repositoryPath, ["push", "--progress", ...pushOptions], { operation: options.operation });
    }

    const remote = await this.getPushRemote(repositoryPath, status.currentBranch);
    if (!remote) {
      return {
        ok: false,
        command: "git push",
        stdout: "",
        stderr: "Current branch has no upstream branch and no default push remote could be determined.",
        exitCode: -1,
        messageZh: "当前分支还没有关联远程分支，且无法确定默认远程仓库。请先配置 remote.pushDefault 或手动设置 upstream。"
      };
    }

    return this.run(repositoryPath, ["push", "--progress", ...pushOptions, "--set-upstream", remote, status.currentBranch], { operation: options.operation });
  }

  async getRemotes(repositoryPath: RepositoryLocation): Promise<GitRemoteInfo[]> {
    const [listResult, status] = await Promise.all([
      this.run(repositoryPath, ["remote"]),
      this.getStatus(repositoryPath)
    ]);
    if (!listResult.ok) {
      throw new Error(listResult.messageZh ?? "无法读取远程仓库列表。");
    }

    const fetchDefault = status.currentBranch
      ? await this.getGitConfigValue(repositoryPath, `branch.${status.currentBranch}.remote`)
      : undefined;
    const pushDefault = status.currentBranch
      ? await this.getConfiguredPushRemote(repositoryPath, status.currentBranch)
      : await this.getGitConfigValue(repositoryPath, "remote.pushDefault");

    const names = listResult.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    return Promise.all(
      names.map(async (name): Promise<GitRemoteInfo> => {
        const [fetchResult, pushResult, explicitPushUrls, defaultBranchResult] = await Promise.all([
          this.run(repositoryPath, ["remote", "get-url", "--all", name]),
          this.run(repositoryPath, ["remote", "get-url", "--all", "--push", name]),
          this.getLocalGitConfigValues(repositoryPath, `remote.${name}.pushurl`),
          this.run(repositoryPath, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${name}/HEAD`])
        ]);
        if (!fetchResult.ok) {
          throw new Error(fetchResult.messageZh ?? `无法读取远程仓库 ${name} 的拉取地址。`);
        }
        if (!pushResult.ok) {
          throw new Error(pushResult.messageZh ?? `无法读取远程仓库 ${name} 的推送地址。`);
        }

        const remoteHead = defaultBranchResult.ok ? defaultBranchResult.stdout.trim() : "";
        const defaultBranch = remoteHead.startsWith(`${name}/`) ? remoteHead.slice(name.length + 1) : undefined;
        return {
          name,
          fetchUrls: splitNonEmptyLines(fetchResult.stdout),
          pushUrls: splitNonEmptyLines(pushResult.stdout),
          explicitPushUrls,
          defaultBranch,
          defaultFetch: name === fetchDefault,
          defaultPush: name === pushDefault
        };
      })
    );
  }

  async addRemote(repositoryPath: RepositoryLocation, name: string, fetchUrl: string, pushUrl?: string): Promise<GitOperationResult> {
    const remoteName = requireRemoteName(name);
    const remoteUrl = requireNonOptionValue(fetchUrl, "远程拉取地址");
    const remotePushUrl = pushUrl === undefined ? undefined : requireNonOptionValue(pushUrl, "远程推送地址");
    const addResult = await this.run(repositoryPath, ["remote", "add", remoteName, remoteUrl]);
    if (!addResult.ok || remotePushUrl === undefined || remotePushUrl === remoteUrl) {
      return addResult;
    }

    const pushResult = await this.run(repositoryPath, ["remote", "set-url", "--push", remoteName, remotePushUrl]);
    if (pushResult.ok) {
      return combineGitResults([addResult, pushResult], true);
    }

    const rollbackResult = await this.run(repositoryPath, ["remote", "remove", remoteName]);
    return gitTransactionFailure("新增远程仓库", [addResult, pushResult], [rollbackResult]);
  }

  async updateRemote(repositoryPath: RepositoryLocation, currentName: string, input: GitRemoteUpdateInput): Promise<GitOperationResult> {
    const originalName = requireRemoteName(currentName);
    const nextName = input.name === undefined ? originalName : requireRemoteName(input.name);
    const fetchUrl = input.fetchUrl === undefined ? undefined : requireNonOptionValue(input.fetchUrl, "远程拉取地址");
    const pushUrl = input.pushUrl === undefined
      ? undefined
      : input.pushUrl === null || input.pushUrl.trim() === ""
        ? null
        : requireNonOptionValue(input.pushUrl, "远程推送地址");
    const renameRequested = nextName !== originalName;
    const fetchUpdateRequested = fetchUrl !== undefined;
    const pushUpdateRequested = pushUrl !== undefined;
    if (!renameRequested && !fetchUpdateRequested && !pushUpdateRequested) {
      throw new Error("没有需要更新的远程仓库配置。");
    }

    const originalFetchUrls = await this.getLocalGitConfigValues(repositoryPath, `remote.${originalName}.url`);
    if (originalFetchUrls.length === 0) {
      throw new Error(`远程仓库 ${originalName} 不存在或没有拉取地址。`);
    }
    const originalPushUrls = await this.getLocalGitConfigValues(repositoryPath, `remote.${originalName}.pushurl`);
    const results: GitOperationResult[] = [];
    let activeName = originalName;
    let renamed = false;
    let fetchUpdated = false;
    let pushMutationAttempted = false;

    const failAndRollback = async (): Promise<GitOperationResult> => {
      const rollbackResults: GitOperationResult[] = [];
      if (pushMutationAttempted) {
        rollbackResults.push(...await this.restoreLocalGitConfigValues(
          repositoryPath,
          `remote.${activeName}.pushurl`,
          originalPushUrls
        ));
      }
      if (fetchUpdated) {
        rollbackResults.push(...await this.restoreLocalGitConfigValues(
          repositoryPath,
          `remote.${activeName}.url`,
          originalFetchUrls
        ));
      }
      if (renamed) {
        rollbackResults.push(await this.run(repositoryPath, ["remote", "rename", activeName, originalName]));
      }
      return gitTransactionFailure("远程仓库配置更新", results, rollbackResults);
    };

    if (renameRequested) {
      const renameResult = await this.run(repositoryPath, ["remote", "rename", activeName, nextName]);
      results.push(renameResult);
      if (!renameResult.ok) {
        return combineGitResults(results, false);
      }
      activeName = nextName;
      renamed = true;
    }

    if (fetchUpdateRequested) {
      const fetchResult = await this.run(repositoryPath, ["remote", "set-url", activeName, fetchUrl!]);
      results.push(fetchResult);
      if (!fetchResult.ok) {
        return failAndRollback();
      }
      fetchUpdated = true;
    }

    if (pushUpdateRequested) {
      pushMutationAttempted = true;
      const pushResult =
        pushUrl === null
          ? await this.run(repositoryPath, ["config", "--local", "--unset-all", `remote.${activeName}.pushurl`])
          : await this.run(repositoryPath, [
              "remote",
              "set-url",
              "--push",
              activeName,
              pushUrl!
            ]);
      const normalizedPushResult = pushUrl === null ? acceptAbsentConfigResult(pushResult) : pushResult;
      results.push(normalizedPushResult);
      if (!normalizedPushResult.ok) {
        return failAndRollback();
      }
    }

    return combineGitResults(results, true);
  }

  async removeRemote(repositoryPath: RepositoryLocation, name: string): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["remote", "remove", requireRemoteName(name)]);
  }

  async setBranchUpstream(repositoryPath: RepositoryLocation, branchName: string, upstream: string): Promise<GitOperationResult> {
    const branch = requireNonOptionValue(branchName, "本地分支名");
    const upstreamBranch = requireNonOptionValue(upstream, "上游分支名");
    return this.run(repositoryPath, ["branch", `--set-upstream-to=${upstreamBranch}`, branch]);
  }

  async unsetBranchUpstream(repositoryPath: RepositoryLocation, branchName: string): Promise<GitOperationResult> {
    const branch = requireNonOptionValue(branchName, "本地分支名");
    return this.run(repositoryPath, ["branch", "--unset-upstream", branch]);
  }

  async setDefaultRemote(
    repositoryPath: RepositoryLocation,
    remoteName: string,
    role: "fetch" | "push",
    branchName?: string
  ): Promise<GitOperationResult> {
    const remote = requireRemoteName(remoteName);
    if (role === "push") {
      return this.run(repositoryPath, ["config", "--local", "remote.pushDefault", remote]);
    }

    const branch = requireNonOptionValue(branchName ?? "", "当前分支名");
    return this.setBranchUpstream(repositoryPath, branch, `${remote}/${branch}`);
  }

  async getBranches(repositoryPath: RepositoryLocation): Promise<BranchInfo[]> {
    const [status, refsResult] = await Promise.all([
      this.getStatus(repositoryPath),
      this.run(repositoryPath, [
        "for-each-ref",
        "refs/heads",
        "refs/remotes",
        `--format=%(refname)${fieldSeparator}%(refname:short)${fieldSeparator}%(objectname)${fieldSeparator}%(upstream:short)${fieldSeparator}%(upstream)`
      ])
    ]);

    if (!refsResult.ok) {
      throw new Error(refsResult.messageZh ?? "无法读取分支列表。");
    }
    const refLines = refsResult.stdout.split(/\r?\n/).filter(Boolean);
    const availableRefNames = new Set(refLines.map((line) => line.split(fieldSeparator)[0]).filter(Boolean));
    let mergedRefs: Set<string> | undefined;
    if (!status.unborn) {
      const mergedResult = await this.run(repositoryPath, ["for-each-ref", "--merged=HEAD", "--format=%(refname)", "refs/heads", "refs/remotes"]);
      if (!mergedResult.ok) {
        throw new Error(mergedResult.messageZh ?? "无法判断分支是否已合并到当前提交。");
      }
      mergedRefs = new Set(mergedResult.stdout.split(/\r?\n/).filter(Boolean));
    }
    type BranchCandidate = BranchInfo & { upstreamFullName?: string };
    const branches = refLines
      .map((line): BranchCandidate | null => {
        const [fullName, shortName, headHash, upstream, upstreamFullName] = line.split(fieldSeparator);
        if (!fullName || !shortName || fullName === "refs/remotes/origin/HEAD" || shortName.endsWith("/HEAD")) {
          return null;
        }

        const type: BranchInfo["type"] = fullName.startsWith("refs/remotes/") ? "remote" : "local";
        return {
          name: shortName,
          fullName,
          type,
          current: type === "local" && shortName === status?.currentBranch,
          upstream: upstream || undefined,
          upstreamFullName: upstreamFullName || undefined,
          headHash: headHash ?? "",
          merged: mergedRefs?.has(fullName)
        };
      })
      .filter((branch): branch is BranchCandidate => Boolean(branch))
      .sort(compareBranches);
    return Promise.all(branches.map(async (branch) => {
      const { upstreamFullName, ...branchInfo } = branch;
      if (branch.type !== "local" || !branch.upstream) {
        return branchInfo;
      }
      if (!upstreamFullName || !availableRefNames.has(upstreamFullName)) {
        return {
          ...branchInfo,
          upstreamMissing: true
        };
      }
      const divergenceResult = await this.run(repositoryPath, [
        "rev-list",
        "--left-right",
        "--count",
        `${branch.fullName}...${upstreamFullName}`
      ]);
      if (!divergenceResult.ok) {
        throw new Error(divergenceResult.messageZh ?? `无法计算分支 ${branch.name} 与上游的差异。`);
      }
      const divergence = divergenceResult.stdout.trim().match(/^(\d+)\s+(\d+)$/);
      if (!divergence) {
        throw new Error(`分支 ${branch.name} 的 ahead/behind 结果格式不正确。`);
      }
      return {
        ...branchInfo,
        ahead: Number(divergence[1]),
        behind: Number(divergence[2])
      };
    }));
  }

  async createBranch(repositoryPath: RepositoryLocation, branchName: string, checkout: boolean, startPoint?: string): Promise<GitOperationResult> {
    const name = branchName.trim();
    if (!name) {
      throw new Error("分支名不能为空。");
    }

    const validationResult = await this.run(repositoryPath, ["check-ref-format", "--branch", name]);
    if (!validationResult.ok) {
      return {
        ...validationResult,
        messageZh: "分支名不合法，请检查是否包含空格、连续点号或 Git 不允许的字符。"
      };
    }

    const normalizedStartPoint = startPoint?.trim();
    if (!checkout) {
      return this.run(repositoryPath, ["branch", name, ...(normalizedStartPoint ? [normalizedStartPoint] : [])]);
    }

    return this.run(repositoryPath, ["switch", "-c", name, ...(normalizedStartPoint ? [normalizedStartPoint] : [])]);
  }

  async amendLastCommitMessage(repositoryPath: RepositoryLocation, input: CommitMessageInput): Promise<GitOperationResult> {
    const subject = input.subject.trim();
    if (!subject) {
      throw new Error("提交标题不能为空。");
    }

    const args = ["commit", "--amend", "-m", subject];
    if (input.body?.trim()) {
      args.push("-m", input.body.trim());
    }

    return this.run(repositoryPath, args);
  }

  async resetLastCommit(repositoryPath: RepositoryLocation, mode: GitResetMode): Promise<GitOperationResult> {
    if (mode !== "soft" && mode !== "mixed" && mode !== "hard") {
      throw new Error("撤销上次提交只支持 soft、mixed 或 hard 模式。");
    }
    const headWithParentsResult = await this.run(repositoryPath, ["rev-list", "--parents", "-n", "1", "HEAD"]);
    if (!headWithParentsResult.ok) {
      return headWithParentsResult;
    }

    const [headHash, firstParent] = headWithParentsResult.stdout.trim().split(/\s+/);
    if (!headHash) {
      return gitFailure(headWithParentsResult.command, "无法读取当前提交，撤销操作已停止。", headWithParentsResult.stdout);
    }
    if (firstParent) {
      const resetResult = await this.resetToCommit(repositoryPath, firstParent, mode);
      return combineGitResults([headWithParentsResult, resetResult], resetResult.ok);
    }

    return this.resetRootCommit(repositoryPath, headHash, mode, headWithParentsResult);
  }

  async resetToCommit(repositoryPath: RepositoryLocation, hash: string, mode: GitResetMode): Promise<GitOperationResult> {
    const target = hash.trim();
    if (!target) {
      throw new Error("提交 hash 不能为空。");
    }

    return this.run(repositoryPath, ["reset", `--${mode}`, target], { timeoutMs: resetCommandTimeoutMs });
  }

  async revertCommit(repositoryPath: RepositoryLocation, hash: string): Promise<GitOperationResult> {
    const target = hash.trim();
    if (!target) {
      throw new Error("提交 hash 不能为空。");
    }

    return this.run(repositoryPath, ["revert", "--no-edit", target]);
  }

  async cherryPickCommit(repositoryPath: RepositoryLocation, hash: string): Promise<GitOperationResult> {
    const target = hash.trim();
    if (!target) {
      throw new Error("提交 hash 不能为空。");
    }

    return this.run(repositoryPath, ["cherry-pick", target]);
  }

  async startRebase(repositoryPath: RepositoryLocation, upstream: string, onto?: string): Promise<GitOperationResult> {
    const upstreamRef = requireNonOptionValue(upstream, "rebase 上游引用");
    const args = ["rebase"];
    if (onto !== undefined) {
      args.push("--onto", requireNonOptionValue(onto, "rebase 目标引用"));
    }
    args.push(upstreamRef);
    return this.run(repositoryPath, args, { timeoutMs: mergeCommandTimeoutMs });
  }

  async getRebasePlan(repositoryPath: RepositoryLocation, upstream: string): Promise<GitRebasePlanItem[]> {
    const upstreamRef = requireNonOptionValue(upstream, "rebase 上游引用");
    const result = await this.run(repositoryPath, [
      "log",
      "--reverse",
      "--no-merges",
      `--format=%H${fieldSeparator}%s`,
      `${upstreamRef}..HEAD`
    ]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法生成交互式变基计划。" );
    }
    return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash, subject] = line.split(fieldSeparator);
      return { hash, shortHash: hash.slice(0, 10), subject: subject ?? "", action: "pick" as const };
    });
  }

  async startInteractiveRebase(
    repositoryPath: RepositoryLocation,
    upstream: string,
    plan: GitRebasePlanItem[],
    onto?: string
  ): Promise<GitOperationResult> {
    const upstreamRef = requireNonOptionValue(upstream, "rebase 上游引用");
    if (plan.length === 0) {
      throw new Error("交互式变基计划不能为空。");
    }

    const availablePlan = await this.getRebasePlan(repositoryPath, upstreamRef);
    const availableHashes = new Set(availablePlan.map((item) => item.hash));
    const submittedHashes = new Set<string>();
    for (const item of plan) {
      if (!isGitRebaseAction(item.action)) {
        throw new Error(`不支持的 rebase 动作：${String(item.action)}`);
      }
      if (!/^[0-9a-f]{40,64}$/i.test(item.hash) || !availableHashes.has(item.hash)) {
        throw new Error(`rebase 计划包含不属于当前范围的提交：${item.hash}`);
      }
      if (submittedHashes.has(item.hash)) {
        throw new Error(`rebase 计划包含重复提交：${item.shortHash || item.hash.slice(0, 10)}`);
      }
      submittedHashes.add(item.hash);
    }
    if (submittedHashes.size !== availableHashes.size) {
      throw new Error("rebase 计划必须保留范围内的全部提交；需要移除的提交请明确选择 drop。");
    }

    const sequenceEditor = buildRebaseSequenceEditor(plan);
    const args = ["-c", `sequence.editor=${sequenceEditor}`, "-c", "core.editor=true", "rebase", "-i"];
    if (onto !== undefined) {
      args.push("--onto", requireNonOptionValue(onto, "rebase 目标引用"));
    }
    args.push(upstreamRef);
    return this.run(repositoryPath, args, { timeoutMs: mergeCommandTimeoutMs });
  }

  async continueRebase(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["-c", "core.editor=true", "rebase", "--continue"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async skipRebase(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["rebase", "--skip"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async abortRebase(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["rebase", "--abort"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async continueCherryPick(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["-c", "core.editor=true", "cherry-pick", "--continue"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async abortCherryPick(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["cherry-pick", "--abort"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async skipCherryPick(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["cherry-pick", "--skip"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async continueRevert(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["-c", "core.editor=true", "revert", "--continue"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async abortRevert(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["revert", "--abort"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async skipRevert(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["revert", "--skip"], { timeoutMs: mergeCommandTimeoutMs });
  }

  async startBisect(repositoryPath: RepositoryLocation, badRef?: string, goodRef?: string): Promise<GitOperationResult> {
    if ((badRef === undefined) !== (goodRef === undefined)) {
      throw new Error("启动 bisect 时必须同时提供已知坏提交和已知好提交，或两者都不提供。");
    }
    return this.run(
      repositoryPath,
      badRef === undefined
        ? ["bisect", "start"]
        : ["bisect", "start", requireNonOptionValue(badRef, "已知坏提交"), requireNonOptionValue(goodRef!, "已知好提交")]
    );
  }

  async markBisectGood(repositoryPath: RepositoryLocation, ref?: string): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["bisect", "good", ...(ref !== undefined ? [requireNonOptionValue(ref, "bisect 好提交")] : [])]);
  }

  async markBisectBad(repositoryPath: RepositoryLocation, ref?: string): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["bisect", "bad", ...(ref !== undefined ? [requireNonOptionValue(ref, "bisect 坏提交")] : [])]);
  }

  async skipBisect(repositoryPath: RepositoryLocation, refs: string[] = []): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["bisect", "skip", ...refs.map((ref) => requireNonOptionValue(ref, "bisect 跳过提交"))]);
  }

  async resetBisect(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["bisect", "reset"]);
  }

  async showCommitSignature(repositoryPath: RepositoryLocation, revision: string): Promise<GitOperationResult> {
    const target = requireNonOptionValue(revision, "签名提交引用");
    return this.run(repositoryPath, ["show", "--show-signature", "--no-patch", "--format=fuller", target]);
  }

  async verifyCommitSignature(repositoryPath: RepositoryLocation, revision: string): Promise<GitOperationResult> {
    const target = requireNonOptionValue(revision, "签名提交引用");
    return this.run(repositoryPath, ["verify-commit", "--raw", target]);
  }

  async switchBranch(repositoryPath: RepositoryLocation, branch: BranchInfo): Promise<GitOperationResult> {
    if (branch.type === "remote") {
      return this.run(repositoryPath, ["switch", "--track", branch.name]);
    }

    return this.run(repositoryPath, ["switch", branch.name]);
  }

  async getMergePreview(repositoryPath: RepositoryLocation, targetBranch: string): Promise<GitMergePreview> {
    if (this.activeMergeRepositories.has(this.mergeRepositoryKey(repositoryPath))) {
      throw new Error("当前仓库正在执行合并操作，请稍候。");
    }

    return this.buildMergePreview(repositoryPath, targetBranch);
  }

  async mergeCurrentBranch(repositoryPath: RepositoryLocation, targetBranch: string, strategy: GitMergeStrategy): Promise<GitOperationResult> {
    const repositoryKey = this.mergeRepositoryKey(repositoryPath);
    if (this.activeMergeRepositories.has(repositoryKey)) {
      return gitFailure("git merge", "当前仓库正在执行合并操作，请稍候。", "Another merge operation is already running.");
    }

    this.activeMergeRepositories.add(repositoryKey);
    try {
      const plan = await this.buildMergePreview(repositoryPath, targetBranch);
      if (plan.mode === "up-to-date") {
        return {
          ok: true,
          command: `git merge-base --is-ancestor ${plan.sourceBranch} ${plan.targetBranch}`,
          stdout: `${plan.targetBranch} already contains ${plan.sourceBranch}.`,
          stderr: "",
          exitCode: 0
        };
      }

      const switchResult = await this.switchToLocalBranch(repositoryPath, plan.targetBranch);
      if (!switchResult.ok) {
        return {
          ...switchResult,
          messageZh: `无法切换到目标分支 ${plan.targetBranch}。工作区未发生合并，请查看原始 Git 输出。`
        };
      }

      const strategyArg = strategy === "no-ff" ? "--no-ff" : "--ff";
      const mergeResult = await this.run(repositoryPath, ["merge", strategyArg, "--no-edit", plan.sourceBranch], {
        timeoutMs: mergeCommandTimeoutMs
      });
      if (mergeResult.ok) {
        await this.clearManagedMergeState(repositoryPath);
        return combineGitResults([switchResult, mergeResult], true);
      }

      const operationState = await this.getOperationState(repositoryPath);
      if (operationState === "merge") {
        try {
          const [mergeIdentity, mergeMarkerToken] = await Promise.all([
            this.readMergeIdentity(repositoryPath),
            this.readMergeMarkerToken(repositoryPath)
          ]);
          if (!mergeIdentity || !mergeMarkerToken) {
            throw new Error("无法确认当前合并身份。");
          }
          await this.writeManagedMergeState(repositoryPath, {
            sourceBranch: plan.sourceBranch,
            targetBranch: plan.targetBranch,
            startedAt: new Date().toISOString(),
            ...mergeIdentity,
            mergeMarkerToken
          });
        } catch (error) {
          return {
            ...combineGitResults([switchResult, mergeResult], false),
            messageZh: `${mergeResult.messageZh ?? "合并产生冲突。"} 软件无法记录原分支，终止后可能需要手动切回 ${plan.sourceBranch}。`,
            stderr: [mergeResult.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n")
          };
        }

        return combineGitResults([switchResult, mergeResult], false);
      }

      const restoreResult = await this.switchToLocalBranch(repositoryPath, plan.sourceBranch);
      const combined = combineGitResults([switchResult, mergeResult, restoreResult], false);
      return {
        ...combined,
        exitCode: mergeResult.exitCode,
        messageZh: restoreResult.ok
          ? `${mergeResult.messageZh ?? "合并失败。"} 已自动切回原分支 ${plan.sourceBranch}。`
          : `${mergeResult.messageZh ?? "合并失败。"} 同时无法自动切回原分支 ${plan.sourceBranch}，当前仍在 ${plan.targetBranch}。`
      };
    } catch (error) {
      return gitFailure("git merge", errorMessage(error, "合并预检失败。"));
    } finally {
      this.activeMergeRepositories.delete(repositoryKey);
    }
  }

  async continueMerge(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    const repositoryKey = this.mergeRepositoryKey(repositoryPath);
    if (this.activeMergeRepositories.has(repositoryKey)) {
      return gitFailure("git merge --continue", "当前仓库正在执行合并操作，请稍候。", "Another merge operation is already running.");
    }

    this.activeMergeRepositories.add(repositoryKey);
    try {
      const status = await this.getStatus(repositoryPath);
      if (status.operationState !== "merge") {
        return gitFailure("git merge --continue", "当前没有正在进行的合并操作。", "No merge operation is in progress.");
      }
      if (status.hasConflicts) {
        return gitFailure("git merge --continue", "仍有冲突文件未解决，请解决并暂存所有冲突后再继续。", "Unmerged files remain.");
      }

      const result = await this.run(repositoryPath, ["-c", "core.editor=true", "merge", "--continue"], {
        timeoutMs: mergeCommandTimeoutMs
      });
      if (result.ok) {
        await this.clearManagedMergeState(repositoryPath);
      }
      return result;
    } catch (error) {
      return gitFailure("git merge --continue", errorMessage(error, "继续合并失败。"));
    } finally {
      this.activeMergeRepositories.delete(repositoryKey);
    }
  }

  async abortMerge(repositoryPath: RepositoryLocation): Promise<GitOperationResult> {
    const repositoryKey = this.mergeRepositoryKey(repositoryPath);
    if (this.activeMergeRepositories.has(repositoryKey)) {
      return gitFailure("git merge --abort", "当前仓库正在执行合并操作，请稍候。", "Another merge operation is already running.");
    }

    this.activeMergeRepositories.add(repositoryKey);
    try {
      const status = await this.getStatus(repositoryPath);
      if (status.operationState !== "merge") {
        return gitFailure("git merge --abort", "当前没有正在进行的合并操作。", "No merge operation is in progress.");
      }

      const managedState = await this.readCurrentManagedMergeState(repositoryPath, status.currentBranch);
      const abortResult = await this.run(repositoryPath, ["merge", "--abort"], { timeoutMs: mergeCommandTimeoutMs });
      if (!abortResult.ok) {
        return abortResult;
      }

      await this.clearManagedMergeState(repositoryPath);
      if (!managedState) {
        return abortResult;
      }

      const restoreResult = await this.switchToLocalBranch(repositoryPath, managedState.sourceBranch);
      if (!restoreResult.ok) {
        return {
          ...combineGitResults([abortResult, restoreResult], false),
          messageZh: `合并已经终止，但无法切回原分支 ${managedState.sourceBranch}。当前分支内容已恢复，请手动切换分支。`
        };
      }

      return combineGitResults([abortResult, restoreResult], true);
    } catch (error) {
      return gitFailure("git merge --abort", errorMessage(error, "终止合并失败。"));
    } finally {
      this.activeMergeRepositories.delete(repositoryKey);
    }
  }

  async renameBranch(
    repositoryPath: RepositoryLocation,
    currentName: string,
    nextName: string,
    force = false
  ): Promise<GitOperationResult> {
    const current = requireNonOptionValue(currentName, "当前分支名");
    const next = requireNonOptionValue(nextName, "新分支名");
    const validationResult = await this.run(repositoryPath, ["check-ref-format", "--branch", next]);
    if (!validationResult.ok) {
      return {
        ...validationResult,
        messageZh: "新分支名不合法，请检查是否包含空格、连续点号或 Git 不允许的字符。"
      };
    }
    return this.run(repositoryPath, ["branch", force ? "-M" : "-m", current, next]);
  }

  async deleteBranch(repositoryPath: RepositoryLocation, branchName: string, force = false): Promise<GitOperationResult> {
    const name = branchName.trim();
    if (!name) {
      throw new Error("分支名不能为空。");
    }

    return this.run(repositoryPath, ["branch", force ? "-D" : "-d", requireNonOptionValue(name, "分支名")]);
  }

  async deleteRemoteBranch(repositoryPath: RepositoryLocation, remoteName: string, branchName: string): Promise<GitOperationResult> {
    const remote = requireRemoteName(remoteName);
    const branch = requireNonOptionValue(branchName, "远程分支名");
    return this.run(repositoryPath, ["push", remote, "--delete", branch]);
  }

  async getTags(repositoryPath: RepositoryLocation): Promise<GitTagInfo[]> {
    const result = await this.run(repositoryPath, [
      "for-each-ref",
      "refs/tags",
      `--format=%(refname:short)${fieldSeparator}%(objectname)${fieldSeparator}%(*objectname)${fieldSeparator}%(objecttype)${fieldSeparator}%(subject)${fieldSeparator}%(taggerdate:iso-strict)`
    ]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取标签列表。");
    }

    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line): GitTagInfo => {
        const [name, hash, peeledHash, objectType, subject, taggerDate] = line.split(fieldSeparator);
        return {
          name: name ?? "",
          hash: hash ?? "",
          targetHash: peeledHash || hash || "",
          annotated: objectType === "tag",
          subject: subject || undefined,
          taggerDate: taggerDate || undefined
        };
      });
  }

  async createTag(
    repositoryPath: RepositoryLocation,
    tagName: string,
    target = "HEAD",
    message?: string
  ): Promise<GitOperationResult> {
    const name = requireTagName(tagName);
    const targetRef = requireNonOptionValue(target, "标签目标");
    const validationResult = await this.run(repositoryPath, ["check-ref-format", `refs/tags/${name}`]);
    if (!validationResult.ok) {
      return {
        ...validationResult,
        messageZh: "标签名不合法，请检查是否包含空格、连续点号或 Git 不允许的字符。"
      };
    }
    const annotation = message?.trim();
    return this.run(
      repositoryPath,
      annotation ? ["tag", "--annotate", name, targetRef, "--message", annotation] : ["tag", name, targetRef]
    );
  }

  async deleteTag(repositoryPath: RepositoryLocation, tagName: string): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["tag", "--delete", requireTagName(tagName)]);
  }

  async pushTag(repositoryPath: RepositoryLocation, remoteName: string, tagName: string): Promise<GitOperationResult> {
    const remote = requireRemoteName(remoteName);
    const tag = requireTagName(tagName);
    return this.run(repositoryPath, ["push", remote, `refs/tags/${tag}`]);
  }

  async deleteRemoteTag(repositoryPath: RepositoryLocation, remoteName: string, tagName: string): Promise<GitOperationResult> {
    const remote = requireRemoteName(remoteName);
    const tag = requireTagName(tagName);
    return this.run(repositoryPath, ["push", remote, "--delete", `refs/tags/${tag}`]);
  }

  async getReflog(repositoryPath: RepositoryLocation, maxCount = 100): Promise<GitReflogEntry[]> {
    const limit = requirePositiveInteger(maxCount, "reflog 条数");
    const result = await this.run(repositoryPath, [
      "reflog",
      "show",
      `--max-count=${limit}`,
      "--date=iso-strict",
      `--format=%H${fieldSeparator}%gD${fieldSeparator}%gs${fieldSeparator}%gN`
    ]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取 reflog。");
    }

    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index): GitReflogEntry => {
        const [hash, datedSelector, subject, authorName] = line.split(fieldSeparator);
        const selectorMatch = datedSelector?.match(/^(.*)@\{(.+)\}$/);
        if (!selectorMatch || !selectorMatch[1] || !isIsoDate(selectorMatch[2])) {
          throw new Error("Git 返回的 reflog 时间格式不正确。");
        }
        const separatorIndex = (subject ?? "").indexOf(": ");
        return {
          selector: `${selectorMatch[1]}@{${index}}`,
          hash: hash ?? "",
          action: separatorIndex >= 0 ? subject.slice(0, separatorIndex) : subject ?? "",
          message: separatorIndex >= 0 ? subject.slice(separatorIndex + 2) : "",
          authorName: authorName ?? "",
          authorDate: selectorMatch[2]
        };
      });
  }

  async resetToReflogEntry(
    repositoryPath: RepositoryLocation,
    selector: string,
    mode: GitResetMode
  ): Promise<GitOperationResult> {
    const target = requireReflogTarget(selector);
    return this.run(repositoryPath, ["reset", `--${mode}`, target], { timeoutMs: resetCommandTimeoutMs });
  }

  async getLinkedWorktrees(repositoryPath: RepositoryLocation): Promise<GitLinkedWorktree[]> {
    const result = await this.run(repositoryPath, ["worktree", "list", "--porcelain", "-z"]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取 worktree 列表。");
    }
    return parseLinkedWorktrees(result.stdout);
  }

  async addLinkedWorktree(repositoryPath: RepositoryLocation, options: GitWorktreeAddOptions): Promise<GitOperationResult> {
    const targetPath = requireNonOptionValue(options.path, "worktree 路径");
    if (options.newBranch && options.detach) {
      throw new Error("新建分支和分离 HEAD 不能同时使用。");
    }

    const args = ["worktree", "add"];
    if (options.force) {
      args.push("--force");
    }
    if (options.newBranch) {
      const newBranch = requireNonOptionValue(options.newBranch, "worktree 新分支名");
      const validationResult = await this.run(repositoryPath, ["check-ref-format", "--branch", newBranch]);
      if (!validationResult.ok) {
        return {
          ...validationResult,
          messageZh: "worktree 新分支名不合法，请检查是否包含 Git 不允许的字符。"
        };
      }
      args.push("-b", newBranch);
    }
    if (options.detach) {
      args.push("--detach");
    }
    args.push(targetPath);
    if (options.ref) {
      args.push(requireNonOptionValue(options.ref, "worktree 引用"));
    }
    return this.run(repositoryPath, args);
  }

  async removeLinkedWorktree(repositoryPath: RepositoryLocation, worktreePath: string, force = false): Promise<GitOperationResult> {
    const targetPath = requireNonOptionValue(worktreePath, "worktree 路径");
    return this.run(repositoryPath, ["worktree", "remove", ...(force ? ["--force", "--force"] : []), targetPath]);
  }

  async pruneLinkedWorktrees(repositoryPath: RepositoryLocation, dryRun = false): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["worktree", "prune", ...(dryRun ? ["--dry-run", "--verbose"] : [])]);
  }

  async lockLinkedWorktree(repositoryPath: RepositoryLocation, worktreePath: string, reason?: string): Promise<GitOperationResult> {
    const targetPath = requireNonOptionValue(worktreePath, "worktree 路径");
    const lockReason = reason?.trim();
    return this.run(repositoryPath, ["worktree", "lock", ...(lockReason ? ["--reason", lockReason] : []), targetPath]);
  }

  async unlockLinkedWorktree(repositoryPath: RepositoryLocation, worktreePath: string): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["worktree", "unlock", requireNonOptionValue(worktreePath, "worktree 路径")]);
  }

  async moveLinkedWorktree(repositoryPath: RepositoryLocation, options: GitWorktreeMoveOptions): Promise<GitOperationResult> {
    const sourcePath = requireNonOptionValue(options.worktreePath, "worktree 原路径");
    const destinationPath = requireNonOptionValue(options.destinationPath, "worktree 新路径");
    if (sourcePath === destinationPath) {
      throw new Error("worktree 新路径不能与原路径相同。");
    }
    return this.run(repositoryPath, ["worktree", "move", sourcePath, destinationPath]);
  }

  async repairLinkedWorktrees(repositoryPath: RepositoryLocation, worktreePaths: string[] = []): Promise<GitOperationResult> {
    const paths = worktreePaths.map((item) => requireNonOptionValue(item, "worktree 路径"));
    return this.run(repositoryPath, ["worktree", "repair", ...(paths.length > 0 ? ["--", ...paths] : [])]);
  }

  async getSubmodules(repositoryPath: RepositoryLocation): Promise<GitSubmoduleInfo[]> {
    const result = await this.run(repositoryPath, ["submodule", "status", "--recursive"]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取子模块状态。");
    }
    const modules = parseSubmoduleStatus(result.stdout);
    if (modules.length === 0) {
      return [];
    }

    const metadata = await this.readSubmoduleMetadata(repositoryPath, ".", "");
    const orderedModules = [...modules].sort((left, right) => left.path.split("/").length - right.path.split("/").length);
    for (const module of orderedModules) {
      const descendantPrefix = `${module.path}/`;
      if (!modules.some((candidate) => candidate.path.startsWith(descendantPrefix))) {
        continue;
      }
      const nested = await this.readSubmoduleMetadata(repositoryPath, module.path, descendantPrefix);
      for (const [modulePath, item] of nested) {
        metadata.set(modulePath, item);
      }
    }
    return modules.map((module) => {
      const item = metadata.get(module.path);
      if (!item?.url) {
        throw new Error(`子模块 ${module.path} 缺少 URL 配置。`);
      }
      return { ...module, url: item.url, branch: item.branch };
    });
  }

  private async readSubmoduleMetadata(
    repositoryPath: RepositoryLocation,
    workingDirectory: string,
    pathPrefix: string
  ): Promise<Map<string, { url: string; branch?: string }>> {
    const result = await this.run(repositoryPath, [
      ...(workingDirectory === "." ? [] : ["-C", workingDirectory]),
      "config",
      "--file",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.(path|url|branch)$"
    ]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? `无法读取 ${pathPrefix || "根仓库"} 的 .gitmodules 配置。`);
    }
    return new Map(Array.from(parseSubmoduleConfig(result.stdout), ([modulePath, item]) => [`${pathPrefix}${modulePath}`, item]));
  }

  async initializeSubmodules(repositoryPath: RepositoryLocation, paths: string[] = []): Promise<GitOperationResult> {
    const normalizedPaths = paths.map((item) => requireNonOptionValue(item, "子模块路径"));
    return this.run(repositoryPath, ["submodule", "init", ...(normalizedPaths.length > 0 ? ["--", ...normalizedPaths] : [])]);
  }

  async updateSubmodules(repositoryPath: RepositoryLocation, options: GitSubmoduleUpdateOptions = {}): Promise<GitOperationResult> {
    const args = ["submodule", "update"];
    if (options.initialize) {
      args.push("--init");
    }
    if (options.recursive) {
      args.push("--recursive");
    }
    if (options.remote) {
      args.push("--remote");
    }
    const paths = (options.paths ?? []).map((item) => requireNonOptionValue(item, "子模块路径"));
    if (paths.length > 0) {
      args.push("--", ...paths);
    }
    return this.run(repositoryPath, args, { timeoutMs: 10 * 60_000 });
  }

  async syncSubmodules(repositoryPath: RepositoryLocation, recursive = true): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["submodule", "sync", ...(recursive ? ["--recursive"] : [])]);
  }

  async addSubmodule(repositoryPath: RepositoryLocation, options: GitSubmoduleAddOptions): Promise<GitOperationResult> {
    const url = requireNonOptionValue(options.url, "子模块地址");
    const modulePath = requireNonOptionValue(options.path, "子模块路径");
    const args = ["submodule", "add"];
    if (options.force) {
      args.push("--force");
    }
    if (options.name) {
      args.push("--name", requireNonOptionValue(options.name, "子模块名称"));
    }
    if (options.branch) {
      args.push("--branch", requireNonOptionValue(options.branch, "子模块分支"));
    }
    args.push("--", url, modulePath);
    return this.run(repositoryPath, args, { timeoutMs: 10 * 60_000 });
  }

  async setSubmoduleBranch(repositoryPath: RepositoryLocation, modulePath: string, branch?: string): Promise<GitOperationResult> {
    const targetPath = requireNonOptionValue(modulePath, "子模块路径");
    return this.run(repositoryPath, [
      "submodule",
      "set-branch",
      ...(branch?.trim() ? ["--branch", requireNonOptionValue(branch, "子模块分支")] : ["--default"]),
      "--",
      targetPath
    ]);
  }

  async deinitializeSubmodule(repositoryPath: RepositoryLocation, modulePath: string, force = false): Promise<GitOperationResult> {
    return this.run(repositoryPath, [
      "submodule",
      "deinit",
      ...(force ? ["--force"] : []),
      "--",
      requireNonOptionValue(modulePath, "子模块路径")
    ]);
  }

  async removeSubmodule(repositoryPath: RepositoryLocation, modulePath: string, force = false): Promise<GitOperationResult> {
    const targetPath = requireNonOptionValue(modulePath, "子模块路径");
    const deinitResult = await this.deinitializeSubmodule(repositoryPath, targetPath, force);
    if (!deinitResult.ok) {
      return deinitResult;
    }
    const removeResult = await this.run(repositoryPath, ["rm", ...(force ? ["--force"] : []), "--", targetPath]);
    return combineGitResults([deinitResult, removeResult], removeResult.ok);
  }

  async getLfsStatus(repositoryPath: RepositoryLocation): Promise<GitLfsStatus> {
    const versionResult = await this.run(repositoryPath, ["lfs", "version"]);
    if (!versionResult.ok) {
      const diagnostic = `${versionResult.stderr}\n${versionResult.stdout}\n${versionResult.messageZh ?? ""}`;
      if (/lfs is not a git command|git: 'lfs' is not a git command/i.test(diagnostic)) {
        return {
          installed: false,
          initialized: false,
          version: "",
          files: []
        };
      }
      throw new Error(versionResult.messageZh ?? "无法读取 Git LFS 版本。");
    }

    const configurationResult = await this.run(repositoryPath, ["config", "--local", "--get", "filter.lfs.process"]);
    if (!configurationResult.ok && configurationResult.exitCode !== 1) {
      throw new Error(configurationResult.messageZh ?? "无法读取 Git LFS 仓库配置。");
    }
    const hookPathResult = await this.run(repositoryPath, ["rev-parse", "--git-path", "hooks/pre-push"]);
    if (!hookPathResult.ok || !hookPathResult.stdout.trim()) {
      throw new Error(hookPathResult.messageZh ?? "无法定位当前仓库的 pre-push hook。");
    }
    const hookPath = resolveGitReportedPath(repositoryPath, hookPathResult.stdout.trim());
    const hookContent = await this.readOptionalRegularTargetFile(repositoryPath, hookPath);
    const hookExecutable = hookContent !== null && await this.isExecutableTargetFile(repositoryPath, hookPath);
    const localFilterConfigured = configurationResult.ok
      && /^git-lfs\s+filter-process(?:\s|$)/.test(configurationResult.stdout.trim());
    const hookInstallsLfs = hookContent !== null && hookExecutable
      && decodeGitOutput(hookContent)
        .split(/\r?\n/)
        .some((line) => !/^\s*#/.test(line) && /\bgit(?:\s+|-)lfs\s+pre-push\b/.test(line));
    const statusResult = await this.run(repositoryPath, ["lfs", "status", "--json"]);
    if (!statusResult.ok) {
      throw new Error(statusResult.messageZh ?? "无法读取 Git LFS 状态。");
    }

    return {
      installed: true,
      initialized: localFilterConfigured && hookInstallsLfs,
      version: versionResult.stdout.trim(),
      files: parseLfsStatus(statusResult.stdout)
    };
  }

  async installLfs(repositoryPath: RepositoryLocation, scope: "local" | "global"): Promise<GitOperationResult> {
    if (scope !== "local" && scope !== "global") {
      throw new Error("Git LFS 安装范围必须是 local 或 global。");
    }
    return this.run(repositoryPath, ["lfs", "install", ...(scope === "local" ? ["--local"] : [])]);
  }

  async pullLfs(
    repositoryPath: RepositoryLocation,
    remoteName?: string,
    refs: string[] = [],
    operation?: GitLongOperationContext
  ): Promise<GitOperationResult> {
    const args = ["lfs", "pull"];
    if (remoteName !== undefined) {
      args.push(requireRemoteName(remoteName));
      args.push(...refs.map((ref) => requireNonOptionValue(ref, "LFS 引用")));
    } else if (refs.length > 0) {
      throw new Error("指定 LFS 引用时必须同时指定远程仓库名。");
    }
    return this.run(repositoryPath, args, { timeoutMs: 10 * 60_000, operation });
  }

  async pruneLfs(repositoryPath: RepositoryLocation, dryRun = false): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["lfs", "prune", ...(dryRun ? ["--dry-run"] : [])], { timeoutMs: 10 * 60_000 });
  }

  async trackLfsPatterns(repositoryPath: RepositoryLocation, patterns: string[]): Promise<GitOperationResult> {
    const values = requireLfsPatterns(patterns);
    return this.run(repositoryPath, ["lfs", "track", "--", ...values]);
  }

  async untrackLfsPatterns(repositoryPath: RepositoryLocation, patterns: string[]): Promise<GitOperationResult> {
    const values = requireLfsPatterns(patterns);
    return this.run(repositoryPath, ["lfs", "untrack", "--", ...values]);
  }

  async getLfsLocks(repositoryPath: RepositoryLocation): Promise<GitLfsLock[]> {
    const result = await this.run(repositoryPath, ["lfs", "locks", "--json"]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取 Git LFS 锁定记录。");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error("Git LFS 返回了无法解析的锁定记录。");
    }
    const locks = Array.isArray(payload) ? payload : (payload as { locks?: unknown[] } | null)?.locks;
    if (!Array.isArray(locks)) {
      return [];
    }
    return locks.map((entry): GitLfsLock => {
      const item = entry as { id?: unknown; path?: unknown; locked_at?: unknown; owner?: { name?: unknown } };
      return {
        id: String(item.id ?? ""),
        path: String(item.path ?? ""),
        owner: String(item.owner?.name ?? ""),
        ...(typeof item.locked_at === "string" ? { lockedAt: item.locked_at } : {})
      };
    }).filter((item) => item.id !== "" && item.path !== "");
  }

  async lockLfsFile(repositoryPath: RepositoryLocation, filePath: string): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["lfs", "lock", "--", requireNonOptionValue(filePath, "LFS 文件路径")]);
  }

  async unlockLfsFile(repositoryPath: RepositoryLocation, lockId: string, force = false): Promise<GitOperationResult> {
    const id = requireNonOptionValue(lockId, "LFS 锁编号");
    return this.run(repositoryPath, ["lfs", "unlock", "--id", ...(force ? ["--force"] : []), id]);
  }

  async migrateLfs(
    repositoryPath: RepositoryLocation,
    options: GitLfsMigrateOptions,
    operation?: GitLongOperationContext
  ): Promise<GitOperationResult> {
    if (options.rewriteHistory !== true) {
      throw new Error("LFS 迁移会改写提交历史，必须明确确认后才能执行。");
    }
    const include = requireLfsPatterns(options.include);
    const exclude = options.exclude?.length ? requireLfsPatterns(options.exclude) : [];
    const status = await this.getStatus(repositoryPath);
    if (status.stagedCount + status.unstagedCount + status.untrackedCount > 0 || status.hasConflicts) {
      throw new Error("LFS 历史迁移前必须提交或暂存当前工作区修改。");
    }
    const args = ["lfs", "migrate", "import", "--yes", `--include=${include.join(",")}`];
    if (exclude.length > 0) {
      args.push(`--exclude=${exclude.join(",")}`);
    }
    if (options.everything) {
      args.push("--everything");
    }
    return this.run(repositoryPath, args, { timeoutMs: 30 * 60_000, operation });
  }

  async readGitIgnore(repositoryPath: RepositoryLocation): Promise<GitIgnoreDocument> {
    const gitIgnorePath = resolveRepositoryFilePath(repositoryPath, ".gitignore");
    const content = await this.readOptionalRegularTargetFile(repositoryPath, gitIgnorePath);
    if (content === null) {
      return { exists: false, content: "", revision: "missing" };
    }
    return {
      exists: true,
      content: decodeGitOutput(content),
      revision: await this.repositoryContentRevision(repositoryPath, content)
    };
  }

  async writeGitIgnore(repositoryPath: RepositoryLocation, content: string, expectedRevision: string): Promise<void> {
    const revision = requireContentRevision(expectedRevision);
    const target = normalizeRepositoryTarget(repositoryPath);
    const gitIgnorePath = resolveRepositoryFilePath(repositoryPath, ".gitignore");
    const nextContent = Buffer.from(content, "utf8");
    if (!target.remote) {
      const lockPath = `${gitIgnorePath}.git-ui-pro.lock`;
      try {
        await mkdir(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(".gitignore 正在被另一个操作修改，请稍后重试。");
        }
        throw error;
      }

      const temporaryPath = `${gitIgnorePath}.git-ui-pro-${randomUUID()}.tmp`;
      try {
        const current = await this.readOptionalRegularTargetFile(repositoryPath, gitIgnorePath);
        const currentRevision = current === null ? "missing" : await this.repositoryContentRevision(repositoryPath, current);
        if (currentRevision !== revision) {
          throw new Error(".gitignore 已在外部发生变化，保存已停止。请刷新后重新编辑。");
        }
        await writeFile(temporaryPath, nextContent, { flag: "wx" });
        await rename(temporaryPath, gitIgnorePath);
      } finally {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        } finally {
          await rmdir(lockPath);
        }
      }
      return;
    }

    const quotedPath = shellQuote(gitIgnorePath);
    const quotedRepository = shellQuote(target.path);
    const lockPath = shellQuote(`${gitIgnorePath}.git-ui-pro.lock`);
    const temporaryPath = shellQuote(`${gitIgnorePath}.git-ui-pro-${randomUUID()}.tmp`);
    const command = [
      `if ! mkdir -- ${lockPath} 2>/dev/null; then exit 5; fi`,
      `cleanup() { rm -f -- ${temporaryPath}; rmdir -- ${lockPath}; }`,
      "trap cleanup EXIT HUP INT TERM",
      `if [ -e ${quotedPath} ]; then`,
      `  if [ ! -f ${quotedPath} ]; then exit 4; fi`,
      `  current_hash=$(git -C ${quotedRepository} hash-object --stdin < ${quotedPath}) || exit 7`,
      "  current_revision=git:$current_hash",
      "else",
      "  current_revision=missing",
      "fi",
      `if [ "$current_revision" != ${shellQuote(revision)} ]; then exit 6; fi`,
      "umask 022",
      `cat > ${temporaryPath} || exit 7`,
      `mv -f -- ${temporaryPath} ${quotedPath} || exit 7`
    ].join("\n");
    const result = await runSshShell(target.remote, command, { timeoutMs: 20_000, stdin: nextContent });
    if (result.exitCode === 5) {
      throw new Error("远程 .gitignore 正在被另一个操作修改，请稍后重试。");
    }
    if (result.exitCode === 6) {
      throw new Error("远程 .gitignore 已在外部发生变化，保存已停止。请刷新后重新编辑。");
    }
    if (result.exitCode === 4) {
      throw new Error("仓库根目录的 .gitignore 不是普通文件。");
    }
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法写入远程仓库的 .gitignore。");
    }
  }

  async createGitIgnoreIfMissing(repositoryPath: RepositoryLocation): Promise<boolean> {
    const target = normalizeRepositoryTarget(repositoryPath);
    const gitIgnorePath = resolveRepositoryFilePath(repositoryPath, ".gitignore");
    if (!target.remote) {
      try {
        await writeFile(gitIgnorePath, Buffer.alloc(0), { flag: "wx" });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw error;
      }
    }

    const quotedPath = shellQuote(gitIgnorePath);
    const result = await runSshShell(
      target.remote,
      `umask 022; if (set -C; : > ${quotedPath}) 2>/dev/null; then exit 0; fi; if [ -e ${quotedPath} ]; then exit 3; fi; exit 4`,
      { timeoutMs: 20_000 }
    );
    if (result.ok) {
      return true;
    }
    if (result.exitCode === 3) {
      return false;
    }
    throw new Error(result.messageZh ?? "无法在远程仓库中创建 .gitignore。");
  }

  async getSigningConfig(repositoryPath: RepositoryLocation): Promise<GitSigningConfig> {
    const [commitGpgSign, tagGpgSign, signingKey, format] = await Promise.all([
      this.getLocalGitConfigValue(repositoryPath, "commit.gpgSign"),
      this.getLocalGitConfigValue(repositoryPath, "tag.gpgSign"),
      this.getLocalGitConfigValue(repositoryPath, "user.signingKey"),
      this.getLocalGitConfigValue(repositoryPath, "gpg.format")
    ]);
    if (format && !isGitSigningFormat(format)) {
      throw new Error(`仓库配置中的 gpg.format 值不受支持：${format}`);
    }
    return {
      ...(commitGpgSign === undefined ? {} : { commitGpgSign: parseGitBoolean(commitGpgSign, "commit.gpgSign") }),
      ...(tagGpgSign === undefined ? {} : { tagGpgSign: parseGitBoolean(tagGpgSign, "tag.gpgSign") }),
      ...(signingKey === undefined ? {} : { signingKey }),
      ...(format === undefined ? {} : { format: format as GitSigningFormat })
    };
  }

  async setSigningConfig(repositoryPath: RepositoryLocation, input: GitSigningConfigUpdate): Promise<GitOperationResult> {
    const updates: Array<[string, string | null]> = [];
    if (input.commitGpgSign !== undefined) {
      if (input.commitGpgSign !== null && typeof input.commitGpgSign !== "boolean") {
        throw new Error("提交签名开关必须是布尔值或 null。");
      }
      updates.push(["commit.gpgSign", input.commitGpgSign === null ? null : String(input.commitGpgSign)]);
    }
    if (input.tagGpgSign !== undefined) {
      if (input.tagGpgSign !== null && typeof input.tagGpgSign !== "boolean") {
        throw new Error("标签签名开关必须是布尔值或 null。");
      }
      updates.push(["tag.gpgSign", input.tagGpgSign === null ? null : String(input.tagGpgSign)]);
    }
    if (input.signingKey !== undefined) {
      if (input.signingKey !== null && typeof input.signingKey !== "string") {
        throw new Error("签名密钥必须是字符串或 null。");
      }
      updates.push(["user.signingKey", input.signingKey === null ? null : requireValue(input.signingKey, "签名密钥")]);
    }
    if (input.format !== undefined) {
      if (input.format !== null && !isGitSigningFormat(input.format)) {
        throw new Error("签名格式必须是 openpgp、ssh 或 x509。");
      }
      updates.push(["gpg.format", input.format]);
    }
    if (updates.length === 0) {
      throw new Error("没有需要更新的签名配置。");
    }

    const snapshots = new Map<string, string[]>();
    for (const [key] of updates) {
      snapshots.set(key, await this.getLocalGitConfigValues(repositoryPath, key));
    }

    const results: GitOperationResult[] = [];
    const mutatedKeys: string[] = [];
    for (const [key, value] of updates) {
      const rawResult = await this.run(
        repositoryPath,
        value === null ? ["config", "--local", "--unset-all", key] : ["config", "--local", "--replace-all", key, value]
      );
      const result = value === null ? acceptAbsentConfigResult(rawResult) : rawResult;
      results.push(result);
      if (!result.ok) {
        const rollbackResults: GitOperationResult[] = [];
        for (const mutatedKey of [...mutatedKeys].reverse()) {
          rollbackResults.push(...await this.restoreLocalGitConfigValues(
            repositoryPath,
            mutatedKey,
            snapshots.get(mutatedKey) ?? []
          ));
        }
        return gitTransactionFailure("签名配置更新", results, rollbackResults);
      }
      mutatedKeys.push(key);
    }
    return combineGitResults(results, true);
  }

  async getGitIdentity(repositoryPath: RepositoryLocation): Promise<GitIdentityConfig> {
    const [localName, localEmail, effectiveName, effectiveEmail] = await Promise.all([
      this.getLocalGitConfigValue(repositoryPath, "user.name"),
      this.getLocalGitConfigValue(repositoryPath, "user.email"),
      this.getGitConfigValue(repositoryPath, "user.name"),
      this.getGitConfigValue(repositoryPath, "user.email")
    ]);
    const name = localName ?? effectiveName;
    const email = localEmail ?? effectiveEmail;
    const issues = validateGitIdentity(name, email);
    return {
      ...(name === undefined ? {} : { name }),
      ...(email === undefined ? {} : { email }),
      ...(localName === undefined ? {} : { localName }),
      ...(localEmail === undefined ? {} : { localEmail }),
      valid: issues.length === 0,
      issues
    };
  }

  async setGitIdentity(repositoryPath: RepositoryLocation, input: GitIdentityUpdate): Promise<GitOperationResult> {
    if (!input || typeof input.name !== "string" || typeof input.email !== "string") {
      throw new Error("Git 提交身份必须包含姓名和邮箱。");
    }
    const name = input.name.trim();
    const email = input.email.trim();
    const issues = validateGitIdentity(name, email);
    if (issues.length > 0) {
      throw new Error(issues.map((issue) => issue.messageZh).join(" "));
    }

    const updates: Array<["user.name" | "user.email", string]> = [
      ["user.name", name],
      ["user.email", email]
    ];
    const snapshots = new Map<string, string[]>();
    for (const [key] of updates) {
      snapshots.set(key, await this.getLocalGitConfigValues(repositoryPath, key));
    }

    const results: GitOperationResult[] = [];
    const mutatedKeys: string[] = [];
    for (const [key, value] of updates) {
      const result = await this.run(repositoryPath, ["config", "--local", "--replace-all", key, value]);
      results.push(result);
      if (!result.ok) {
        const rollbackResults: GitOperationResult[] = [];
        for (const mutatedKey of [...mutatedKeys].reverse()) {
          rollbackResults.push(...await this.restoreLocalGitConfigValues(
            repositoryPath,
            mutatedKey,
            snapshots.get(mutatedKey) ?? []
          ));
        }
        return gitTransactionFailure("Git 提交身份更新", results, rollbackResults);
      }
      mutatedKeys.push(key);
    }
    return combineGitResults(results, true);
  }

  async getHostingLinks(
    repositoryPath: RepositoryLocation,
    commitHash?: string,
    branchName?: string,
    remoteName = "origin"
  ): Promise<GitHostingLinks> {
    const remote = requireRemoteName(remoteName);
    const urlResult = await this.run(repositoryPath, ["remote", "get-url", remote]);
    if (!urlResult.ok) {
      throw new Error(urlResult.messageZh ?? `无法读取远程仓库 ${remote} 的地址。`);
    }

    const links = parseHostedRemoteUrl(urlResult.stdout.trim(), commitHash, branchName);
    if (!links) {
      throw new Error("当前远程地址不是受支持的 GitHub、GitLab 或 Gitee 仓库。");
    }
    return links;
  }

  async scanRepositories(rootPath: string, maxDepth = 4): Promise<string[]> {
    const found: string[] = [];
    await walk(rootPath, 0, maxDepth, found);
    return found;
  }

  private async repositoryHasHead(repositoryPath: RepositoryLocation): Promise<boolean> {
    const result = await this.run(repositoryPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (result.ok) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new Error(result.messageZh ?? "无法确认仓库是否已有提交。");
  }

  private async resetRootCommit(
    repositoryPath: RepositoryLocation,
    headHash: string,
    mode: GitResetMode,
    headResult: GitOperationResult
  ): Promise<GitOperationResult> {
    const branchResult = await this.run(repositoryPath, ["symbolic-ref", "--quiet", "HEAD"]);
    const branchRef = branchResult.stdout.trim();
    if (!branchResult.ok || !branchRef.startsWith("refs/heads/")) {
      return {
        ...combineGitResults([
          headResult,
          branchResult,
          gitFailure(
            branchResult.command,
            "当前根提交处于 detached HEAD，无法安全撤销；请先切换到本地分支。",
            branchResult.stderr
          )
        ], false),
        messageZh: "当前根提交处于 detached HEAD，无法安全撤销；请先切换到本地分支。"
      };
    }

    const results: GitOperationResult[] = [headResult, branchResult];
    const origHeadResult = await this.run(repositoryPath, ["update-ref", "ORIG_HEAD", headHash]);
    results.push(origHeadResult);
    if (!origHeadResult.ok) {
      return combineGitResults(results, false);
    }

    if (mode === "mixed") {
      const clearIndexResult = await this.run(repositoryPath, ["read-tree", "--empty"]);
      results.push(clearIndexResult);
      if (!clearIndexResult.ok) {
        return combineGitResults(results, false);
      }
    } else if (mode === "hard") {
      const removeTrackedResult = await this.run(repositoryPath, ["rm", "--force", "-r", "--", "."]);
      results.push(removeTrackedResult);
      if (!removeTrackedResult.ok) {
        return combineGitResults(results, false);
      }
    }

    const deleteRefResult = await this.run(repositoryPath, ["update-ref", "-d", branchRef, headHash]);
    results.push(deleteRefResult);
    if (deleteRefResult.ok) {
      return {
        ...combineGitResults(results, true),
        messageZh: mode === "soft"
          ? "已撤销根提交，原提交保存在 ORIG_HEAD，更改仍保持暂存。"
          : mode === "mixed"
            ? "已撤销根提交，原提交保存在 ORIG_HEAD，更改已取消暂存。"
            : "已撤销根提交，原提交保存在 ORIG_HEAD，根提交中的文件已从工作区移除。"
      };
    }

    if (mode === "mixed" || mode === "hard") {
      const restoreResult = mode === "hard"
        ? await this.run(repositoryPath, ["reset", "--hard", headHash])
        : await this.run(repositoryPath, ["read-tree", headHash]);
      results.push(restoreResult);
      if (!restoreResult.ok) {
        return {
          ...combineGitResults(results, false),
          messageZh: "撤销根提交失败，且恢复仓库状态失败；请勿继续提交，先在终端检查 Git 状态。"
        };
      }
    }
    return {
      ...combineGitResults(results, false),
      messageZh: "撤销根提交失败，仓库分支未移动，工作区文件已保留。"
    };
  }

  private async loadConflictSnapshot(repositoryPath: RepositoryLocation, filePath: string): Promise<ConflictSnapshot> {
    const normalizedPath = toGitPath(filePath.trim());
    if (!normalizedPath) {
      throw new Error("冲突文件路径不能为空。");
    }
    resolveRepositoryFilePath(repositoryPath, normalizedPath);

    const unmergedResult = await this.run(repositoryPath, ["ls-files", "--unmerged", "--", normalizedPath]);
    if (!unmergedResult.ok) {
      throw new Error(unmergedResult.messageZh ?? "无法读取冲突文件的索引状态。");
    }
    if (!unmergedResult.stdout.trim()) {
      throw new Error("该文件已不在冲突状态，请刷新工作区。");
    }

    const conflictStages = parseConflictStages(unmergedResult.stdout);

    const [base, current, incoming, result] = await Promise.all([
      conflictStages.has(1) ? this.readConflictStage(repositoryPath, normalizedPath, 1) : null,
      conflictStages.has(2) ? this.readConflictStage(repositoryPath, normalizedPath, 2) : null,
      conflictStages.has(3) ? this.readConflictStage(repositoryPath, normalizedPath, 3) : null,
      this.readRepositoryFile(repositoryPath, normalizedPath)
    ]);
    const token = createHash("sha256")
      .update(unmergedResult.stdout)
      .update(conflictBufferToken(base))
      .update(conflictBufferToken(current))
      .update(conflictBufferToken(incoming))
      .update(conflictBufferToken(result))
      .digest("hex");

    return {
      path: normalizedPath,
      base,
      current,
      incoming,
      result,
      token
    };
  }

  private async readConflictStage(repositoryPath: RepositoryLocation, filePath: string, stage: 1 | 2 | 3): Promise<Buffer | null> {
    const result = await this.runBinary(repositoryPath, ["show", `:${stage}:${filePath}`], { timeoutMs: 10_000 });
    if (!result.ok) {
      throw new Error(result.messageZh ?? `无法读取冲突文件的索引阶段 ${stage}。`);
    }
    return result.stdout;
  }

  private async getMergeHeadLabel(repositoryPath: RepositoryLocation): Promise<string | undefined> {
    const result = await this.run(repositoryPath, ["for-each-ref", "--points-at", "MERGE_HEAD", "--format=%(refname:short)"]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取合并来源分支。");
    }

    const refs = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    return refs.find((ref) => !ref.includes("/")) ?? refs[0];
  }

  private async buildMergePreview(repositoryPath: RepositoryLocation, targetBranch: string): Promise<GitMergePreview> {
    const status = await this.getStatus(repositoryPath);
    if (status.operationState || status.hasConflicts) {
      throw new Error("当前已有 Git 操作或冲突未完成，请先继续或终止当前操作。");
    }

    if (status.stagedCount + status.unstagedCount + status.untrackedCount > 0) {
      throw new Error("合并前必须保持工作区干净，请先提交、暂存到 stash 或丢弃当前改动。");
    }

    const sourceBranch = status.currentBranch;
    if (!sourceBranch) {
      throw new Error("当前是分离 HEAD 状态，无法执行分支合并。");
    }

    const target = targetBranch.trim();
    if (!target) {
      throw new Error("请选择目标分支。");
    }
    if (target === sourceBranch) {
      throw new Error("来源分支和目标分支不能相同。");
    }

    const validationResult = await this.run(repositoryPath, ["check-ref-format", "--branch", target]);
    if (!validationResult.ok) {
      throw new Error("目标分支名不合法。");
    }

    const localBranchResult = await this.run(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${target}`]);
    if (!localBranchResult.ok) {
      if (localBranchResult.exitCode !== 1) {
        throw new Error(localBranchResult.messageZh ?? `无法验证目标分支 ${target}。`);
      }
      throw new Error(`目标分支 ${target} 不是本地分支，请先创建或检出本地分支。`);
    }

    const mergeBaseResult = await this.run(repositoryPath, ["merge-base", sourceBranch, target]);
    if (!mergeBaseResult.ok) {
      if (mergeBaseResult.exitCode !== 1) {
        throw new Error(mergeBaseResult.messageZh ?? `无法计算分支 ${sourceBranch} 与 ${target} 的共同历史。`);
      }
      throw new Error(`分支 ${sourceBranch} 与 ${target} 没有共同历史，已取消合并。`);
    }
    if (!mergeBaseResult.stdout.trim()) {
      throw new Error("Git 没有返回合并基点，已取消合并。");
    }

    const sourceIsAncestor = await this.run(repositoryPath, ["merge-base", "--is-ancestor", sourceBranch, target]);
    let mode: GitMergeMode;
    if (requireAncestorResult(sourceIsAncestor, sourceBranch, target)) {
      mode = "up-to-date";
    } else {
      const targetIsAncestor = await this.run(repositoryPath, ["merge-base", "--is-ancestor", target, sourceBranch]);
      mode = requireAncestorResult(targetIsAncestor, target, sourceBranch) ? "fast-forward" : "merge-commit";
    }

    const upstreamResult = await this.run(repositoryPath, ["for-each-ref", `refs/heads/${target}`, "--format=%(upstream:short)"]);
    if (!upstreamResult.ok) {
      throw new Error(upstreamResult.messageZh ?? `无法读取目标分支 ${target} 的上游配置。`);
    }
    const targetUpstream = upstreamResult.stdout.trim() || undefined;
    let targetAhead = 0;
    let targetBehind = 0;
    if (targetUpstream) {
      const divergenceResult = await this.run(repositoryPath, ["rev-list", "--left-right", "--count", `${target}...${targetUpstream}`]);
      if (!divergenceResult.ok) {
        throw new Error(divergenceResult.messageZh ?? `无法计算目标分支 ${target} 与上游的领先落后数量。`);
      }
      const divergenceMatch = divergenceResult.stdout.trim().match(/^(\d+)\s+(\d+)$/);
      if (!divergenceMatch) {
        throw new Error("Git 返回的目标分支领先落后数量格式不正确。");
      }
      targetAhead = Number(divergenceMatch[1]);
      targetBehind = Number(divergenceMatch[2]);
    }

    return {
      sourceBranch,
      targetBranch: target,
      targetUpstream,
      targetAhead,
      targetBehind,
      mode
    };
  }

  private mergeRepositoryKey(repositoryPath: RepositoryLocation): string {
    const target = normalizeRepositoryTarget(repositoryPath);
    if (target.remote) {
      return [sshDestination(target.remote), target.remote.port ?? 22, path.posix.normalize(target.path)].join("|");
    }
    const resolvedPath = path.resolve(target.path);
    return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  }

  private async switchToLocalBranch(repositoryPath: RepositoryLocation, branchName: string): Promise<GitOperationResult> {
    return this.run(repositoryPath, ["switch", branchName]);
  }

  private async managedMergeStatePath(repositoryPath: RepositoryLocation): Promise<string> {
    const result = await this.run(repositoryPath, ["rev-parse", "--git-path", managedMergeStateFile]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法定位 Git 合并状态目录。");
    }

    const statePath = result.stdout.trim();
    if (!statePath) {
      throw new Error("Git 没有返回合并状态文件路径。");
    }
    return resolveGitReportedPath(repositoryPath, statePath);
  }

  private async readManagedMergeState(repositoryPath: RepositoryLocation): Promise<ManagedMergeState | undefined> {
    const statePath = await this.managedMergeStatePath(repositoryPath);
    const content = await this.readOptionalRegularTargetFile(repositoryPath, statePath);
    if (!content) {
      return undefined;
    }

    let parsed: Partial<ManagedMergeState>;
    try {
      parsed = JSON.parse(decodeGitOutput(content)) as Partial<ManagedMergeState>;
    } catch (error) {
      throw new Error(`合并恢复状态文件无法解析：${errorMessage(error, "JSON 格式错误。")}`);
    }
    if (
      typeof parsed.sourceBranch !== "string" ||
      typeof parsed.targetBranch !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.mergeHead !== "string" ||
      typeof parsed.originalHead !== "string" ||
      typeof parsed.mergeMarkerToken !== "string" ||
      !parsed.mergeMarkerToken.trim() ||
      parsed.mergeMarkerToken.length > 512 ||
      !isCommitHash(parsed.mergeHead) ||
      !isCommitHash(parsed.originalHead)
    ) {
      throw new Error("合并恢复状态文件内容不完整或格式不正确。");
    }
    return {
      sourceBranch: parsed.sourceBranch,
      targetBranch: parsed.targetBranch,
      startedAt: parsed.startedAt,
      mergeHead: parsed.mergeHead.toLowerCase(),
      originalHead: parsed.originalHead.toLowerCase(),
      mergeMarkerToken: parsed.mergeMarkerToken
    };
  }

  private async readCurrentManagedMergeState(
    repositoryPath: RepositoryLocation,
    currentBranch: string | null
  ): Promise<ManagedMergeState | undefined> {
    const state = await this.readManagedMergeState(repositoryPath);
    if (!state) {
      return undefined;
    }
    const [identity, mergeMarkerToken] = await Promise.all([
      this.readMergeIdentity(repositoryPath),
      this.readMergeMarkerToken(repositoryPath)
    ]);
    if (
      state.targetBranch !== currentBranch ||
      state.mergeHead !== identity.mergeHead ||
      state.originalHead !== identity.originalHead ||
      state.mergeMarkerToken !== mergeMarkerToken
    ) {
      return undefined;
    }
    return state;
  }

  private async readMergeIdentity(
    repositoryPath: RepositoryLocation
  ): Promise<Pick<ManagedMergeState, "mergeHead" | "originalHead">> {
    const result = await this.run(repositoryPath, ["rev-parse", "MERGE_HEAD^{commit}", "ORIG_HEAD^{commit}"]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取当前合并提交身份。");
    }
    const [mergeHead, originalHead] = result.stdout.trim().split(/\r?\n/);
    if (!isCommitHash(mergeHead) || !isCommitHash(originalHead)) {
      throw new Error("Git 返回的当前合并提交身份格式不正确。");
    }
    return { mergeHead: mergeHead.toLowerCase(), originalHead: originalHead.toLowerCase() };
  }

  private async readMergeMarkerToken(repositoryPath: RepositoryLocation): Promise<string> {
    const markerResult = await this.run(repositoryPath, ["rev-parse", "--git-path", "MERGE_HEAD"]);
    if (!markerResult.ok) {
      throw new Error(markerResult.messageZh ?? "无法定位当前合并标记文件。");
    }
    if (!markerResult.stdout.trim()) {
      throw new Error("Git 没有返回当前合并标记文件路径。");
    }
    const markerPath = resolveGitReportedPath(repositoryPath, markerResult.stdout.trim());
    const target = normalizeRepositoryTarget(repositoryPath);
    if (!target.remote) {
      const info = await stat(markerPath);
      if (!info.isFile()) {
        throw new Error("当前合并标记不是普通文件。");
      }
      return [info.dev, info.ino, info.size, info.birthtimeMs, info.ctimeMs, info.mtimeMs].join(":");
    }

    const marker = shellQuote(markerPath);
    const command = `stat -c ${shellQuote("%d:%i:%s:%y")} -- ${marker}`;
    const result = await runSshShell(target.remote, command, { timeoutMs: 10_000 });
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取远程合并标记元数据。");
    }
    const token = result.stdout.toString("utf8").trim();
    if (!token || token.length > 512) {
      throw new Error("远程合并标记元数据格式不正确。");
    }
    return token;
  }

  private async writeManagedMergeState(repositoryPath: RepositoryLocation, state: ManagedMergeState): Promise<void> {
    const statePath = await this.managedMergeStatePath(repositoryPath);
    await this.writeTargetFile(repositoryPath, statePath, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
    this.cleanManagedMergeRepositories.delete(this.mergeRepositoryKey(repositoryPath));
  }

  private async clearManagedMergeState(repositoryPath: RepositoryLocation): Promise<void> {
    const statePath = await this.managedMergeStatePath(repositoryPath);
    await this.removeTargetFile(repositoryPath, statePath);
    this.cleanManagedMergeRepositories.add(this.mergeRepositoryKey(repositoryPath));
  }

  private async readOptionalRegularTargetFile(repositoryPath: RepositoryLocation, targetPath: string): Promise<Buffer | null> {
    const target = normalizeRepositoryTarget(repositoryPath);
    if (!target.remote) {
      try {
        const info = await stat(targetPath);
        if (!info.isFile()) {
          throw new Error(`${targetPath} 不是普通文件。`);
        }
        return await readFile(targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    }

    const quotedPath = shellQuote(targetPath);
    const result = await runSshShell(
      target.remote,
      `if [ ! -e ${quotedPath} ]; then exit 3; fi; if [ ! -f ${quotedPath} ]; then exit 4; fi; cat -- ${quotedPath}`,
      { timeoutMs: 20_000 }
    );
    if (result.exitCode === 3) {
      return null;
    }
    if (result.exitCode === 4) {
      throw new Error(`${targetPath} 不是普通文件。`);
    }
    if (!result.ok) {
      throw new Error(result.messageZh ?? `无法读取远程文件 ${targetPath}。`);
    }
    return result.stdout;
  }

  private async isExecutableTargetFile(repositoryPath: RepositoryLocation, targetPath: string): Promise<boolean> {
    const target = normalizeRepositoryTarget(repositoryPath);
    if (!target.remote) {
      try {
        await access(targetPath, fsConstants.X_OK);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") {
          return false;
        }
        throw error;
      }
    }

    const result = await runSshShell(target.remote, `test -x ${shellQuote(targetPath)}`, { timeoutMs: 10_000 });
    if (result.ok) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new Error(result.messageZh ?? `无法检查远程文件 ${targetPath} 的执行权限。`);
  }

  private async repositoryContentRevision(repositoryPath: RepositoryLocation, content: Buffer): Promise<string> {
    const result = await this.run(repositoryPath, ["hash-object", "--stdin"], { stdin: content, timeoutMs: 20_000 });
    const hash = result.stdout.trim();
    if (!result.ok || !/^[0-9a-f]{40,64}$/i.test(hash)) {
      throw new Error(result.messageZh ?? "无法计算仓库文件内容版本。");
    }
    return `git:${hash.toLowerCase()}`;
  }

  private async writeTargetFile(repositoryPath: RepositoryLocation, targetPath: string, content: Buffer): Promise<void> {
    const target = normalizeRepositoryTarget(repositoryPath);
    if (!target.remote) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
      return;
    }

    const targetDirectory = path.posix.dirname(targetPath);
    const result = await runSshShell(
      target.remote,
      `mkdir -p -- ${shellQuote(targetDirectory)} && cat > ${shellQuote(targetPath)}`,
      { timeoutMs: 20_000, stdin: content }
    );
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法写入远程文件。");
    }
  }

  private async removeTargetFile(repositoryPath: RepositoryLocation, targetPath: string): Promise<void> {
    const target = normalizeRepositoryTarget(repositoryPath);
    if (!target.remote) {
      try {
        await unlink(targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }

    const result = await runSshShell(target.remote, `rm -f -- ${shellQuote(targetPath)}`, { timeoutMs: 10_000 });
    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法删除远程状态文件。");
    }
  }

  private async readRepositoryFile(repositoryPath: RepositoryLocation, filePath: string): Promise<Buffer | null> {
    return this.readOptionalRegularTargetFile(repositoryPath, resolveRepositoryFilePath(repositoryPath, filePath));
  }

  private async writeRepositoryFile(repositoryPath: RepositoryLocation, filePath: string, content: Buffer): Promise<void> {
    await this.writeTargetFile(repositoryPath, resolveRepositoryFilePath(repositoryPath, filePath), content);
  }

  private async isUntrackedFile(repositoryPath: RepositoryLocation, filePath: string): Promise<boolean> {
    const result = await this.run(repositoryPath, ["ls-files", "--others", "--exclude-standard", "--", filePath]);
    if (!result.ok) {
      throw new Error(result.messageZh ?? `无法检查未跟踪文件 ${filePath}。`);
    }
    return result.stdout.split(/\r?\n/).filter(Boolean).includes(filePath);
  }

  private async readFileAsAddedDiff(repositoryPath: RepositoryLocation, filePath: string): Promise<DiffLine[]> {
    const content = await this.readRepositoryFile(repositoryPath, filePath);
    if (!content || isBinaryBuffer(content)) {
      return [];
    }

    return decodeGitOutput(content).split(/\r?\n/).map((line, index) => ({
      type: "add",
      newLineNumber: index + 1,
      content: line
    }));
  }

  private async getPushRemote(repositoryPath: RepositoryLocation, branchName: string): Promise<string | undefined> {
    const configuredRemote = await this.getConfiguredPushRemote(repositoryPath, branchName);
    if (configuredRemote) {
      return configuredRemote;
    }

    const remotesResult = await this.run(repositoryPath, ["remote"]);
    if (!remotesResult.ok) {
      throw new Error(remotesResult.messageZh ?? "无法读取远程仓库列表。");
    }

    const remotes = Array.from(new Set(remotesResult.stdout.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean)));
    if (remotes.includes("origin")) {
      return "origin";
    }

    return remotes.length === 1 ? remotes[0] : undefined;
  }

  private async getConfiguredPushRemote(repositoryPath: RepositoryLocation, branchName: string): Promise<string | undefined> {
    const configuredKeys = [`branch.${branchName}.pushRemote`, "remote.pushDefault", `branch.${branchName}.remote`];
    for (const key of configuredKeys) {
      const remote = await this.getGitConfigValue(repositoryPath, key);
      if (remote && remote !== ".") {
        return remote;
      }
    }

    return undefined;
  }

  private async getGitConfigValue(repositoryPath: RepositoryLocation, key: string): Promise<string | undefined> {
    const result = await this.run(repositoryPath, ["config", "--get", key]);
    if (result.exitCode === 1) {
      return undefined;
    }
    if (!result.ok) {
      throw new Error(result.messageZh ?? `无法读取 Git 配置 ${key}。`);
    }

    return result.stdout.trim() || undefined;
  }

  private async getLocalGitConfigValue(repositoryPath: RepositoryLocation, key: string): Promise<string | undefined> {
    const result = await this.run(repositoryPath, ["config", "--local", "--get", key]);
    if (result.ok) {
      return result.stdout.trim() || undefined;
    }
    if (result.exitCode === 1) {
      return undefined;
    }
    throw new Error(result.messageZh ?? `无法读取仓库配置 ${key}。`);
  }

  private async getLocalGitConfigValues(repositoryPath: RepositoryLocation, key: string): Promise<string[]> {
    const result = await this.run(repositoryPath, ["config", "--local", "--null", "--get-all", key]);
    if (result.ok) {
      const values = result.stdout.split("\0");
      if (values.at(-1) === "") {
        values.pop();
      }
      return values;
    }
    if (result.exitCode === 1) {
      return [];
    }
    throw new Error(result.messageZh ?? `无法读取仓库配置 ${key}。`);
  }

  private async restoreLocalGitConfigValues(
    repositoryPath: RepositoryLocation,
    key: string,
    values: string[]
  ): Promise<GitOperationResult[]> {
    const results: GitOperationResult[] = [];
    const unsetResult = acceptAbsentConfigResult(await this.run(repositoryPath, ["config", "--local", "--unset-all", key]));
    results.push(unsetResult);
    if (!unsetResult.ok) {
      return results;
    }
    for (const value of values) {
      const addResult = await this.run(repositoryPath, ["config", "--local", "--add", key, value]);
      results.push(addResult);
      if (!addResult.ok) {
        break;
      }
    }
    return results;
  }

  private async resolveStashSelector(repositoryPath: RepositoryLocation, selectorOrHash: string): Promise<string> {
    const identifier = requireStashIdentifier(selectorOrHash);
    if (identifier.startsWith("stash@{")) {
      return identifier;
    }

    const matches = (await this.getStashes(repositoryPath)).filter((stash) => stash.hash.toLowerCase() === identifier.toLowerCase());
    if (matches.length !== 1) {
      throw new Error(matches.length === 0 ? "所选 stash 已不存在，请刷新列表。" : "stash hash 不唯一，操作已停止。");
    }
    return matches[0].selector;
  }

  private async getHistoryRevisions(repositoryPath: RepositoryLocation, status?: GitStatusSummary, filter: GitHistoryFilter = { mode: "auto" }): Promise<string[]> {
    if (filter.mode === "all") {
      const refs = await this.getHistoryRefs(repositoryPath);
      return refs.length > 0 ? refs.map((ref) => ref.id) : ["HEAD"];
    }

    if (filter.mode === "custom") {
      const refIds = Array.from(new Set((filter.refIds ?? []).map((ref) => ref.trim()).filter(Boolean)));
      return refIds.length > 0 ? refIds : ["HEAD"];
    }

    const revisions = new Set<string>();
    revisions.add(status?.currentBranch ? `refs/heads/${status.currentBranch}` : "HEAD");

    if (status?.upstream) {
      revisions.add(`refs/remotes/${status.upstream}`);
    }

    return Array.from(revisions);
  }

  private async getSingleCommit(repositoryPath: RepositoryLocation, hash: string): Promise<CommitNode[]> {
    const format = [
      "%H",
      "%P",
      "%an",
      "%ae",
      "%aI",
      "%cn",
      "%ce",
      "%cI",
      "%D",
      "%s",
      "%b"
    ].join(`%x${fieldSeparator.charCodeAt(0).toString(16)}`);

    const result = await this.run(repositoryPath, [
      "log",
      "-1",
      "--decorate=full",
      "--date=iso-strict",
      `--pretty=format:${format}%x${recordSeparator.charCodeAt(0).toString(16)}`,
      hash
    ]);

    if (!result.ok) {
      throw new Error(result.messageZh ?? "无法读取提交详情。");
    }

    return parseCommitLog(result.stdout);
  }

  private async readGitBlob(repositoryPath: RepositoryLocation, revision: string, filePath: string, staged = false): Promise<Buffer | null> {
    const gitPath = toGitPath(filePath);
    const objectName = staged ? `:${gitPath}` : `${revision}:${gitPath}`;
    const result = await this.runBinary(repositoryPath, ["show", objectName], { timeoutMs: 10_000 });
    if (!result.ok) {
      return null;
    }

    return result.stdout;
  }
}

function changedFilePathspecs(repositoryPath: RepositoryLocation, file: ChangedFile): string[] {
  const currentPath = toGitPath(requireValue(file.path, "文件路径"));
  const oldPath = file.oldPath ? toGitPath(requireValue(file.oldPath, "文件原路径")) : undefined;
  const filePaths = oldPath && oldPath !== currentPath ? [oldPath, currentPath] : [currentPath];
  for (const filePath of filePaths) {
    resolveRepositoryFilePath(repositoryPath, filePath);
  }
  return filePaths;
}

function parseConflictStages(output: string): Set<1 | 2 | 3> {
  const stages = new Set<1 | 2 | 3>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^\d{6}\s+[0-9a-f]{40,64}\s+([123])\t/);
    if (!match) {
      throw new Error("Git 返回的冲突索引记录格式不正确。");
    }
    stages.add(Number(match[1]) as 1 | 2 | 3);
  }
  return stages;
}

function requireAncestorResult(result: GitOperationResult, ancestor: string, descendant: string): boolean {
  if (result.ok) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  throw new Error(result.messageZh ?? `无法判断分支 ${ancestor} 是否为 ${descendant} 的祖先。`);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function requireValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label}不能为空。`);
  }
  if (normalized.includes("\0")) {
    throw new Error(`${label}包含无效字符。`);
  }
  return normalized;
}

function requireNonOptionValue(value: string, label: string): string {
  const normalized = requireValue(value, label);
  if (normalized.startsWith("-")) {
    throw new Error(`${label}不能以连字符开头。`);
  }
  return normalized;
}

function requireAbsoluteLocalPath(value: string, label: string): string {
  const normalized = requireValue(value, label);
  if (!path.isAbsolute(normalized)) {
    throw new Error(`${label}必须是绝对路径。`);
  }
  return path.normalize(normalized);
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label}必须是大于 0 的整数。`);
  }
  return value;
}

function requireDateQuery(value: string, label: string, boundary: "start" | "end"): string {
  const normalized = requireValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`${label}必须使用 YYYY-MM-DD 格式。`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${label}不是有效日期。`);
  }
  return `${normalized} ${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}`;
}

function isGitRebaseAction(value: string): value is GitRebaseAction {
  return value === "pick" || value === "edit" || value === "squash" || value === "fixup" || value === "drop";
}

function buildRebaseSequenceEditor(plan: GitRebasePlanItem[]): string {
  const lines = plan.map((item) => `"${item.action} ${item.hash}"`).join(" ");
  return `sh -c 'printf "%s\\n" ${lines} > "$1"' --`;
}

function parseBlamePorcelain(output: string): GitBlameLine[] {
  const lines = output.split(/\r?\n/);
  const result: GitBlameLine[] = [];
  let current: Omit<GitBlameLine, "content"> | undefined;

  for (const line of lines) {
    const header = line.match(/^([0-9a-f]{40,64})\s+\d+\s+(\d+)(?:\s+\d+)?$/i);
    if (header) {
      current = {
        lineNumber: Number(header[2]),
        hash: header[1],
        shortHash: header[1].slice(0, 10),
        authorName: "",
        authorEmail: "",
        authorDate: ""
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("author ")) {
      current.authorName = line.slice(7);
    } else if (line.startsWith("author-mail ")) {
      current.authorEmail = line.slice(12).replace(/^<|>$/g, "");
    } else if (line.startsWith("author-time ")) {
      const seconds = Number(line.slice(12));
      current.authorDate = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : "";
    } else if (line.startsWith("\t")) {
      result.push({ ...current, content: line.slice(1) });
      current = undefined;
    }
  }
  return result;
}

function requireRemoteName(value: string): string {
  const normalized = requireValue(value, "远程仓库名");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new Error("远程仓库名只能包含字母、数字、点、下划线和连字符，且必须以字母或数字开头。");
  }
  return normalized;
}

function requireTagName(value: string): string {
  const normalized = requireNonOptionValue(value, "标签名");
  if (/\s|\.\.|[~^:?*\[\\]/.test(normalized) || normalized.endsWith(".") || normalized.endsWith("/")) {
    throw new Error("标签名不合法，请检查是否包含空格、连续点号或 Git 不允许的字符。");
  }
  return normalized;
}

function requireLfsPatterns(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    throw new Error("LFS 文件模式必须包含 1 到 100 项。");
  }
  const patterns = values.map((value) => requireNonOptionValue(value, "LFS 文件模式"));
  if (patterns.some((value) => value.includes(",") || /[\r\n]/.test(value))) {
    throw new Error("LFS 文件模式不能包含逗号或换行。");
  }
  return [...new Set(patterns)];
}

function requireStashIdentifier(value: string): string {
  const identifier = requireValue(value, "stash 标识");
  if (!/^stash@\{\d+\}$/.test(identifier) && !/^[0-9a-f]{40,64}$/i.test(identifier)) {
    throw new Error("stash 标识格式不正确。");
  }
  return identifier;
}

function requireReflogTarget(value: string): string {
  const target = requireNonOptionValue(value, "reflog 恢复目标");
  if (!/^[^\s\0]+@\{\d+\}$/.test(target) && !/^[0-9a-f]{40,64}$/i.test(target)) {
    throw new Error("reflog 标识格式不正确。");
  }
  return target;
}

function splitNonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseLinkedWorktrees(output: string): GitLinkedWorktree[] {
  return output
    .split("\0\0")
    .filter(Boolean)
    .map((record): GitLinkedWorktree => {
      const fields = record.split("\0").filter(Boolean);
      const values = new Map<string, string>();
      const flags = new Set<string>();
      for (const field of fields) {
        const separatorIndex = field.indexOf(" ");
        if (separatorIndex < 0) {
          flags.add(field);
        } else {
          values.set(field.slice(0, separatorIndex), field.slice(separatorIndex + 1));
        }
      }

      const worktreePath = values.get("worktree");
      if (!worktreePath) {
        throw new Error("Git 返回的 worktree 记录缺少路径。");
      }
      const branch = values.get("branch");
      return {
        path: worktreePath,
        head: values.get("HEAD") ?? "",
        branch: branch?.replace(/^refs\/heads\//, ""),
        bare: flags.has("bare"),
        detached: flags.has("detached"),
        lockedReason: values.get("locked") || (flags.has("locked") ? "已锁定" : undefined),
        prunableReason: values.get("prunable") || (flags.has("prunable") ? "可清理" : undefined)
      };
    });
}

function parseSubmoduleStatus(output: string): Array<Omit<GitSubmoduleInfo, "url" | "branch">> {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line): Omit<GitSubmoduleInfo, "url" | "branch"> => {
      const match = line.match(/^([ +\-U])([0-9a-f]+)\s+(.+?)(?:\s+\((.*)\))?$/i);
      if (!match) {
        throw new Error(`无法解析子模块状态：${line}`);
      }
      const [, marker, hash, submodulePath, description] = match;
      const state: GitSubmoduleState =
        marker === "-" ? "uninitialized" : marker === "+" ? "modified" : marker === "U" ? "conflicted" : "initialized";
      return {
        path: submodulePath,
        hash,
        state,
        description: description || undefined
      };
    });
}

function parseSubmoduleConfig(output: string): Map<string, { url: string; branch?: string }> {
  const byName = new Map<string, { path?: string; url?: string; branch?: string }>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^submodule\.(.+)\.(path|url|branch)\s+(.+)$/);
    if (!match) {
      throw new Error(`无法解析 .gitmodules 配置：${line}`);
    }
    const [, name, key, value] = match;
    byName.set(name, { ...byName.get(name), [key]: value });
  }

  const byPath = new Map<string, { url: string; branch?: string }>();
  for (const [name, item] of byName) {
    if (!item.path || !item.url) {
      throw new Error(`子模块 ${name} 的 path 或 url 配置不完整。`);
    }
    byPath.set(item.path, { url: item.url, branch: item.branch });
  }
  return byPath;
}

function parseLfsStatus(output: string): GitLfsFileStatus[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Git LFS 返回了无法解析的状态数据。");
  }
  if (!parsed || typeof parsed !== "object" || !("files" in parsed)) {
    throw new Error("Git LFS 状态数据缺少 files 字段。");
  }
  const files = (parsed as { files: unknown }).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Git LFS 状态数据中的 files 字段格式不正确。");
  }

  return Object.entries(files).map(([filePath, value]): GitLfsFileStatus => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Git LFS 文件状态格式不正确：${filePath}`);
    }
    const record = value as Record<string, unknown>;
    return {
      path: filePath,
      status: typeof record.status === "string" ? record.status : undefined,
      staged: record.staged === true
    };
  });
}

function parseGitBoolean(value: string, key: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }
  throw new Error(`仓库配置 ${key} 不是有效的布尔值。`);
}

function isGitSigningFormat(value: string): value is GitSigningFormat {
  return value === "openpgp" || value === "ssh" || value === "x509";
}

export function parseHostedRemoteUrl(remoteUrl: string, commitHash?: string, branchName?: string): GitHostingLinks | null {
  const source = remoteUrl.trim();
  if (!source) {
    return null;
  }

  let host = "";
  let repositoryPath = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      host = url.hostname.toLowerCase();
      repositoryPath = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else {
    const scpMatch = source.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
    if (!scpMatch) {
      return null;
    }
    host = scpMatch[1].toLowerCase();
    repositoryPath = scpMatch[2];
  }

  if (host.startsWith("www.")) {
    host = host.slice(4);
  }
  const provider: GitHostingProvider | undefined =
    host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : host === "gitee.com" ? "gitee" : undefined;
  if (!provider) {
    return null;
  }

  const segments = repositoryPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const repositoryName = segments.at(-1)!;
  const ownerSegments = segments.slice(0, -1);
  const encodedRepositoryPath = segments.map(encodeURIComponent).join("/");
  const repositoryUrl = `https://${host}/${encodedRepositoryPath}`;
  const commit = commitHash?.trim();
  const branch = branchName?.trim();
  const commitPrefix = provider === "gitlab" ? "-/commit" : "commit";
  const branchPrefix = provider === "gitlab" ? "-/tree" : "tree";
  const encodedBranch = branch ? branch.split("/").map(encodeURIComponent).join("/") : undefined;
  const commitsPrefix = provider === "gitlab" ? "-/commits" : "commits";
  const branchesPrefix = provider === "gitlab" ? "-/branches" : "branches";
  const pullRequestsPrefix = provider === "gitlab" ? "-/merge_requests" : "pulls";
  const issuesPrefix = provider === "gitlab" ? "-/issues" : "issues";

  return {
    provider,
    ownerPath: ownerSegments.join("/"),
    repositoryName,
    repositoryUrl,
    commitsUrl: `${repositoryUrl}/${commitsPrefix}${encodedBranch ? `/${encodedBranch}` : ""}`,
    branchesUrl: `${repositoryUrl}/${branchesPrefix}`,
    pullRequestsUrl: `${repositoryUrl}/${pullRequestsPrefix}`,
    issuesUrl: `${repositoryUrl}/${issuesPrefix}`,
    commitUrl: commit ? `${repositoryUrl}/${commitPrefix}/${encodeURIComponent(commit)}` : undefined,
    branchUrl: encodedBranch ? `${repositoryUrl}/${branchPrefix}/${encodedBranch}` : undefined
  };
}

function gitFailure(command: string, messageZh: string, stderr = ""): GitOperationResult {
  return {
    ok: false,
    command,
    stdout: "",
    stderr,
    exitCode: -1,
    messageZh
  };
}

export function normalizeRepositoryTarget(location: RepositoryLocation): RepositoryTarget {
  if (typeof location === "string") {
    return { path: location };
  }
  if (!location || typeof location.path !== "string" || !location.path.trim()) {
    throw new Error("仓库路径不能为空。");
  }
  if (!location.remote) {
    return { path: location.path };
  }
  if (location.remote.connectionEnabled === false) {
    throw new Error("远程连接已暂停，请先开启连接。");
  }
  if (
    location.remote.type !== "ssh" ||
    typeof location.remote.host !== "string" ||
    (location.remote.username !== undefined && typeof location.remote.username !== "string") ||
    (location.remote.port !== undefined && typeof location.remote.port !== "number") ||
    (location.remote.identityFile !== undefined && typeof location.remote.identityFile !== "string")
  ) {
    throw new Error("SSH 连接信息格式不正确。");
  }

  const input: RemoteProjectInput = {
    host: location.remote.host,
    username: location.remote.username,
    port: location.remote.port,
    repositoryPath: location.path,
    identityFile: location.remote.identityFile
  };
  const validationError = validateRemoteProjectInput(input);
  if (validationError) {
    throw new Error(validationError);
  }

  return {
    path: input.repositoryPath.trim().replace(/\\/g, "/"),
    remote: {
      type: "ssh",
      host: input.host.trim(),
      username: input.username?.trim() || undefined,
      port: input.port,
      identityFile: input.identityFile?.trim() || undefined,
      connectionEnabled: true
    }
  };
}

export function sshDestination(connection: SshConnection): string {
  return connection.username ? `${connection.username}@${connection.host}` : connection.host;
}

export function buildSshArgs(connection: SshConnection, batchMode = false): string[] {
  const args = ["-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
  if (batchMode) {
    args.push("-T", "-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0");
  }
  if (connection.port) {
    args.push("-p", String(connection.port));
  }
  if (connection.identityFile) {
    args.push("-o", "IdentitiesOnly=yes", "-i", connection.identityFile);
  }
  args.push(sshDestination(connection));
  return args;
}

function buildRemoteGitCommand(repositoryPath: string, args: string[]): string {
  return [
    "env",
    "GIT_TERMINAL_PROMPT=0",
    "GIT_PAGER=cat",
    "LC_ALL=C.UTF-8",
    "LANG=C.UTF-8",
    "git",
    "-c",
    "core.quotepath=false",
    "-c",
    "i18n.commitEncoding=utf-8",
    "-c",
    "i18n.logOutputEncoding=utf-8",
    "-C",
    repositoryPath,
    ...args
  ]
    .map(shellQuote)
    .join(" ");
}

function isReadOnlyGitCommand(args: string[]): boolean {
  let index = 0;
  while (args[index] === "-c" && typeof args[index + 1] === "string") {
    index += 2;
  }
  const command = args[index];
  if (!command) {
    return false;
  }
  if (readOnlyGitCommands.has(command)) {
    return true;
  }
  if (command === "config") {
    const configArgs = args.slice(index + 1);
    return configArgs.includes("--get") || configArgs.includes("--get-all");
  }
  if (command === "remote") {
    return args.length === index + 1 || args[index + 1] === "-v" || args[index + 1] === "get-url";
  }
  if (command === "stash") {
    return args[index + 1] === "list";
  }
  if (command === "worktree") {
    return args[index + 1] === "list";
  }
  if (command === "submodule") {
    return args[index + 1] === "status";
  }
  if (command === "lfs") {
    return args[index + 1] === "version" || args[index + 1] === "status";
  }
  return false;
}

function isCommitHash(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function validateRemoteProjectInput(input: RemoteProjectInput): string | undefined {
  const host = input.host.trim();
  const username = input.username?.trim();
  const repositoryPath = input.repositoryPath.trim().replace(/\\/g, "/");
  if (!host) {
    return "请输入 SSH 主机或 SSH 配置别名。";
  }
  if (!/^[a-z0-9._:-]+$/i.test(host) || host.startsWith("-")) {
    return "SSH 主机格式不正确。";
  }
  if (username && !/^[a-z0-9._-]+$/i.test(username)) {
    return "SSH 用户名格式不正确。";
  }
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    return "SSH 端口必须是 1 到 65535 之间的整数。";
  }
  if (!repositoryPath.startsWith("/")) {
    return "远程仓库路径必须是服务器上的绝对路径。";
  }
  if (repositoryPath.includes("\0")) {
    return "远程仓库路径包含无效字符。";
  }
  return undefined;
}

function runSshShell(
  connection: SshConnection,
  remoteCommand: string,
  options: { timeoutMs?: number; stdin?: Buffer } = {}
): Promise<Omit<GitOperationResult, "stdout"> & { stdout: Buffer }> {
  return new Promise((resolve) => {
    const command = `ssh ${sshDestination(connection)} -- ${remoteCommand}`;
    const child = spawn("ssh", [...buildSshArgs(connection, true), remoteCommand], {
      cwd: process.cwd(),
      env: createGitEnv(),
      shell: false,
      windowsHide: true
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const finish = (result: Omit<GitOperationResult, "stdout"> & { stdout: Buffer }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(result);
    };
    const timeoutId = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          const timeoutText = `SSH command timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s.`;
          const stderrText = decodeGitOutput(Buffer.concat(stderrChunks));
          finish({
            ok: false,
            command,
            stdout: Buffer.concat(stdoutChunks),
            stderr: stderrText ? `${stderrText}\n${timeoutText}` : timeoutText,
            exitCode: -1,
            messageZh: "远程文件操作超时，请检查 SSH 连接后重试。"
          });
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      finish({
        ok: false,
        command,
        stdout: Buffer.concat(stdoutChunks),
        stderr: error.message,
        exitCode: -1,
        messageZh: "无法执行 SSH，请确认本机已安装 OpenSSH 并加入 PATH。"
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      const stderr = decodeGitOutput(Buffer.concat(stderrChunks));
      finish({
        ok: exitCode === 0,
        command,
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        exitCode,
        messageZh: exitCode === 0 ? undefined : toChineseSshError(stderr)
      });
    });
    child.stdin.end(options.stdin);
  });
}

function validateRemoteMergeStatus(status: GitStatusSummary, requireDivergence = false): GitOperationResult | undefined {
  if (status.operationState || status.hasConflicts) {
    return gitFailure("git merge", "当前已有 Git 操作或冲突未完成，请先继续或终止当前操作。");
  }
  if (status.stagedCount + status.unstagedCount + status.untrackedCount > 0) {
    return gitFailure("git merge", "合并远程更改前必须保持工作区干净，请先提交、暂存到 stash 或丢弃当前改动。");
  }
  if (!status.currentBranch) {
    return gitFailure("git merge", "当前是分离 HEAD 状态，无法合并远程更改。");
  }
  if (!status.upstream) {
    return gitFailure("git merge", "当前分支没有关联远程分支，无法合并远程更改。");
  }
  if (requireDivergence && status.behind > 0 && status.ahead === 0) {
    return gitFailure("git merge", "当前分支只落后远程，请使用拉取操作完成快进更新。");
  }
  return undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function combineGitResults(results: GitOperationResult[], ok: boolean): GitOperationResult {
  const failedResult = results.find((result) => !result.ok);
  return {
    ok,
    command: results.map((result) => result.command).filter(Boolean).join(" ; "),
    stdout: results.map((result) => result.stdout).filter(Boolean).join("\n"),
    stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
    exitCode: ok ? 0 : failedResult?.exitCode ?? -1,
    messageZh: ok ? undefined : failedResult?.messageZh
  };
}

function acceptAbsentConfigResult(result: GitOperationResult): GitOperationResult {
  if (result.ok || result.exitCode !== 5) {
    return result;
  }
  return {
    ...result,
    ok: true,
    stderr: "",
    messageZh: undefined
  };
}

function gitTransactionFailure(
  operationLabel: string,
  mutationResults: GitOperationResult[],
  rollbackResults: GitOperationResult[]
): GitOperationResult {
  const combined = combineGitResults([...mutationResults, ...rollbackResults], false);
  const mutationFailure = mutationResults.find((result) => !result.ok);
  const rollbackFailure = rollbackResults.find((result) => !result.ok);
  const failureMessage = mutationFailure?.messageZh || mutationFailure?.stderr.trim() || "Git 命令执行失败。";
  return {
    ...combined,
    messageZh: rollbackFailure
      ? `${operationLabel}失败，且恢复原配置失败；仓库配置可能处于部分修改状态。原错误：${failureMessage}；恢复错误：${rollbackFailure.messageZh || rollbackFailure.stderr.trim() || "Git 命令执行失败。"}`
      : rollbackResults.length > 0
        ? `${operationLabel}失败，已恢复原配置。原错误：${failureMessage}`
        : failureMessage
  };
}

export function validateGitIdentity(name?: string, email?: string): GitIdentityValidationIssue[] {
  const issues: GitIdentityValidationIssue[] = [];
  const normalizedName = name?.trim() ?? "";
  const normalizedEmail = email?.trim() ?? "";
  if (!normalizedName) {
    issues.push({ field: "name", messageZh: "Git 提交姓名不能为空。" });
  } else if (/[\u0000-\u001f\u007f]/.test(normalizedName)) {
    issues.push({ field: "name", messageZh: "Git 提交姓名不能包含控制字符或换行。" });
  }
  if (!normalizedEmail) {
    issues.push({ field: "email", messageZh: "Git 提交邮箱不能为空。" });
  } else if (!/^[^\s<>@]+@[^\s<>@]+$/.test(normalizedEmail) || /[\u0000-\u001f\u007f]/.test(normalizedEmail)) {
    issues.push({ field: "email", messageZh: "Git 提交邮箱格式不正确。" });
  }
  return issues;
}

function requireContentRevision(value: string): string {
  const revision = requireValue(value, "文件内容版本");
  if (revision !== "missing" && !/^git:[0-9a-f]{40,64}$/i.test(revision)) {
    throw new Error("文件内容版本格式不正确，请刷新后重试。");
  }
  return revision.toLowerCase();
}

function conflictBufferToken(buffer: Buffer | null): Buffer {
  if (!buffer) {
    return Buffer.from("missing\0");
  }
  return Buffer.concat([Buffer.from(`${buffer.byteLength}\0`), buffer]);
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function isEditableConflictSnapshot(snapshot: ConflictSnapshot): boolean {
  const buffers = [snapshot.base, snapshot.current, snapshot.incoming, snapshot.result].filter((value): value is Buffer => Boolean(value));
  return !buffers.some(isBinaryBuffer) && buffers.every((buffer) => buffer.byteLength <= maxEditableConflictBytes);
}

function containsConflictMarkers(content: string): boolean {
  return /^<<<<<<<[^\r\n]*\r?$[\s\S]*?^======\=\r?$[\s\S]*?^>>>>>>>[^\r\n]*\r?$/m.test(content);
}

function resolveRepositoryFilePath(repositoryPath: RepositoryLocation, filePath: string): string {
  const target = normalizeRepositoryTarget(repositoryPath);
  const pathApi = target.remote ? path.posix : path;
  if (pathApi.isAbsolute(filePath)) {
    throw new Error("文件路径必须位于当前仓库内。");
  }

  const root = pathApi.resolve(target.path);
  const resolved = pathApi.resolve(root, filePath);
  const relative = pathApi.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new Error("文件路径超出当前仓库范围。");
  }
  return resolved;
}

function resolveGitReportedPath(repositoryPath: RepositoryLocation, reportedPath: string): string {
  const target = normalizeRepositoryTarget(repositoryPath);
  const pathApi = target.remote ? path.posix : path;
  return pathApi.isAbsolute(reportedPath) ? pathApi.normalize(reportedPath) : pathApi.resolve(target.path, reportedPath);
}

function parseStatus(output: string): GitStatusSummary {
  const summary: GitStatusSummary = {
    currentBranch: null,
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    hasConflicts: false,
    conflictedCount: 0
  };

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    if (line.startsWith("# branch.head ")) {
      const branch = line.replace("# branch.head ", "").trim();
      summary.currentBranch = branch === "(detached)" ? null : branch;
      continue;
    }

    if (line.startsWith("# branch.oid ")) {
      const headHash = line.replace("# branch.oid ", "").trim();
      if (headHash === "(initial)") {
        summary.unborn = true;
      } else if (headHash) {
        summary.headHash = headHash;
      }
      continue;
    }

    if (line.startsWith("# branch.upstream ")) {
      summary.upstream = line.replace("# branch.upstream ", "").trim();
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        summary.ahead = Number(match[1]);
        summary.behind = Number(match[2]);
      }
      continue;
    }

    if (line.startsWith("? ")) {
      summary.untrackedCount += 1;
      continue;
    }

    if (line.startsWith("! ")) {
      continue;
    }

    if (line.startsWith("u ")) {
      summary.hasConflicts = true;
      summary.conflictedCount += 1;
      continue;
    }

    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      if (xy[0] !== "." && xy[0] !== " ") {
        summary.stagedCount += 1;
      }
      if (xy[1] !== "." && xy[1] !== " ") {
        summary.unstagedCount += 1;
      }
    }
  }

  return summary;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function parseCommitLog(output: string): CommitNode[] {
  const laneByKey = new Map<string, number>();

  return output
    .split(recordSeparator)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const fields = record.split(fieldSeparator);
      const refs = parseRefs(fields[8] ?? "");
      const laneKey = refs.find((ref) => ref.type === "localBranch" || ref.type === "remoteBranch")?.name ?? fields[1]?.split(" ")[0] ?? fields[0];
      const lane = getLane(laneByKey, laneKey);

      return {
        hash: fields[0],
        shortHash: fields[0]?.slice(0, 7) ?? "",
        parents: fields[1] ? fields[1].split(" ").filter(Boolean) : [],
        authorName: fields[2] ?? "",
        authorEmail: fields[3] ?? "",
        authorDate: formatIsoDate(fields[4]),
        committerName: fields[5] ?? "",
        committerEmail: fields[6] ?? "",
        committerDate: formatIsoDate(fields[7]),
        refs,
        subject: fields[9] ?? "(无提交信息)",
        body: fields.slice(10).join(fieldSeparator).trim(),
        lane,
        color: graphColors[lane % graphColors.length],
        files: []
      };
    });
}

function parseRefs(refText: string): CommitRef[] {
  if (!refText.trim()) {
    return [];
  }

  return refText
    .split(",")
    .map((part) => part.trim())
    .flatMap((part): CommitRef[] => {
      if (part === "HEAD") {
        return [{ type: "head", name: "HEAD" }];
      }

      const pointsFromHead = part.startsWith("HEAD -> ");
      const normalized = part.replace(/^HEAD -> /, "");
      const refs: CommitRef[] = pointsFromHead ? [{ type: "head", name: "HEAD" }] : [];

      if (normalized === "HEAD" || normalized === "origin/HEAD" || normalized.endsWith("/HEAD")) {
        return refs;
      }

      if (normalized.startsWith("tag: refs/tags/")) {
        refs.push({ type: "tag", name: normalized.replace("tag: refs/tags/", "") });
        return refs;
      }

      if (normalized.startsWith("tag: ")) {
        refs.push({ type: "tag", name: normalized.replace("tag: ", "") });
        return refs;
      }

      if (normalized.startsWith("refs/heads/")) {
        refs.push({ type: "localBranch", name: normalized.replace("refs/heads/", "") });
        return refs;
      }

      if (normalized.startsWith("refs/remotes/")) {
        refs.push({ type: "remoteBranch", name: normalized.replace("refs/remotes/", "") });
        return refs;
      }

      if (normalized.startsWith("origin/") || normalized.includes("/")) {
        refs.push({ type: "remoteBranch", name: normalized });
        return refs;
      }

      refs.push({ type: "localBranch", name: normalized });
      return refs;
    });
}

function getLane(laneByKey: Map<string, number>, laneKey: string): number {
  if (!laneByKey.has(laneKey)) {
    laneByKey.set(laneKey, laneByKey.size % 4);
  }

  return laneByKey.get(laneKey) ?? 0;
}

function parseNameStatus(output: string): ChangedFile[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [statusCode, firstPath, secondPath] = line.split(/\t/);
      const status = statusFromCode(statusCode[0]);
      return {
        path: secondPath ?? firstPath,
        oldPath: secondPath ? firstPath : undefined,
        status,
        staged: false
      };
    });
}

function parseWorktree(output: string): WorktreeState {
  const stagedFiles: ChangedFile[] = [];
  const unstagedFiles: ChangedFile[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line || line.startsWith("# ")) {
      continue;
    }

    if (line.startsWith("? ")) {
      continue;
    }

    if (line.startsWith("! ")) {
      continue;
    }

    if (line.startsWith("u ")) {
      const path = extractUnmergedPorcelainPath(line);
      unstagedFiles.push({ path, status: "conflicted", staged: false });
      continue;
    }

    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      const paths = extractPorcelainPaths(line, line.startsWith("2 "));

      if (xy[0] !== "." && xy[0] !== " ") {
        stagedFiles.push({
          path: paths.path,
          oldPath: paths.oldPath,
          status: statusFromCode(xy[0]),
          staged: true
        });
      }

      if (xy[1] !== "." && xy[1] !== " ") {
        unstagedFiles.push({
          path: paths.path,
          oldPath: paths.oldPath,
          status: statusFromCode(xy[1]),
          staged: false
        });
      }
    }
  }

  return { stagedFiles, unstagedFiles };
}

function sortWorktree(worktree: WorktreeState): WorktreeState {
  return {
    stagedFiles: worktree.stagedFiles.sort(compareFiles),
    unstagedFiles: worktree.unstagedFiles.sort(compareFiles)
  };
}

function compareFiles(left: ChangedFile, right: ChangedFile): number {
  return left.path.localeCompare(right.path, "zh-CN", { sensitivity: "base" });
}

function compareBranches(left: BranchInfo, right: BranchInfo): number {
  if (left.current !== right.current) {
    return left.current ? -1 : 1;
  }

  if (left.type !== right.type) {
    return left.type === "local" ? -1 : 1;
  }

  return left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
}

function compareHistoryRefs(left: GitHistoryRef, right: GitHistoryRef): number {
  if (left.current !== right.current) {
    return left.current ? -1 : 1;
  }

  if (left.upstream !== right.upstream) {
    return left.upstream ? -1 : 1;
  }

  const typeOrder: Record<GitHistoryRef["type"], number> = {
    branch: 0,
    remoteBranch: 1,
    tag: 2
  };
  if (typeOrder[left.type] !== typeOrder[right.type]) {
    return typeOrder[left.type] - typeOrder[right.type];
  }

  return left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
}

function createFilePreview(content: Buffer, media: { type: FilePreview["type"]; mimeType: string }, sourceDescription: string): FilePreview {
  const maxBytes = media.type === "video" ? maxPreviewVideoBytes : maxPreviewImageBytes;
  if (content.byteLength > maxBytes) {
    const label = media.type === "video" ? "视频" : "图片";
    throw new Error(`${label}文件过大，暂不在查看区预览。`);
  }

  return {
    type: media.type,
    mimeType: media.mimeType,
    dataUrl: `data:${media.mimeType};base64,${content.toString("base64")}`,
    sizeBytes: content.byteLength,
    sourceDescription
  };
}

function previewMediaFromPath(filePath: string): { type: FilePreview["type"]; mimeType: string } | undefined {
  const extension = filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png":
      return { type: "image", mimeType: "image/png" };
    case "apng":
      return { type: "image", mimeType: "image/apng" };
    case "jpg":
    case "jpeg":
    case "jfif":
      return { type: "image", mimeType: "image/jpeg" };
    case "gif":
      return { type: "image", mimeType: "image/gif" };
    case "webp":
      return { type: "image", mimeType: "image/webp" };
    case "svg":
      return { type: "image", mimeType: "image/svg+xml" };
    case "bmp":
      return { type: "image", mimeType: "image/bmp" };
    case "ico":
      return { type: "image", mimeType: "image/x-icon" };
    case "avif":
      return { type: "image", mimeType: "image/avif" };
    case "mp4":
    case "m4v":
      return { type: "video", mimeType: "video/mp4" };
    case "mov":
      return { type: "video", mimeType: "video/quicktime" };
    case "webm":
      return { type: "video", mimeType: "video/webm" };
    case "ogv":
    case "ogg":
      return { type: "video", mimeType: "video/ogg" };
    case "mpeg":
    case "mpg":
      return { type: "video", mimeType: "video/mpeg" };
    case "mkv":
      return { type: "video", mimeType: "video/x-matroska" };
    case "avi":
      return { type: "video", mimeType: "video/x-msvideo" };
    default:
      return undefined;
  }
}

function toGitPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function extractPorcelainPaths(line: string, hasOriginalPath: boolean): { path: string; oldPath?: string } {
  const pathStartIndex = findNthSpace(line, hasOriginalPath ? 9 : 8);
  const rawPath = pathStartIndex >= 0 ? line.slice(pathStartIndex + 1) : "";

  if (hasOriginalPath) {
    const [pathValue, oldPath] = rawPath.split("\t");
    return { path: pathValue, oldPath };
  }

  return { path: rawPath };
}

function extractUnmergedPorcelainPath(line: string): string {
  const pathStartIndex = findNthSpace(line, 10);
  return pathStartIndex >= 0 ? line.slice(pathStartIndex + 1) : "";
}

function findNthSpace(value: string, count: number): number {
  let position = -1;
  for (let index = 0; index < count; index += 1) {
    position = value.indexOf(" ", position + 1);
    if (position === -1) {
      break;
    }
  }
  return position;
}

function parseUnifiedDiff(output: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const line of output.split(/\r?\n/)) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLineNumber = Number(hunk[1]);
      newLineNumber = Number(hunk[2]);
      continue;
    }

    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }

    if (line.startsWith("+")) {
      lines.push({ type: "add", newLineNumber, content: line.slice(1) });
      newLineNumber += 1;
      continue;
    }

    if (line.startsWith("-")) {
      lines.push({ type: "delete", oldLineNumber, content: line.slice(1) });
      oldLineNumber += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      lines.push({ type: "context", oldLineNumber, newLineNumber, content: line.slice(1) });
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  }

  return lines;
}

function emitOperationChunk(context: GitLongOperationContext, chunk: Buffer): void {
  const text = decodeGitOutput(chunk)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!text) {
    return;
  }
  const percentMatch = text.match(/(?:^|\s)(\d{1,3})%/);
  const objectMatch = text.match(/\((\d+)\/(\d+)\)/);
  context.onProgress(operationProgress(
    context,
    "running",
    sanitizeOperationMessage(text),
    percentMatch ? Math.max(0, Math.min(100, Number(percentMatch[1]))) : undefined,
    objectMatch ? Number(objectMatch[1]) : undefined,
    objectMatch ? Number(objectMatch[2]) : undefined
  ));
}

function operationProgress(
  context: GitLongOperationContext,
  phase: GitLongOperationPhase,
  message: string,
  percent?: number,
  receivedObjects?: number,
  totalObjects?: number
): GitLongOperationProgress {
  return {
    id: context.id,
    kind: context.kind,
    phase,
    label: context.label,
    ...(context.repositoryPath ? { repositoryPath: context.repositoryPath } : {}),
    message,
    ...(percent === undefined ? {} : { percent }),
    ...(receivedObjects === undefined ? {} : { receivedObjects }),
    ...(totalObjects === undefined ? {} : { totalObjects }),
    updatedAt: new Date().toISOString()
  };
}

function sanitizeOperationMessage(value: string): string {
  return value
    .replace(/(https?:\/\/)[^@\s/]+@/gi, "$1")
    .replace(/([?&](?:access_token|auth|password|private_token|token)=)[^&\s]+/gi, "$1***")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, 320);
}

function statusFromCode(code: string): ChangedFile["status"] {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "?":
      return "untracked";
    case "!":
      return "ignored";
    case "U":
      return "conflicted";
    case "M":
    default:
      return "modified";
  }
}

async function walk(currentPath: string, depth: number, maxDepth: number, found: string[]): Promise<void> {
  if (depth > maxDepth) {
    return;
  }

  if (await hasGitDirectory(currentPath)) {
    found.push(currentPath);
    return;
  }

  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !skippedDirectoryNames.has(entry.name))
      .map((entry) => walk(path.join(currentPath, entry.name), depth + 1, maxDepth, found))
  );
}

async function hasGitDirectory(candidatePath: string): Promise<boolean> {
  try {
    await access(path.join(candidatePath, ".git"));
    return true;
  } catch {
    return false;
  }
}

function formatIsoDate(value?: string): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function isEmptyRepositoryError(stderr: string): boolean {
  return stderr.includes("does not have any commits yet") || stderr.includes("bad default revision");
}

function toChineseSshError(stderr: string): string {
  const text = stderr.toLowerCase();
  if (text.includes("host key verification failed")) {
    return "SSH 主机指纹尚未确认或已发生变化，请在“连接远程仓库”面板核对并确认指纹。";
  }
  if (text.includes("permission denied")) {
    return "SSH 认证失败，请检查用户名、SSH Agent、私钥和服务器授权。";
  }
  if (text.includes("could not resolve hostname") || text.includes("name or service not known")) {
    return "无法解析 SSH 主机，请检查主机名或 SSH 配置别名。";
  }
  if (text.includes("connection refused")) {
    return "SSH 连接被服务器拒绝，请检查主机、端口和 SSH 服务状态。";
  }
  if (text.includes("connection timed out") || text.includes("operation timed out")) {
    return "SSH 连接超时，请检查服务器地址、端口和网络。";
  }
  if (text.includes("not a git repository")) {
    return "远程路径不是 Git 仓库。";
  }
  if (text.includes("git: command not found") || text.includes("git: not found")) {
    return "远程服务器未安装 Git，或 Git 不在远程 PATH 中。";
  }
  return toChineseGitError("", stderr);
}

function toChineseGitError(stdout: string, stderr: string): string {
  const text = `${stdout}\n${stderr}`.toLowerCase();

  if (text.includes("authentication failed") || text.includes("permission denied")) {
    return "认证失败，请检查账号权限、SSH key 或 Git Credential 配置。";
  }

  if (text.includes("not a git repository")) {
    return "当前目录不是 Git 仓库。";
  }

  if (text.includes("non-fast-forward")) {
    return "远程分支包含本地没有的提交。请先 fetch 后合并或 rebase；仅在确认本地已改写历史且远程分支未被他人更新时，使用安全强制推送（--force-with-lease）。";
  }

  if (text.includes("not possible because you have unmerged files") || text.includes("unmerged files")) {
    return "仍有冲突文件未解决或未暂存，请处理所有冲突并暂存后再继续。";
  }

  if (text.includes("has no upstream branch")) {
    return "当前分支还没有关联远程分支，请先执行首次推送并设置 upstream。";
  }

  if (text.includes("merge conflict") || text.includes("conflict")) {
    return "操作产生冲突，请先解决冲突文件，然后继续或终止操作。";
  }

  if (text.includes("pathspec")) {
    return "找不到指定分支、提交或文件，请确认名称是否正确。";
  }

  if (isEmptyRepositoryError(stderr)) {
    return "当前仓库还没有提交。";
  }

  return "Git 命令执行失败，请展开原始输出查看详细原因。";
}
