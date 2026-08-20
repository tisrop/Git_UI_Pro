import { net } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ReleaseHistoryItem } from "./releaseHistory";
import {
  PORTABLE_UPDATE_DIRECTORY_NAME,
  PORTABLE_UPDATE_HEALTH_MARKER_ENV,
  PORTABLE_UPDATE_HEALTH_TOKEN_ENV,
  type PortableRuntime
} from "./portableRuntime";
import { githubReleaseUrl, normalizeReleaseNotes } from "./updateUtils";

const GITHUB_RELEASE_OWNER = "zjx150504-lgtm";
const GITHUB_RELEASE_REPOSITORY = "Git_UI_Pro";
const GITEE_RELEASE_OWNER = "zjx_master";
const GITEE_RELEASE_REPOSITORY = "git-ui-pro";
const UPDATE_MANIFEST_NAME = "update-manifest.json";
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_DIGEST_PATTERN = /^sha256:([a-f\d]{64})$/i;
const MAX_RELEASE_NOTES_LENGTH = 12_000;
const MAX_HISTORY_ENTRIES = 3;

type StableVersion = Readonly<{
  value: string;
  parts: readonly [bigint, bigint, bigint];
}>;

export type PortableUpdateTarget = Readonly<{
  version: string;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  releaseUrl: string;
  artifactName: string;
  downloadUrl: string;
  downloadSources?: readonly PortableDownloadSource[];
  size: number;
  sha256: string;
}>;

export type PortableDownloadSourceId = "gitee" | "github";

export type PortableDownloadSource = Readonly<{
  id: PortableDownloadSourceId;
  label: string;
  downloadUrl: string;
  releaseUrl: string;
}>;

export type PortableLatestStableRelease = Readonly<{
  version: string;
  tagName: string;
  target: PortableUpdateTarget | null;
}>;

export type PortableReleaseIdentity = Readonly<{
  version: string;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  releaseUrl: string;
}>;

export type PortableGiteeReleaseSummary = Readonly<{
  version: string;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  releaseUrl: string;
  artifactName: string;
  artifactUrl: string;
  manifestUrl: string;
}>;

export type PortableDownloadProgress = Readonly<{
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  sourceId?: PortableDownloadSourceId;
  sourceLabel?: string;
  sourceReleaseUrl?: string;
  resumed?: boolean;
}>;

type PortableFetch = (
  url: string,
  init: {
    method: "GET";
    redirect: "follow";
    headers: Record<string, string>;
    signal: AbortSignal;
  }
) => Promise<Response>;

export type PortableDownloadOptions = Readonly<{
  fetch?: PortableFetch;
  additionalTarget?: Promise<PortableUpdateTarget | null>;
  lowSpeedThresholdBytesPerSecond?: number;
  lowSpeedGraceMs?: number;
  lowSpeedWindowMs?: number;
  minRemainingBytesForSourceSwitch?: number;
  responseTimeoutMs?: number;
  stallTimeoutMs?: number;
}>;

const DEFAULT_LOW_SPEED_THRESHOLD_BYTES_PER_SECOND = 192 * 1024;
const DEFAULT_LOW_SPEED_GRACE_MS = 10_000;
const DEFAULT_LOW_SPEED_WINDOW_MS = 8_000;
const MIN_REMAINING_BYTES_FOR_SOURCE_SWITCH = 4 * 1024 * 1024;
const DEFAULT_SOURCE_RESPONSE_TIMEOUT_MS = 15_000;
const DEFAULT_SOURCE_STALL_TIMEOUT_MS = 20_000;

export class PortableReleaseCatalog {
  readonly entries: readonly ReleaseHistoryItem[];
  readonly #targets: ReadonlyMap<string, PortableUpdateTarget>;

  constructor(entries: readonly ReleaseHistoryItem[], targets: ReadonlyMap<string, PortableUpdateTarget>) {
    this.entries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    this.#targets = new Map(targets);
  }

  resolveTarget(version: string): PortableUpdateTarget | null {
    const normalized = stripVersionPrefix(version);
    const target = this.#targets.get(normalized);
    return target ? Object.freeze({ ...target }) : null;
  }
}

export function portableArtifactName(version: string): string {
  const parsed = parseStableVersion(stripVersionPrefix(version));
  if (!parsed) {
    throw new Error(`Portable 版本号无效：${version}`);
  }
  return `Git-UI-Pro-Portable-${parsed.value}-x64.exe`;
}

export function parseLatestPortableGithubRelease(
  value: unknown,
  currentVersion?: string
): PortableLatestStableRelease {
  const identity = parsePortableGithubReleaseIdentity(value);
  if (!identity) {
    throw new Error("GitHub latest 不是可用的 Portable 正式版本。");
  }
  const target = parsePortableGithubRelease(value);
  if (!target) {
    if (currentVersion && comparePortableVersions(identity.version, currentVersion) <= 0) {
      return Object.freeze({ version: identity.version, tagName: identity.tagName, target: null });
    }
    throw new Error("GitHub latest 不是可用的 Portable 正式版本，或便携版资产尚未就绪。");
  }
  return Object.freeze({ version: target.version, tagName: target.tagName, target });
}

export function parsePortableGithubReleaseIdentity(value: unknown): PortableReleaseIdentity | null {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false || typeof value.tag_name !== "string") {
    return null;
  }
  const tagMatch = /^v(.+)$/.exec(value.tag_name);
  const version = tagMatch ? parseStableVersion(tagMatch[1]) : null;
  const releaseDate = normalizeDate(value.published_at);
  if (!version || !releaseDate) {
    return null;
  }
  return Object.freeze({
    version: version.value,
    tagName: value.tag_name,
    releaseName: normalizeText(value.name) || `Git UI Pro v${version.value}`,
    releaseNotes: normalizeReleaseNotes(normalizeText(value.body)).slice(0, MAX_RELEASE_NOTES_LENGTH),
    releaseDate,
    releaseUrl: githubReleaseUrl(version.value)
  });
}

export function buildPortableGithubReleaseHistoryCatalog(
  rawReleases: unknown,
  currentVersion: string
): PortableReleaseCatalog {
  const current = requireStableVersion(currentVersion, "当前版本");
  if (!Array.isArray(rawReleases)) {
    throw new Error("GitHub Releases 响应格式无效：预期发布记录数组。");
  }
  const targets = new Map<string, PortableUpdateTarget>();
  for (const release of rawReleases) {
    const target = parsePortableGithubRelease(release);
    const version = target ? parseStableVersion(target.version) : null;
    if (!target || !version || compareStableVersions(version, current) >= 0 || targets.has(target.version)) {
      continue;
    }
    targets.set(target.version, target);
  }
  return portableCatalogFromTargets([...targets.values()]);
}

export function parsePortableGiteeReleaseSummary(value: unknown): PortableGiteeReleaseSummary | null {
  const identity = parsePortableGiteeReleaseIdentity(value);
  if (!identity || !isRecord(value) || !Array.isArray(value.assets)) {
    return null;
  }

  const artifactName = portableArtifactName(identity.version);
  const artifactPath = giteeDownloadPath(identity.tagName, artifactName);
  const manifestPath = giteeDownloadPath(identity.tagName, UPDATE_MANIFEST_NAME);
  let artifactUrl: string | null = null;
  let manifestUrl: string | null = null;
  for (const item of value.assets) {
    if (!isRecord(item) || typeof item.browser_download_url !== "string") {
      continue;
    }
    if (item.name === artifactName) {
      artifactUrl = parseExactDownloadUrl(item.browser_download_url, "gitee.com", artifactPath);
    }
    if (item.name === UPDATE_MANIFEST_NAME) {
      manifestUrl = parseExactDownloadUrl(item.browser_download_url, "gitee.com", manifestPath);
    }
  }
  if (!artifactUrl || !manifestUrl) {
    return null;
  }

  return Object.freeze({
    version: identity.version,
    tagName: identity.tagName,
    releaseName: identity.releaseName,
    releaseNotes: identity.releaseNotes,
    releaseDate: identity.releaseDate,
    releaseUrl: identity.releaseUrl,
    artifactName,
    artifactUrl,
    manifestUrl
  });
}

export function parsePortableGiteeReleaseIdentity(value: unknown): PortableReleaseIdentity | null {
  if (!isRecord(value) || value.prerelease !== false || typeof value.tag_name !== "string") {
    return null;
  }
  const tagMatch = /^v(.+)$/.exec(value.tag_name);
  const version = tagMatch ? parseStableVersion(tagMatch[1]) : null;
  const releaseDate = normalizeDate(value.created_at);
  if (!version || !releaseDate) {
    return null;
  }
  return Object.freeze({
    version: version.value,
    tagName: value.tag_name,
    releaseName: normalizeText(value.name) || `Git UI Pro v${version.value}`,
    releaseNotes: normalizeText(value.body).slice(0, MAX_RELEASE_NOTES_LENGTH),
    releaseDate,
    releaseUrl: `https://gitee.com/${GITEE_RELEASE_OWNER}/${GITEE_RELEASE_REPOSITORY}/releases/tag/${value.tag_name}`
  });
}

export function verifyPortableGiteeRelease(
  summary: PortableGiteeReleaseSummary,
  rawManifest: unknown
): PortableUpdateTarget {
  if (!isRecord(rawManifest) || !isRecord(rawManifest.portable)) {
    throw new Error(`Gitee v${summary.version} 的 Portable 更新清单格式无效。`);
  }
  const portable = rawManifest.portable;
  if (
    rawManifest.schemaVersion !== 1 ||
    rawManifest.version !== summary.version ||
    rawManifest.tagName !== summary.tagName ||
    portable.name !== summary.artifactName ||
    typeof portable.size !== "number" ||
    !Number.isSafeInteger(portable.size) ||
    portable.size <= 0 ||
    typeof portable.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(portable.sha256)
  ) {
    throw new Error(`Gitee v${summary.version} 的 Portable 更新清单与发行版不匹配。`);
  }
  return Object.freeze({
    version: summary.version,
    tagName: summary.tagName,
    releaseName: summary.releaseName,
    releaseNotes: summary.releaseNotes,
    releaseDate: summary.releaseDate,
    releaseUrl: summary.releaseUrl,
    artifactName: summary.artifactName,
    downloadUrl: summary.artifactUrl,
    downloadSources: Object.freeze([
      createPortableDownloadSource("gitee", summary.artifactUrl, summary.releaseUrl)
    ]),
    size: portable.size,
    sha256: portable.sha256.toLowerCase()
  });
}

export function parseLatestPortableGiteeRelease(
  rawRelease: unknown,
  rawManifest: unknown,
  currentVersion?: string
): PortableLatestStableRelease {
  const identity = parsePortableGiteeReleaseIdentity(rawRelease);
  if (!identity) {
    throw new Error("Gitee latest 不是可用的 Portable 正式版本。");
  }
  const summary = parsePortableGiteeReleaseSummary(rawRelease);
  if (!summary) {
    if (currentVersion && comparePortableVersions(identity.version, currentVersion) <= 0) {
      return Object.freeze({ version: identity.version, tagName: identity.tagName, target: null });
    }
    throw new Error("Gitee latest 不是可用的 Portable 正式版本，或便携版资产尚未同步完成。");
  }
  let target: PortableUpdateTarget;
  try {
    target = verifyPortableGiteeRelease(summary, rawManifest);
  } catch (error) {
    if (currentVersion && comparePortableVersions(identity.version, currentVersion) <= 0) {
      return Object.freeze({ version: identity.version, tagName: identity.tagName, target: null });
    }
    throw error;
  }
  return Object.freeze({ version: target.version, tagName: target.tagName, target });
}

export function selectPortableGiteeHistoryCandidates(
  rawReleases: unknown,
  currentVersion: string,
  limit = 8
): PortableGiteeReleaseSummary[] {
  const current = requireStableVersion(currentVersion, "当前版本");
  if (!Array.isArray(rawReleases)) {
    throw new Error("Gitee Releases 响应格式无效：预期发布记录数组。");
  }
  const candidates = new Map<string, { version: StableVersion; summary: PortableGiteeReleaseSummary }>();
  for (const release of rawReleases) {
    const summary = parsePortableGiteeReleaseSummary(release);
    const version = summary ? parseStableVersion(summary.version) : null;
    if (!summary || !version || compareStableVersions(version, current) >= 0 || candidates.has(version.value)) {
      continue;
    }
    candidates.set(version.value, { version, summary });
  }
  return [...candidates.values()]
    .sort((left, right) => compareStableVersions(right.version, left.version))
    .slice(0, limit)
    .map(({ summary }) => summary);
}

export function buildPortableGiteeReleaseHistoryCatalog(
  targets: readonly PortableUpdateTarget[],
  currentVersion: string
): PortableReleaseCatalog {
  const current = requireStableVersion(currentVersion, "当前版本");
  return portableCatalogFromTargets(targets.filter((target) => {
    const version = parseStableVersion(target.version);
    return version && compareStableVersions(version, current) < 0;
  }));
}

export function comparePortableVersions(leftValue: string, rightValue: string): number {
  return compareStableVersions(
    requireStableVersion(leftValue, "版本号"),
    requireStableVersion(rightValue, "版本号")
  );
}

export function mergePortableUpdateTargets(
  preferred: PortableUpdateTarget,
  alternate: PortableUpdateTarget
): PortableUpdateTarget {
  if (
    preferred.version !== alternate.version ||
    preferred.tagName !== alternate.tagName ||
    preferred.artifactName !== alternate.artifactName ||
    preferred.size !== alternate.size ||
    preferred.sha256 !== alternate.sha256
  ) {
    throw new Error("Portable 双源更新资产不一致，已拒绝合并下载来源。");
  }
  return Object.freeze({
    ...preferred,
    downloadSources: Object.freeze(uniquePortableDownloadSources([
      ...portableDownloadSources(preferred),
      ...portableDownloadSources(alternate)
    ]))
  });
}

export function portablePrimaryDownloadSource(target: PortableUpdateTarget): PortableDownloadSource {
  return portableDownloadSources(target)[0];
}

export function withPortableFallbackSource(target: PortableUpdateTarget): PortableUpdateTarget {
  const normalizedArtifactName = portableArtifactName(target.version);
  if (target.tagName !== `v${target.version}` || target.artifactName !== normalizedArtifactName) {
    throw new Error("Portable 更新目标的版本、标签与文件名不一致。");
  }
  const githubSource = createPortableDownloadSource(
    "github",
    `https://github.com/${GITHUB_RELEASE_OWNER}/${GITHUB_RELEASE_REPOSITORY}/releases/download/${target.tagName}/${target.artifactName}`,
    githubReleaseUrl(target.version)
  );
  const giteeSource = createPortableDownloadSource(
    "gitee",
    `https://gitee.com/${GITEE_RELEASE_OWNER}/${GITEE_RELEASE_REPOSITORY}/releases/download/${target.tagName}/${target.artifactName}`,
    `https://gitee.com/${GITEE_RELEASE_OWNER}/${GITEE_RELEASE_REPOSITORY}/releases/tag/${target.tagName}`
  );
  const preferredSource = portablePrimaryDownloadSource(target).id === "gitee" ? giteeSource : githubSource;
  const fallbackSource = preferredSource.id === "gitee" ? githubSource : giteeSource;
  return Object.freeze({
    ...target,
    downloadUrl: preferredSource.downloadUrl,
    releaseUrl: preferredSource.releaseUrl,
    downloadSources: Object.freeze(uniquePortableDownloadSources([preferredSource, fallbackSource]))
  });
}

export async function downloadPortableUpdate(
  target: PortableUpdateTarget,
  runtime: PortableRuntime,
  signal: AbortSignal,
  onProgress: (progress: PortableDownloadProgress) => void,
  options: PortableDownloadOptions = {}
): Promise<string> {
  const executablePath = requirePortableExecutable(runtime);
  const stagingDirectory = path.join(path.dirname(executablePath), ".git-ui-pro-updates");
  await ensureDirectoryWritable(stagingDirectory);
  const partialPath = path.join(stagingDirectory, `${target.artifactName}.partial`);
  const stagedPath = path.join(stagingDirectory, `${target.artifactName}.ready`);
  const fetchImpl: PortableFetch = options.fetch ?? ((url, init) => net.fetch(url, init));
  const lowSpeedThreshold = options.lowSpeedThresholdBytesPerSecond ?? DEFAULT_LOW_SPEED_THRESHOLD_BYTES_PER_SECOND;
  const lowSpeedGraceMs = options.lowSpeedGraceMs ?? DEFAULT_LOW_SPEED_GRACE_MS;
  const lowSpeedWindowMs = options.lowSpeedWindowMs ?? DEFAULT_LOW_SPEED_WINDOW_MS;
  const minRemainingBytesForSourceSwitch = options.minRemainingBytesForSourceSwitch ?? MIN_REMAINING_BYTES_FOR_SOURCE_SWITCH;
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_SOURCE_RESPONSE_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_SOURCE_STALL_TIMEOUT_MS;

  throwIfPortableDownloadAborted(signal);
  if (await validatePortableFile(stagedPath, target)) {
    onProgress(portableProgress(target, target.size, 0, portablePrimaryDownloadSource(target), false));
    return stagedPath;
  }
  await rm(stagedPath, { force: true });

  let transferred = await portablePartialSize(partialPath, target.size);
  if (transferred === target.size) {
    if (await validatePortableFile(partialPath, target)) {
      await rename(partialPath, stagedPath);
      onProgress(portableProgress(target, target.size, 0, portablePrimaryDownloadSource(target), true));
      return stagedPath;
    }
    await rm(partialPath, { force: true });
    transferred = 0;
  }
  let digest = await seedPortableDigest(partialPath, transferred);
  const initialTransferred = transferred;
  const knownSources = new Map<string, PortableDownloadSource>();
  const sourceQueue: PortableDownloadSource[] = [];
  const attemptedSources = new Set<string>();
  const failures: string[] = [];
  let sawRangeUnsupported = false;
  let restartedFromZero = false;
  let forcedCompletionAttempted = false;
  let slowSource: PortableDownloadSource | null = null;

  const addSources = (candidate: PortableUpdateTarget) => {
    const compatible = mergePortableUpdateTargets(target, candidate);
    for (const source of portableDownloadSources(compatible)) {
      if (knownSources.has(source.downloadUrl)) {
        continue;
      }
      knownSources.set(source.downloadUrl, source);
      if (!attemptedSources.has(source.downloadUrl)) {
        sourceQueue.push(source);
      }
    }
  };
  addSources(target);

  let additionalSettled = !options.additionalTarget;
  const additionalRequest = options.additionalTarget
    ? options.additionalTarget.then((candidate) => {
      if (candidate) {
        addSources(candidate);
      }
    }).catch((error) => {
      failures.push(`备用源校验失败：${portableErrorText(error)}`);
    }).finally(() => {
      additionalSettled = true;
    })
    : Promise.resolve();

  if (transferred > 0) {
    onProgress(portableProgress(target, transferred, 0, portablePrimaryDownloadSource(target), true));
  }

  while (transferred < target.size) {
    throwIfPortableDownloadAborted(signal);
    let source = dequeuePortableSource(sourceQueue, attemptedSources);
    if (!source && !additionalSettled) {
      await additionalRequest;
      source = dequeuePortableSource(sourceQueue, attemptedSources);
    }
    if (!source) {
      if (
        !restartedFromZero &&
        initialTransferred > 0 &&
        transferred === initialTransferred &&
        sawRangeUnsupported
      ) {
        await rm(partialPath, { force: true });
        transferred = 0;
        digest = createHash("sha256");
        restartedFromZero = true;
        attemptedSources.clear();
        sourceQueue.push(...knownSources.values());
        onProgress(portableProgress(target, 0, 0, portablePrimaryDownloadSource(target), false));
        continue;
      }
      if (!forcedCompletionAttempted && slowSource) {
        await rm(partialPath, { force: true });
        transferred = 0;
        digest = createHash("sha256");
        forcedCompletionAttempted = true;
        attemptedSources.clear();
        sourceQueue.length = 0;
        sourceQueue.push(slowSource);
        onProgress(portableProgress(target, 0, 0, slowSource, false));
        continue;
      }
      const retained = transferred > 0 ? `，已保留 ${formatPortableBytes(transferred)} 可在重试时继续` : "";
      throw new Error(`Portable 更新包下载失败${retained}：${failures.join("；") || "没有可用下载源"}`);
    }

    attemptedSources.add(source.downloadUrl);
    const result = await transferPortableSource({
      target,
      source,
      partialPath,
      transferred,
      digest,
      signal,
      fetchImpl,
      lowSpeedThreshold,
      lowSpeedGraceMs,
      lowSpeedWindowMs,
      minRemainingBytesForSourceSwitch,
      responseTimeoutMs,
      stallTimeoutMs,
      canSwitchSource: () => !forcedCompletionAttempted &&
        sourceQueue.some((candidate) => !attemptedSources.has(candidate.downloadUrl)),
      onProgress
    });
    transferred = result.transferred;
    if (result.kind === "complete") {
      break;
    }
    if (result.kind === "range-unsupported") {
      sawRangeUnsupported = true;
    }
    if (result.kind === "slow") {
      slowSource = source;
    }
    failures.push(`${source.label}：${result.message}`);
  }

  const actualDigest = digest.digest("hex");
  if (transferred !== target.size) {
    throw new Error(`Portable 更新包下载不完整（预期 ${target.size} 字节，实际 ${transferred} 字节）。`);
  }
  if (actualDigest !== target.sha256) {
    await rm(partialPath, { force: true });
    throw new Error("Portable 更新包 SHA-256 校验失败，已删除损坏的临时文件。");
  }
  await rm(stagedPath, { force: true });
  await rename(partialPath, stagedPath);
  return stagedPath;
}

type PortableTransferResult = Readonly<{
  kind: "complete" | "failed" | "slow" | "range-unsupported";
  transferred: number;
  message: string;
}>;

async function transferPortableSource(input: {
  target: PortableUpdateTarget;
  source: PortableDownloadSource;
  partialPath: string;
  transferred: number;
  digest: ReturnType<typeof createHash>;
  signal: AbortSignal;
  fetchImpl: PortableFetch;
  lowSpeedThreshold: number;
  lowSpeedGraceMs: number;
  lowSpeedWindowMs: number;
  minRemainingBytesForSourceSwitch: number;
  responseTimeoutMs: number;
  stallTimeoutMs: number;
  canSwitchSource: () => boolean;
  onProgress: (progress: PortableDownloadProgress) => void;
}): Promise<PortableTransferResult> {
  const requestedOffset = input.transferred;
  const headers: Record<string, string> = {
    Accept: "application/octet-stream, */*",
    "Cache-Control": "no-cache"
  };
  if (requestedOffset > 0) {
    headers.Range = `bytes=${requestedOffset}-`;
    headers["Accept-Encoding"] = "identity";
  }

  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  input.signal.addEventListener("abort", abortRequest, { once: true });
  const responseTimeoutId = setTimeout(abortRequest, input.responseTimeoutMs);
  let response: Response;
  try {
    response = await input.fetchImpl(input.source.downloadUrl, {
      method: "GET",
      redirect: "follow",
      headers,
      signal: requestController.signal
    });
  } catch (error) {
    throwIfPortableDownloadAborted(input.signal);
    return {
      kind: "failed",
      transferred: input.transferred,
      message: requestController.signal.aborted ? "连接更新源超时" : portableErrorText(error)
    };
  } finally {
    clearTimeout(responseTimeoutId);
    input.signal.removeEventListener("abort", abortRequest);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "failed", transferred: input.transferred, message: `HTTP ${response.status}` };
  }

  const range = parsePortableContentRange(response.headers.get("content-range"));
  if (requestedOffset > 0 && (response.status !== 206 || !range || range.start !== requestedOffset || range.total !== input.target.size)) {
    await response.body.cancel().catch(() => undefined);
    return { kind: "range-unsupported", transferred: input.transferred, message: "不支持从现有进度断点续传" };
  }
  if (requestedOffset === 0 && response.status === 206 && (!range || range.start !== 0 || range.total !== input.target.size)) {
    await response.body.cancel().catch(() => undefined);
    return { kind: "failed", transferred: input.transferred, message: "返回了无效的分段响应" };
  }

  const expectedLength = input.target.size - requestedOffset;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > 0 && contentLength !== expectedLength) {
    await response.body.cancel().catch(() => undefined);
    return {
      kind: "failed",
      transferred: input.transferred,
      message: `文件大小不匹配（预期剩余 ${expectedLength}，实际 ${contentLength}）`
    };
  }

  const reader = response.body.getReader();
  const handle = await open(input.partialPath, requestedOffset > 0 ? "r+" : "w", 0o600);
  const sourceStartedAt = Date.now();
  let sampleStartedAt = sourceStartedAt;
  let sampleStartedBytes = input.transferred;
  let transferred = input.transferred;
  try {
    input.onProgress(portableProgress(input.target, transferred, 0, input.source, requestedOffset > 0));
    while (true) {
      const chunk = await withPortableTimeout(
        reader.read(),
        input.stallTimeoutMs,
        "更新源长时间没有返回新数据",
        input.signal
      );
      if (chunk.done) {
        break;
      }
      throwIfPortableDownloadAborted(input.signal);
      const bytes = Buffer.from(chunk.value);
      if (transferred + bytes.length > input.target.size) {
        await reader.cancel().catch(() => undefined);
        return { kind: "failed", transferred, message: "返回内容超过发行版清单大小" };
      }
      await writePortableChunk(handle, bytes, transferred);
      input.digest.update(bytes);
      transferred += bytes.length;

      const now = Date.now();
      const elapsedSeconds = Math.max(0.001, (now - sourceStartedAt) / 1_000);
      const bytesPerSecond = (transferred - requestedOffset) / elapsedSeconds;
      input.onProgress(portableProgress(
        input.target,
        transferred,
        bytesPerSecond,
        input.source,
        requestedOffset > 0
      ));

      const sampleElapsedMs = now - sampleStartedAt;
      if (
        input.canSwitchSource() &&
        now - sourceStartedAt >= input.lowSpeedGraceMs &&
        sampleElapsedMs >= input.lowSpeedWindowMs &&
        input.target.size - transferred >= input.minRemainingBytesForSourceSwitch
      ) {
        const sampledSpeed = (transferred - sampleStartedBytes) / Math.max(0.001, sampleElapsedMs / 1_000);
        if (sampledSpeed < input.lowSpeedThreshold) {
          await reader.cancel().catch(() => undefined);
          return {
            kind: "slow",
            transferred,
            message: `持续低速（${formatPortableBytes(sampledSpeed)}/s），已切换备用源`
          };
        }
        sampleStartedAt = now;
        sampleStartedBytes = transferred;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throwIfPortableDownloadAborted(input.signal);
    return { kind: "failed", transferred, message: portableErrorText(error) };
  } finally {
    await handle.close();
  }

  return transferred === input.target.size
    ? { kind: "complete", transferred, message: "下载完成" }
    : { kind: "failed", transferred, message: "连接提前结束" };
}

function createPortableDownloadSource(
  id: PortableDownloadSourceId,
  downloadUrl: string,
  releaseUrl: string
): PortableDownloadSource {
  return Object.freeze({
    id,
    label: id === "gitee" ? "Gitee 国内源" : "GitHub 备用源",
    downloadUrl,
    releaseUrl
  });
}

function portableDownloadSources(target: PortableUpdateTarget): readonly PortableDownloadSource[] {
  if (target.downloadSources?.length) {
    return target.downloadSources;
  }
  let id: PortableDownloadSourceId = "github";
  try {
    id = new URL(target.downloadUrl).hostname === "gitee.com" ? "gitee" : "github";
  } catch {
    // The target was already validated by the release parser. Tests may inject a
    // local URL, which can safely use the generic fallback label.
  }
  return Object.freeze([createPortableDownloadSource(id, target.downloadUrl, target.releaseUrl)]);
}

function uniquePortableDownloadSources(input: readonly PortableDownloadSource[]): PortableDownloadSource[] {
  const unique = new Map<string, PortableDownloadSource>();
  for (const source of input) {
    if (!unique.has(source.downloadUrl)) {
      unique.set(source.downloadUrl, Object.freeze({ ...source }));
    }
  }
  return [...unique.values()];
}

function dequeuePortableSource(
  queue: PortableDownloadSource[],
  attempted: ReadonlySet<string>
): PortableDownloadSource | undefined {
  while (queue.length > 0) {
    const source = queue.shift();
    if (source && !attempted.has(source.downloadUrl)) {
      return source;
    }
  }
  return undefined;
}

function portableProgress(
  target: PortableUpdateTarget,
  transferred: number,
  bytesPerSecond: number,
  source: PortableDownloadSource,
  resumed: boolean
): PortableDownloadProgress {
  return Object.freeze({
    percent: Math.max(0, Math.min(100, (transferred / target.size) * 100)),
    transferred,
    total: target.size,
    bytesPerSecond: Math.max(0, bytesPerSecond),
    sourceId: source.id,
    sourceLabel: source.label,
    sourceReleaseUrl: source.releaseUrl,
    resumed
  });
}

async function validatePortableFile(filePath: string, target: PortableUpdateTarget): Promise<boolean> {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (isPortableFileNotFound(error)) {
      return false;
    }
    throw error;
  }
  if (!info.isFile() || info.size !== target.size) {
    return false;
  }
  return await portableFileSha256(filePath) === target.sha256;
}

async function portablePartialSize(filePath: string, targetSize: number): Promise<number> {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (isPortableFileNotFound(error)) {
      return 0;
    }
    throw error;
  }
  if (!info.isFile() || info.size < 0 || info.size > targetSize) {
    await rm(filePath, { force: true });
    return 0;
  }
  return info.size;
}

async function seedPortableDigest(
  filePath: string,
  size: number
): Promise<ReturnType<typeof createHash>> {
  const digest = createHash("sha256");
  if (size <= 0) {
    return digest;
  }
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest;
}

async function portableFileSha256(filePath: string): Promise<string> {
  const digest = await seedPortableDigest(filePath, 1);
  return digest.digest("hex");
}

async function writePortableChunk(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  fileOffset: number
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, fileOffset + written);
    if (result.bytesWritten <= 0) {
      throw new Error("写入 Portable 临时文件失败。");
    }
    written += result.bytesWritten;
  }
}

function parsePortableContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = value ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim()) : null;
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total) &&
    start >= 0 && end >= start && total > end
    ? { start, end, total }
    : null;
}

function throwIfPortableDownloadAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const error = new Error("Portable 更新下载已取消。");
  error.name = "AbortError";
  throw error;
}

async function withPortableTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  let abortHandler: (() => void) | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
        if (signal) {
          abortHandler = () => {
            const error = new Error("Portable 更新下载已取消。");
            error.name = "AbortError";
            reject(error);
          };
          signal.addEventListener("abort", abortHandler, { once: true });
          if (signal.aborted) {
            abortHandler();
          }
        }
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

function isPortableFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function portableErrorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function formatPortableBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
}

export async function launchPortableUpdateHelper(input: {
  runtime: PortableRuntime;
  userDataPath: string;
  stagedPath: string;
  target: PortableUpdateTarget;
}): Promise<void> {
  const currentPath = requirePortableExecutable(input.runtime);
  const currentDirectory = path.dirname(currentPath);
  const expectedStagingDirectory = path.resolve(currentDirectory, ".git-ui-pro-updates");
  const stagedPath = path.resolve(input.stagedPath);
  if (
    path.dirname(stagedPath).toLocaleLowerCase() !== expectedStagingDirectory.toLocaleLowerCase() ||
    path.basename(stagedPath) !== `${input.target.artifactName}.ready`
  ) {
    throw new Error("Portable 更新包暂存路径无效，请重新下载。");
  }
  const stagedStat = await stat(stagedPath);
  if (!stagedStat.isFile() || stagedStat.size !== input.target.size) {
    throw new Error("Portable 更新包已失效，请重新下载。");
  }

  const updateDirectory = path.resolve(input.userDataPath, PORTABLE_UPDATE_DIRECTORY_NAME);
  await mkdir(updateDirectory, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const markerPath = path.join(updateDirectory, `portable-health-${token}.ok`);
  const helperPath = path.join(updateDirectory, "apply-portable-update.ps1");
  const backupPath = path.join(currentDirectory, "Git-UI-Pro-Portable.previous.exe");
  const logPath = path.join(updateDirectory, "portable-update.log");
  await Promise.all([
    rm(markerPath, { force: true }),
    writeFile(helperPath, encodePortableUpdatePowerShellScript(), { mode: 0o600 })
  ]);

  const child = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-ApplicationPid",
    String(process.pid),
    "-LauncherPid",
    String(process.ppid),
    "-CurrentPath",
    currentPath,
    "-StagedPath",
    stagedPath,
    "-BackupPath",
    backupPath,
    "-HealthPath",
    markerPath,
    "-HealthToken",
    token,
    "-LogPath",
    logPath
  ], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new Error(`Portable 更新辅助进程启动失败：${error.message}`)));
  });
  child.unref();
}

export function buildPortableUpdatePowerShellScript(): string {
  return [
    "param(",
    "  [Parameter(Mandatory=$true)][int]$ApplicationPid,",
    "  [Parameter(Mandatory=$true)][int]$LauncherPid,",
    "  [Parameter(Mandatory=$true)][string]$CurrentPath,",
    "  [Parameter(Mandatory=$true)][string]$StagedPath,",
    "  [Parameter(Mandatory=$true)][string]$BackupPath,",
    "  [Parameter(Mandatory=$true)][string]$HealthPath,",
    "  [Parameter(Mandatory=$true)][string]$HealthToken,",
    "  [Parameter(Mandatory=$true)][string]$LogPath",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "function Write-UpdateLog([string]$Message) {",
    "  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
    "  Add-Content -LiteralPath $LogPath -Value \"[$timestamp] $Message\" -Encoding UTF8",
    "}",
    "function Wait-ForExit([int]$TargetPid, [int]$TimeoutSeconds) {",
    "  try { Wait-Process -Id $TargetPid -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue } catch {}",
    "}",
    "function Start-Portable([bool]$HealthCheck) {",
    "  if ($HealthCheck) {",
    `    $env:${PORTABLE_UPDATE_HEALTH_TOKEN_ENV} = $HealthToken`,
    `    $env:${PORTABLE_UPDATE_HEALTH_MARKER_ENV} = $HealthPath`,
    "  } else {",
    `    Remove-Item Env:${PORTABLE_UPDATE_HEALTH_TOKEN_ENV} -ErrorAction SilentlyContinue`,
    `    Remove-Item Env:${PORTABLE_UPDATE_HEALTH_MARKER_ENV} -ErrorAction SilentlyContinue`,
    "  }",
    "  return Start-Process -FilePath $CurrentPath -PassThru",
    "}",
    "New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null",
    "Write-UpdateLog '等待 Git UI Pro 与 Portable 启动器退出。'",
    "Wait-ForExit $ApplicationPid 90",
    "Wait-ForExit $LauncherPid 90",
    "try {",
    "  Remove-Item -LiteralPath $HealthPath -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue",
    "  Move-Item -LiteralPath $CurrentPath -Destination $BackupPath -Force",
    "  Move-Item -LiteralPath $StagedPath -Destination $CurrentPath -Force",
    "  Write-UpdateLog 'Portable 文件替换完成，启动新版本并等待健康检查。'",
    "  $newLauncher = Start-Portable $true",
    "  $deadline = (Get-Date).AddSeconds(90)",
    "  $healthy = $false",
    "  while ((Get-Date) -lt $deadline) {",
    "    if (Test-Path -LiteralPath $HealthPath) {",
    "      $marker = (Get-Content -LiteralPath $HealthPath -Raw -ErrorAction SilentlyContinue).Trim()",
    "      if ($marker -eq $HealthToken) { $healthy = $true; break }",
    "    }",
    "    if ($newLauncher.HasExited) { break }",
    "    Start-Sleep -Milliseconds 500",
    "  }",
    "  if (-not $healthy) {",
    "    Write-UpdateLog '新版本未通过健康检查，准备恢复上一版本。'",
    "    if (-not $newLauncher.HasExited) { & taskkill.exe /PID $newLauncher.Id /T /F | Out-Null }",
    "    Wait-ForExit $newLauncher.Id 30",
    "    Remove-Item -LiteralPath $CurrentPath -Force -ErrorAction SilentlyContinue",
    "    Move-Item -LiteralPath $BackupPath -Destination $CurrentPath -Force",
    "    Start-Portable $false | Out-Null",
    "    Write-UpdateLog '已恢复上一版本并重新启动。'",
    "    exit 2",
    "  }",
    "  Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $HealthPath -Force -ErrorAction SilentlyContinue",
    "  Write-UpdateLog '新版本健康检查通过，更新完成。'",
    "  exit 0",
    "} catch {",
    "  Write-UpdateLog (\"Portable 更新失败：\" + $_.Exception.Message)",
    "  if (-not (Test-Path -LiteralPath $CurrentPath) -and (Test-Path -LiteralPath $BackupPath)) {",
    "    Move-Item -LiteralPath $BackupPath -Destination $CurrentPath -Force -ErrorAction SilentlyContinue",
    "  }",
    "  if (Test-Path -LiteralPath $CurrentPath) { Start-Portable $false | Out-Null }",
    "  exit 1",
    "}"
  ].join("\r\n");
}

export function encodePortableUpdatePowerShellScript(): Buffer {
  // Windows PowerShell 5.1 treats UTF-8 files without a BOM as the active ANSI
  // code page. The helper contains Chinese log messages, so an explicit BOM is
  // required to keep quoted strings parseable on every Windows locale.
  return Buffer.from(`\uFEFF${buildPortableUpdatePowerShellScript()}\r\n`, "utf8");
}

async function ensureDirectoryWritable(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.write-test-${process.pid}-${Date.now()}`);
  const handle = await open(probe, "wx", 0o600);
  await handle.close();
  await rm(probe, { force: true });
}

function requirePortableExecutable(runtime: PortableRuntime): string {
  if (!runtime.isPortable || !runtime.executablePath || !path.isAbsolute(runtime.executablePath)) {
    throw new Error("当前不是可更新的 Windows Portable 正式版。");
  }
  if (!existsSync(runtime.executablePath)) {
    throw new Error("找不到当前 Portable 可执行文件，无法执行在线更新。");
  }
  return path.resolve(runtime.executablePath);
}

function parsePortableGithubRelease(value: unknown): PortableUpdateTarget | null {
  const identity = parsePortableGithubReleaseIdentity(value);
  if (!identity || !isRecord(value) || !Array.isArray(value.assets)) {
    return null;
  }
  const artifactName = portableArtifactName(identity.version);
  const expectedPath = `/${GITHUB_RELEASE_OWNER}/${GITHUB_RELEASE_REPOSITORY}/releases/download/${identity.tagName}/${artifactName}`;
  for (const item of value.assets) {
    if (!isRecord(item) || item.name !== artifactName || item.state !== "uploaded") {
      continue;
    }
    const digestMatch = typeof item.digest === "string" ? SHA256_DIGEST_PATTERN.exec(item.digest) : null;
    const downloadUrl = typeof item.browser_download_url === "string"
      ? parseExactDownloadUrl(item.browser_download_url, "github.com", expectedPath)
      : null;
    if (
      !digestMatch ||
      !downloadUrl ||
      typeof item.size !== "number" ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0
    ) {
      continue;
    }
    return Object.freeze({
      version: identity.version,
      tagName: identity.tagName,
      releaseName: identity.releaseName,
      releaseNotes: identity.releaseNotes,
      releaseDate: identity.releaseDate,
      releaseUrl: identity.releaseUrl,
      artifactName,
      downloadUrl,
      downloadSources: Object.freeze([
        createPortableDownloadSource("github", downloadUrl, identity.releaseUrl)
      ]),
      size: item.size,
      sha256: digestMatch[1].toLowerCase()
    });
  }
  return null;
}

function portableCatalogFromTargets(input: readonly PortableUpdateTarget[]): PortableReleaseCatalog {
  const unique = new Map<string, PortableUpdateTarget>();
  for (const target of input) {
    if (!unique.has(target.version)) {
      unique.set(target.version, target);
    }
  }
  const selected = [...unique.values()]
    .sort((left, right) => comparePortableVersions(right.version, left.version))
    .slice(0, MAX_HISTORY_ENTRIES);
  const entries: ReleaseHistoryItem[] = selected.map((target) => ({
    version: target.version,
    tagName: target.tagName,
    releaseName: target.releaseName,
    releaseNotes: target.releaseNotes,
    publishedAt: target.releaseDate,
    releaseUrl: target.releaseUrl,
    installerSize: target.size
  }));
  return new PortableReleaseCatalog(entries, new Map(selected.map((target) => [target.version, target])));
}

function parseExactDownloadUrl(value: string, hostname: string, expectedPath: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === hostname &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === expectedPath
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function giteeDownloadPath(tagName: string, filename: string): string {
  return `/${GITEE_RELEASE_OWNER}/${GITEE_RELEASE_REPOSITORY}/releases/download/${tagName}/${filename}`;
}

function parseStableVersion(value: string): StableVersion | null {
  const match = STABLE_VERSION_PATTERN.exec(value.trim());
  return match
    ? Object.freeze({
      value: `${match[1]}.${match[2]}.${match[3]}`,
      parts: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])] as const
    })
    : null;
}

function requireStableVersion(value: string, label: string): StableVersion {
  const parsed = parseStableVersion(stripVersionPrefix(value));
  if (!parsed) {
    throw new Error(`${label}不是稳定语义版本：${value}`);
  }
  return parsed;
}

function compareStableVersions(left: StableVersion, right: StableVersion): number {
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] > right.parts[index]) return 1;
    if (left.parts[index] < right.parts[index]) return -1;
  }
  return 0;
}

function stripVersionPrefix(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\r\n/g, "\n") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sha256File(filename: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

export async function readPortableUpdateLog(userDataPath: string): Promise<string> {
  const filename = path.join(userDataPath, PORTABLE_UPDATE_DIRECTORY_NAME, "portable-update.log");
  return readFile(filename, "utf8").catch(() => "");
}
