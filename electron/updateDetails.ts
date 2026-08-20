import type { UpdateSource } from "./updateService";

const STABLE_VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_COMPARISON_COMMITS = 50;

export type UpdateComparisonCommit = {
  sha: string;
  title: string;
  url?: string;
};

export type UpdateReleaseDetails = {
  source: UpdateSource;
  baseVersion: string;
  targetVersion: string;
  publishedAt?: string;
  releaseUrl: string;
  compareUrl: string;
  commits: UpdateComparisonCommit[];
  totalCommits: number;
  fallbackNotes: string[];
  contentSource: "compare" | "release";
};

export type StableReleaseRange = {
  baseVersion: string;
  targetVersion: string;
  publishedAt?: string;
  releaseUrl?: string;
  releaseNotes: string;
};

type StableRelease = {
  version: string;
  publishedAt?: string;
  releaseUrl?: string;
  releaseNotes: string;
};

export function selectStableReleaseRange(value: unknown, targetVersion: string): StableReleaseRange {
  const normalizedTarget = normalizeStableVersion(targetVersion);
  if (!normalizedTarget) {
    throw new Error("要查看的正式版本号无效。");
  }

  const releases = Array.isArray(value)
    ? value.map(parseStableRelease).filter((release): release is StableRelease => release !== null)
    : [];
  releases.sort((left, right) => compareVersions(right.version, left.version));

  const target = releases.find((release) => release.version === normalizedTarget);
  const base = releases.find((release) => compareVersions(release.version, normalizedTarget) < 0);
  if (!base) {
    throw new Error(`未找到 v${normalizedTarget} 的上一正式版本。`);
  }

  return {
    baseVersion: base.version,
    targetVersion: normalizedTarget,
    publishedAt: target?.publishedAt,
    releaseUrl: target?.releaseUrl,
    releaseNotes: target?.releaseNotes ?? ""
  };
}

export function parseComparisonCommits(value: unknown, source: UpdateSource = "github"): { commits: UpdateComparisonCommit[]; totalCommits: number } {
  if (!value || typeof value !== "object") {
    throw new Error("版本比较数据格式无效。");
  }
  const comparison = value as { commits?: unknown; total_commits?: unknown; total?: unknown };
  if (!Array.isArray(comparison.commits)) {
    throw new Error("版本比较数据缺少提交记录。");
  }

  const commits: UpdateComparisonCommit[] = [];
  const seen = new Set<string>();
  let skippedBookkeepingCommits = 0;
  const rawCommits = source === "gitee" ? [...comparison.commits].reverse() : comparison.commits;
  for (const value of rawCommits) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const entry = value as {
      sha?: unknown;
      id?: unknown;
      message?: unknown;
      html_url?: unknown;
      url?: unknown;
      commit?: unknown;
    };
    const nested = entry.commit && typeof entry.commit === "object"
      ? entry.commit as { message?: unknown; title?: unknown }
      : null;
    const rawMessage = typeof nested?.message === "string"
      ? nested.message
      : typeof nested?.title === "string"
        ? nested.title
        : typeof entry.message === "string"
          ? entry.message
          : "";
    const title = rawMessage.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
    if (!title) {
      continue;
    }
    if (/^(?:chore|build)\(release\):\s*(?:发布|release)\s+v?\d+\.\d+\.\d+$/iu.test(title)) {
      skippedBookkeepingCommits += 1;
      continue;
    }

    const rawSha = typeof entry.sha === "string" ? entry.sha : typeof entry.id === "string" ? entry.id : "";
    const identity = rawSha || title;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    const rawUrl = typeof entry.html_url === "string" ? entry.html_url : typeof entry.url === "string" ? entry.url : undefined;
    commits.push({
      sha: rawSha,
      title,
      url: safeHttpsUrl(rawUrl)
    });
    if (commits.length >= MAX_COMPARISON_COMMITS) {
      break;
    }
  }

  const reportedTotal = typeof comparison.total_commits === "number"
    ? comparison.total_commits
    : typeof comparison.total === "number"
      ? comparison.total
      : comparison.commits.length;
  return {
    commits,
    totalCommits: Math.max(
      commits.length,
      Number.isFinite(reportedTotal) ? Math.max(0, Math.trunc(reportedTotal) - skippedBookkeepingCommits) : 0
    )
  };
}

export function cleanReleaseNoteItems(value: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^#{1,6}\s+/u, "").replace(/^(?:[-*+]\s+|\d+[.)]\s*)/u, ""))
    .filter((line) => {
      if (!line || /^---+$/u.test(line)) {
        return false;
      }
      if (/^(?:what(?:'|’)s\s+changed|更新内容|变更内容)$/iu.test(line)) {
        return false;
      }
      if (/full\s+changelog/iu.test(line) || /\/compare\/v?\d+\.\d+\.\d+\.{2,3}v?\d+\.\d+\.\d+/iu.test(line)) {
        return false;
      }
      if (/^https?:\/\/\S+$/iu.test(line) || /^\[[^\]]+\]\(https?:\/\/[^)]+\)$/iu.test(line)) {
        return false;
      }
      return true;
    })
    .slice(0, 20);
}

export function comparisonApiUrl(source: UpdateSource, baseVersion: string, targetVersion: string): string {
  const baseTag = `v${requireStableVersion(baseVersion)}`;
  const targetTag = `v${requireStableVersion(targetVersion)}`;
  return source === "gitee"
    ? `https://gitee.com/api/v5/repos/zjx_master/git-ui-pro/compare/${baseTag}...${targetTag}`
    : `https://api.github.com/repos/zjx150504-lgtm/Git_UI_Pro/compare/${baseTag}...${targetTag}?per_page=100`;
}

export function comparisonWebUrl(source: UpdateSource, baseVersion: string, targetVersion: string): string {
  const baseTag = `v${requireStableVersion(baseVersion)}`;
  const targetTag = `v${requireStableVersion(targetVersion)}`;
  return source === "gitee"
    ? `https://gitee.com/zjx_master/git-ui-pro/compare/${baseTag}...${targetTag}`
    : `https://github.com/zjx150504-lgtm/Git_UI_Pro/compare/${baseTag}...${targetTag}`;
}

function parseStableRelease(value: unknown): StableRelease | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const release = value as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    body?: unknown;
    published_at?: unknown;
    created_at?: unknown;
    html_url?: unknown;
    url?: unknown;
  };
  if (release.draft === true || release.prerelease === true || typeof release.tag_name !== "string") {
    return null;
  }
  const version = normalizeStableVersion(release.tag_name);
  if (!version || release.tag_name !== `v${version}`) {
    return null;
  }
  const publishedAt = typeof release.published_at === "string"
    ? release.published_at
    : typeof release.created_at === "string"
      ? release.created_at
      : undefined;
  const releaseUrl = typeof release.html_url === "string"
    ? safeHttpsUrl(release.html_url)
    : typeof release.url === "string"
      ? safeHttpsUrl(release.url)
      : undefined;
  return {
    version,
    publishedAt,
    releaseUrl,
    releaseNotes: typeof release.body === "string" ? release.body.trim() : ""
  };
}

function requireStableVersion(value: string): string {
  const version = normalizeStableVersion(value);
  if (!version) {
    throw new Error("正式版本号无效。");
  }
  return version;
}

function normalizeStableVersion(value: string): string | null {
  const match = STABLE_VERSION_PATTERN.exec(value.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
