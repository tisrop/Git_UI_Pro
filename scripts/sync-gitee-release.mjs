import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_GITEE_OWNER = "zjx_master";
const DEFAULT_GITEE_REPOSITORY = "git-ui-pro";
const UPDATE_MANIFEST_NAME = "update-manifest.json";
const REQUEST_TIMEOUT_MS = 30_000;
const ASSET_PROBE_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 25 * 60_000;
const UPLOAD_IDLE_TIMEOUT_MS = 2 * 60_000;
const UPLOAD_RESPONSE_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_GITEE_RELEASE_RETENTION = 3;
const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANAGED_RELEASE_ASSET_PATTERNS = Object.freeze([
  /^Git-UI-Pro-Setup-\d+\.\d+\.\d+-x64\.exe(?:\.blockmap)?$/,
  /^Git-UI-Pro-Portable-\d+\.\d+\.\d+-x64\.exe$/,
  /^latest\.yml$/,
  /^update-manifest\.json$/
]);

export function createGiteeUpdateManifest(tagName, installer, portable) {
  const version = stableVersionFromTag(tagName);
  const expectedName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const expectedPortableName = `Git-UI-Pro-Portable-${version}-x64.exe`;
  if (
    installer?.name !== expectedName ||
    !Number.isSafeInteger(installer.size) ||
    installer.size <= 0 ||
    typeof installer.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(installer.sha256)
  ) {
    throw new Error("Windows 安装包信息无效，无法生成 Gitee 更新清单。");
  }
  if (
    portable?.name !== expectedPortableName ||
    !Number.isSafeInteger(portable.size) ||
    portable.size <= 0 ||
    typeof portable.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(portable.sha256)
  ) {
    throw new Error("Windows Portable 信息无效，无法生成 Gitee 更新清单。");
  }
  return Object.freeze({
    schemaVersion: 1,
    version,
    tagName,
    installer: Object.freeze({
      name: expectedName,
      size: installer.size,
      sha256: installer.sha256.toLowerCase()
    }),
    portable: Object.freeze({
      name: expectedPortableName,
      size: portable.size,
      sha256: portable.sha256.toLowerCase()
    })
  });
}

export async function collectWindowsUpdateFiles(rootDirectory, tagName) {
  const version = stableVersionFromTag(tagName);
  const expectedNames = [
    `Git-UI-Pro-Setup-${version}-x64.exe`,
    `Git-UI-Pro-Setup-${version}-x64.exe.blockmap`,
    `Git-UI-Pro-Portable-${version}-x64.exe`,
    "latest.yml"
  ];
  const files = await listFilesRecursively(path.resolve(rootDirectory));
  const selected = new Map();
  for (const filename of expectedNames) {
    const matches = files.filter((file) => path.basename(file) === filename);
    if (matches.length !== 1) {
      throw new Error(`Gitee 镜像要求 ${filename} 恰好存在一份，实际找到 ${matches.length} 份。`);
    }
    selected.set(filename, matches[0]);
  }
  return selected;
}

export async function syncGiteeRelease(options = {}) {
  const token = requiredValue(options.giteeToken ?? process.env.GITEE_TOKEN, "GITEE_TOKEN");
  const githubToken = normalizeText(options.githubToken ?? process.env.GITHUB_TOKEN);
  const githubRepository = requiredValue(options.githubRepository ?? process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const tagName = requiredValue(options.tagName ?? process.env.RELEASE_TAG, "RELEASE_TAG");
  const artifactsDirectory = requiredValue(
    options.artifactsDirectory ?? process.env.RELEASE_ARTIFACTS_DIR,
    "RELEASE_ARTIFACTS_DIR"
  );
  const owner = options.giteeOwner ?? process.env.GITEE_OWNER ?? DEFAULT_GITEE_OWNER;
  const repository = options.giteeRepository ?? process.env.GITEE_REPOSITORY ?? DEFAULT_GITEE_REPOSITORY;
  const signal = options.signal;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  throwIfAborted(signal);
  const version = stableVersionFromTag(tagName);
  reportProgress(onProgress, {
    phase: "preparing",
    message: `检查 ${tagName} 的本地 Windows 正式产物`
  });
  const files = await collectWindowsUpdateFiles(artifactsDirectory, tagName);
  const installerName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const portableName = `Git-UI-Pro-Portable-${version}-x64.exe`;
  const installerPath = files.get(installerName);
  const portablePath = files.get(portableName);
  reportProgress(onProgress, {
    phase: "hashing",
    message: "计算安装版与 Portable 的 SHA-256 完整性摘要"
  });
  const [installerStat, portableStat, installerSha256, portableSha256] = await Promise.all([
    stat(installerPath),
    stat(portablePath),
    sha256File(installerPath, signal),
    sha256File(portablePath, signal)
  ]);
  const manifest = createGiteeUpdateManifest(tagName, {
    name: installerName,
    size: installerStat.size,
    sha256: installerSha256
  }, {
    name: portableName,
    size: portableStat.size,
    sha256: portableSha256
  });
  throwIfAborted(signal);
  reportProgress(onProgress, {
    phase: "release",
    message: `读取 GitHub ${tagName} 正式版说明`
  });
  const githubRelease = options.githubRelease ?? await fetchGithubRelease(
    githubRepository,
    tagName,
    githubToken,
    options.githubFetchImpl ?? options.fetchImpl,
    signal
  );
  const gitee = createGiteeClient({
    owner,
    repository,
    token,
    fetchImpl: options.giteeFetchImpl ?? options.fetchImpl,
    uploadImpl: options.uploadImpl,
    signal
  });
  reportProgress(onProgress, {
    phase: "release",
    message: `创建或更新 Gitee ${tagName} 发行版`
  });
  const release = await gitee.ensureRelease({
    tagName,
    name: normalizeText(githubRelease.name) || `Git UI Pro v${version}`,
    body: normalizeText(githubRelease.body),
    targetCommitish: tagName
  });
  if (!Number.isSafeInteger(release?.id) || release.id <= 0) {
    throw new Error("Gitee Release 创建结果缺少有效编号，已停止上传更新资产。");
  }

  const retainedReleaseCount = normalizeRetentionCount(options.retainedReleaseCount);
  reportProgress(onProgress, {
    phase: "cleanup",
    message: `整理 Gitee 附件空间，仅保留最近 ${retainedReleaseCount} 个正式版本的下载文件`
  });
  const cleanup = await gitee.pruneManagedAssets({ currentTag: tagName, retainCount: retainedReleaseCount });
  if (cleanup.deletedAssets > 0) {
    reportProgress(onProgress, {
      phase: "cleanup",
      message: `已清理 ${cleanup.releases.length} 个旧版本的 ${cleanup.deletedAssets} 个附件，释放 ${formatMegabytes(cleanup.reclaimedBytes)}`
    });
  }

  const uploadNames = [...files.keys(), UPDATE_MANIFEST_NAME];
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const uploadEntries = [
    installerName,
    `${installerName}.blockmap`,
    portableName,
    "latest.yml"
  ].map((name) => [name, { filePath: files.get(name) }]);
  uploadEntries.push([UPDATE_MANIFEST_NAME, { data: manifestBuffer }]);
  const entrySizes = await Promise.all(uploadEntries.map(([name, source]) => assetSourceSize(name, source)));
  const overallTotalBytes = entrySizes.reduce((total, size) => total + size, 0);
  const expectedAssets = new Map();
  const uploadedAssets = [];
  const skippedAssets = [];
  let completedBytes = 0;
  for (let index = 0; index < uploadEntries.length; index += 1) {
    throwIfAborted(signal);
    const [name, source] = uploadEntries[index];
    const expectedSize = entrySizes[index];
    const progressBase = {
      phase: "asset",
      assetName: name,
      assetIndex: index + 1,
      assetCount: uploadEntries.length,
      assetSize: expectedSize,
      overallTotalBytes
    };
    reportProgress(onProgress, {
      ...progressBase,
      status: "checking",
      uploadedBytes: 0,
      overallUploadedBytes: completedBytes,
      message: `检查 Gitee 附件 ${index + 1}/${uploadEntries.length}：${name}`
    });
    const result = await gitee.ensureAsset(release.id, name, source, {
      onProgress: ({ uploadedBytes }) => reportProgress(onProgress, {
        ...progressBase,
        status: "uploading",
        uploadedBytes,
        overallUploadedBytes: completedBytes + uploadedBytes
      })
    });
    completedBytes += result.size;
    expectedAssets.set(name, result.size);
    (result.status === "skipped" ? skippedAssets : uploadedAssets).push(name);
    reportProgress(onProgress, {
      ...progressBase,
      status: result.status,
      uploadedBytes: result.size,
      overallUploadedBytes: completedBytes,
      message: result.status === "skipped"
        ? `附件已存在且完整，跳过上传：${name}`
        : `附件上传并校验完成：${name}`
    });
  }
  reportProgress(onProgress, {
    phase: "verifying",
    overallUploadedBytes: completedBytes,
    overallTotalBytes,
    message: "复核 Gitee 国内镜像的附件名称与文件大小"
  });
  await gitee.verifyNamedAssets(release.id, expectedAssets);
  reportProgress(onProgress, {
    phase: "completed",
    overallUploadedBytes: overallTotalBytes,
    overallTotalBytes,
    message: `Gitee ${tagName} 国内更新镜像已完整就绪`
  });

  return Object.freeze({
    tagName,
    version,
    releaseUrl: `https://gitee.com/${owner}/${repository}/releases/tag/${tagName}`,
    assets: Object.freeze(uploadNames),
    uploadedAssets: Object.freeze(uploadedAssets),
    skippedAssets: Object.freeze(skippedAssets)
  });
}

function createGiteeClient({ owner, repository, token, fetchImpl = fetch, uploadImpl = uploadMultipartAsset, signal }) {
  const baseUrl = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;

  async function request(pathname, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}${pathname}`,
        init,
        timeoutMs,
        signal,
        `Gitee API ${pathname}`
      );
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500).replace(/\s+/g, " ").trim();
        throw new Error(`Gitee API ${pathname} 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
      }
      if (response.status === 204) {
        return null;
      }
      const responseText = await response.text();
      return responseText ? JSON.parse(responseText) : null;
    } catch (error) {
      throw error;
    }
  }

  async function findRelease(tagName) {
    const url = new URL(`${baseUrl}/releases/tags/${encodeURIComponent(tagName)}`);
    url.searchParams.set("access_token", token);
    const response = await fetchWithTimeout(fetchImpl, url, {}, REQUEST_TIMEOUT_MS, signal, "读取 Gitee 发行版");
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Gitee API /releases/tags/${tagName} 返回 HTTP ${response.status}。`);
    }
    return response.json();
  }

  async function listAssets(releaseId) {
    const url = new URL(`${baseUrl}/releases/${releaseId}/attach_files`);
    url.searchParams.set("access_token", token);
    const response = await fetchWithTimeout(fetchImpl, url, {}, REQUEST_TIMEOUT_MS, signal, "读取 Gitee 附件列表");
    if (!response.ok) {
      throw new Error(`读取 Gitee v5 Release 附件失败（HTTP ${response.status}）。`);
    }
    const assets = await response.json();
    if (!Array.isArray(assets)) {
      throw new Error("Gitee Release 附件列表格式无效。");
    }
    return assets;
  }

  async function listReleases() {
    const releases = [];
    for (let page = 1; page <= 20; page += 1) {
      const url = new URL(`${baseUrl}/releases`);
      url.searchParams.set("access_token", token);
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", "100");
      const response = await fetchWithTimeout(fetchImpl, url, {}, REQUEST_TIMEOUT_MS, signal, "读取 Gitee 发行版列表");
      if (!response.ok) {
        throw new Error(`读取 Gitee 发行版列表失败（HTTP ${response.status}）。`);
      }
      const pageReleases = await response.json();
      if (!Array.isArray(pageReleases)) {
        throw new Error("Gitee 发行版列表格式无效。");
      }
      releases.push(...pageReleases);
      if (pageReleases.length < 100) {
        break;
      }
    }
    return releases;
  }

  async function deleteAsset(releaseId, assetId) {
    await request(`/releases/${releaseId}/attach_files/${assetId}`, {
      method: "DELETE",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token })
    });
  }

  return {
    async pruneManagedAssets({ currentTag, retainCount }) {
      const releases = (await listReleases())
        .filter((candidate) => Number.isSafeInteger(candidate?.id) && candidate.id > 0 && STABLE_TAG_PATTERN.test(candidate?.tag_name ?? ""))
        .sort((left, right) => compareStableTags(right.tag_name, left.tag_name));
      const retainedTags = new Set([currentTag]);
      for (const candidate of releases) {
        if (retainedTags.size >= retainCount) break;
        retainedTags.add(candidate.tag_name);
      }

      let deletedAssets = 0;
      let reclaimedBytes = 0;
      const cleanedReleases = [];
      for (const candidate of releases) {
        throwIfAborted(signal);
        if (retainedTags.has(candidate.tag_name)) continue;
        const assets = await listAssets(candidate.id);
        let releaseDeletedAssets = 0;
        for (const asset of assets) {
          const assetId = numericAssetId(asset?.id);
          if (assetId === null || !isManagedReleaseAsset(asset?.name)) continue;
          await deleteAsset(candidate.id, assetId);
          deletedAssets += 1;
          releaseDeletedAssets += 1;
          reclaimedBytes += Number.isSafeInteger(Number(asset?.size)) ? Number(asset.size) : 0;
        }
        if (releaseDeletedAssets > 0) {
          cleanedReleases.push(candidate.tag_name);
        }
      }
      return Object.freeze({
        deletedAssets,
        reclaimedBytes,
        releases: Object.freeze(cleanedReleases)
      });
    },

    async ensureRelease({ tagName, name, body, targetCommitish }) {
      const existing = await findRelease(tagName);
      const payload = {
        access_token: token,
        tag_name: tagName,
        name,
        body,
        prerelease: false,
        target_commitish: targetCommitish
      };
      if (existing?.id) {
        return request(`/releases/${existing.id}`, {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      }
      return request("/releases", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    },

    async ensureAsset(releaseId, filename, source, progressOptions = {}) {
      const expectedSize = await assetSourceSize(filename, source);
      const assets = await listAssets(releaseId);
      const namedAssets = assets.filter((asset) => asset?.name === filename);
      const reusableAsset = await findCompleteAsset(namedAssets, expectedSize, fetchImpl, signal);
      if (reusableAsset) {
        console.log(`Gitee Release 附件已存在且大小一致，跳过重传：${filename}`);
        return { size: expectedSize, status: "skipped" };
      }

      for (const asset of namedAssets) {
        const assetId = numericAssetId(asset?.id);
        if (assetId !== null) {
          await deleteAsset(releaseId, assetId);
        }
      }

      try {
        await uploadImpl({
          url: `${baseUrl}/releases/${releaseId}/attach_files`,
          token,
          filename,
          source,
          timeoutMs: UPLOAD_TIMEOUT_MS,
          idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS,
          responseTimeoutMs: UPLOAD_RESPONSE_TIMEOUT_MS,
          signal,
          onProgress: progressOptions.onProgress
        });
      } catch (error) {
        throwIfAborted(signal);
        const completedAfterError = await verifyAssetWithPolling(
          () => listAssets(releaseId),
          filename,
          expectedSize,
          fetchImpl,
          signal
        ).catch(() => false);
        if (completedAfterError) {
          console.log(`Gitee Release 已在连接中断后确认附件完整：${filename}`);
          return { size: expectedSize, status: "uploaded" };
        }
        throw error;
      }
      const verified = await verifyAssetWithPolling(
        () => listAssets(releaseId),
        filename,
        expectedSize,
        fetchImpl,
        signal
      );
      if (!verified) {
        throw new Error(`Gitee Release 附件 ${filename} 上传后无法确认完整大小，已停止发布更新清单。`);
      }
      console.log(`Gitee Release 附件上传完成：${filename}`);
      return { size: expectedSize, status: "uploaded" };
    },

    async verifyNamedAssets(releaseId, expectedAssets) {
      const assets = await listAssets(releaseId);
      const invalid = [];
      for (const [name, size] of expectedAssets) {
        const complete = await findCompleteAsset(
          assets.filter((asset) => asset?.name === name),
          size,
          fetchImpl,
          signal
        );
        if (!complete) {
          invalid.push([name, size]);
        }
      }
      if (invalid.length > 0) {
        throw new Error(`Gitee Release 附件上传后校验失败，缺少或大小不一致：${invalid.map(([name]) => name).join("、")}。`);
      }
    }
  };
}

async function assetSourceSize(filename, source) {
  const size = source.filePath ? (await stat(source.filePath)).size : source.data?.length;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`待上传附件 ${filename} 为空或大小无效。`);
  }
  return size;
}

function reportProgress(onProgress, event) {
  onProgress(Object.freeze({ ...event }));
  if (event.message) {
    console.log(event.message);
  }
}

function createAbortError() {
  const error = new Error("Gitee 国内镜像同步已取消。");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, parentSignal, label) {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const handleAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", handleAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (parentSignal?.aborted) {
      throw createAbortError();
    }
    if (timedOut || controller.signal.aborted) {
      throw new Error(`${label}请求超过 ${Math.ceil(timeoutMs / 1_000)} 秒。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", handleAbort);
  }
}

function numericAssetId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function declaredAssetSize(asset) {
  for (const value of [asset?.size, asset?.file_size, asset?.filesize]) {
    const size = Number(value);
    if (Number.isSafeInteger(size) && size > 0) {
      return size;
    }
  }
  return null;
}

function trustedGiteeAssetUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (hostname !== "gitee.com" && !hostname.endsWith(".gitee.com"))) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function responseAssetSize(response) {
  const contentRange = response.headers.get("content-range");
  const rangedSize = contentRange ? Number(/\/(\d+)$/.exec(contentRange)?.[1]) : NaN;
  if (Number.isSafeInteger(rangedSize) && rangedSize > 0) {
    return rangedSize;
  }
  const contentLength = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
}

async function probeAssetSize(asset, fetchImpl, signal) {
  const declaredSize = declaredAssetSize(asset);
  if (declaredSize !== null) {
    return declaredSize;
  }
  const url = trustedGiteeAssetUrl(asset?.browser_download_url ?? asset?.download_url);
  if (!url) {
    return null;
  }

  for (const init of [
    { method: "HEAD", redirect: "follow", headers: { Accept: "application/octet-stream" } },
    { method: "GET", redirect: "follow", headers: { Accept: "application/octet-stream", Range: "bytes=0-0" } }
  ]) {
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        init,
        ASSET_PROBE_TIMEOUT_MS,
        signal,
        `校验 Gitee 附件 ${asset?.name ?? ""}`
      );
      const size = response.ok ? responseAssetSize(response) : null;
      await response.body?.cancel().catch(() => {});
      if (size !== null) {
        return size;
      }
    } catch (error) {
      throwIfAborted(signal);
      if (init.method === "GET") {
        return null;
      }
    }
  }
  return null;
}

async function findCompleteAsset(assets, expectedSize, fetchImpl, signal) {
  for (const asset of assets) {
    if (await probeAssetSize(asset, fetchImpl, signal) === expectedSize) {
      return asset;
    }
  }
  return null;
}

async function verifyAssetWithPolling(listAssets, filename, expectedSize, fetchImpl, signal) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    const assets = await listAssets();
    const complete = await findCompleteAsset(
      assets.filter((asset) => asset?.name === filename),
      expectedSize,
      fetchImpl,
      signal
    );
    if (complete) {
      return true;
    }
    if (attempt < 2) {
      await abortableDelay(1_000, signal);
    }
  }
  return false;
}

function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    const handleAbort = () => {
      clearTimeout(timeoutId);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function uploadMultipartAsset({
  url,
  token,
  filename,
  source,
  timeoutMs,
  idleTimeoutMs,
  responseTimeoutMs,
  signal,
  onProgress = () => {}
}) {
  const boundary = `----git-ui-pro-${randomUUID()}`;
  const safeFilename = filename.replace(/["\r\n]/g, "_");
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    "utf8"
  );
  const suffix = Buffer.from(
    `\r\n--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"access_token\"\r\n\r\n" +
      `${token}\r\n--${boundary}--\r\n`,
    "utf8"
  );
  const fileSize = await assetSourceSize(filename, source);

  await new Promise((resolve, reject) => {
    let fileStream;
    let uploadedBytes = 0;
    let nextProgressPercent = 1;
    let settled = false;
    let idleTimeoutId = null;
    let responseTimeoutId = null;
    const clearTimers = () => {
      clearTimeout(timeoutId);
      clearTimeout(idleTimeoutId);
      clearTimeout(responseTimeoutId);
    };
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId);
      idleTimeoutId = setTimeout(() => {
        request.destroy(
          new Error(
            `上传 Gitee Release 附件 ${filename} 连续 ${Math.round(idleTimeoutMs / 60_000)} 分钟无传输进度` +
              `（已传输 ${formatMegabytes(uploadedBytes)} / ${formatMegabytes(fileSize)}）。`
          )
        );
      }, idleTimeoutMs);
    };
    const handleAbort = () => request.destroy(createAbortError());
    const request = httpsRequest(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": prefix.length + fileSize + suffix.length,
        "User-Agent": "Git-UI-Pro-Gitee-Mirror"
      }
    }, (response) => {
      const chunks = [];
      let responseSize = 0;
      response.on("data", (chunk) => {
        resetIdleTimeout();
        responseSize += chunk.length;
        if (responseSize <= 16_384) {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        const detail = Buffer.concat(chunks).toString("utf8").slice(0, 500).replace(/\s+/g, " ").trim();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          finish(resolve);
          return;
        }
        const quotaExceeded = /exceeded repository attachment quota|附件(?:仓库)?配额|超出仓库附件配额/i.test(detail);
        finish(reject, new Error(quotaExceeded
          ? `Gitee 附件空间仍然不足。发布控制台已清理旧版本附件；若刚完成清理，请稍后重新点击“同步 / 修复”。${detail ? ` Gitee 返回：${detail}` : ""}`
          : `上传 Gitee Release 附件 ${filename} 返回 HTTP ${response.statusCode ?? "未知"}${detail ? `：${detail}` : ""}`));
      });
    });
    const timeoutId = setTimeout(() => {
      request.destroy(
        new Error(
          `上传 Gitee Release 附件 ${filename} 超过 ${Math.round(timeoutMs / 60_000)} 分钟` +
            `（已传输 ${formatMegabytes(uploadedBytes)} / ${formatMegabytes(fileSize)}）。`
        )
      );
    }, timeoutMs);
    request.on("error", (error) => {
      fileStream?.destroy();
      const uploadError = error?.name === "AbortError" || signal?.aborted
        ? createAbortError()
        : new Error(`上传 Gitee Release 附件 ${filename} 失败：${error.message}`);
      finish(reject, uploadError);
    });
    signal?.addEventListener("abort", handleAbort, { once: true });
    resetIdleTimeout();
    if (signal?.aborted) {
      handleAbort();
      return;
    }

    const writeChunk = (chunk) => new Promise((writeResolve, writeReject) => {
      request.write(chunk, (error) => error ? writeReject(error) : writeResolve());
    });
    const publishProgress = () => {
      const progressPercent = Math.min(100, Math.floor((uploadedBytes / fileSize) * 100));
      onProgress({ filename, uploadedBytes, totalBytes: fileSize, percent: progressPercent });
      if (progressPercent >= nextProgressPercent) {
        if (progressPercent % 10 === 0 || progressPercent === 100) {
          console.log(
            `Gitee Release 附件传输进度：${filename} ${progressPercent}%` +
              `（${formatMegabytes(uploadedBytes)} / ${formatMegabytes(fileSize)}）`
          );
        }
        nextProgressPercent = Math.min(100, progressPercent + 1);
      }
    };
    void (async () => {
      try {
        await writeChunk(prefix);
        if (source.filePath) {
          fileStream = createReadStream(source.filePath);
          for await (const chunk of fileStream) {
            throwIfAborted(signal);
            await writeChunk(chunk);
            uploadedBytes += chunk.length;
            resetIdleTimeout();
            publishProgress();
          }
        } else {
          throwIfAborted(signal);
          await writeChunk(source.data);
          uploadedBytes = source.data.length;
          resetIdleTimeout();
          publishProgress();
        }
        await writeChunk(suffix);
        request.end();
        clearTimeout(idleTimeoutId);
        if (!settled) {
          responseTimeoutId = setTimeout(() => {
            request.destroy(
              new Error(
                `Gitee 已接收附件 ${filename} 的全部数据，但 ${Math.round(responseTimeoutMs / 60_000)} 分钟内未返回处理结果。`
              )
            );
          }, responseTimeoutMs);
        }
      } catch (error) {
        request.destroy(error);
      }
    })();
  });
}

function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sha256File(filename, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function fetchGithubRelease(repository, tagName, token, fetchImpl = fetch, signal) {
  const url = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Git-UI-Pro-Gitee-Mirror",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    { headers },
    REQUEST_TIMEOUT_MS,
    signal,
    `读取 GitHub ${tagName} Release `
  );
  if (!response.ok) {
    throw new Error(`读取 GitHub ${tagName} Release 失败（HTTP ${response.status}）。`);
  }
  const release = await response.json();
  if (release?.tag_name !== tagName || release.draft === true || release.prerelease === true) {
    throw new Error(`GitHub ${tagName} 不是可镜像的正式发行版。`);
  }
  return release;
}

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursively(candidate);
    }
    return entry.isFile() ? [candidate] : [];
  }));
  return nested.flat();
}

function stableVersionFromTag(tagName) {
  const match = STABLE_TAG_PATTERN.exec(tagName);
  if (!match) {
    throw new Error(`只允许同步稳定版本标签，收到：${tagName}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function compareStableTags(leftTag, rightTag) {
  const left = stableVersionFromTag(leftTag).split(".").map(Number);
  const right = stableVersionFromTag(rightTag).split(".").map(Number);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function isManagedReleaseAsset(filename) {
  return typeof filename === "string" && MANAGED_RELEASE_ASSET_PATTERNS.some((pattern) => pattern.test(filename));
}

function normalizeRetentionCount(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_GITEE_RELEASE_RETENTION;
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
    throw new Error("Gitee 正式版附件保留数量必须是 1 到 20 之间的整数。");
  }
  return count;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\r\n/g, "\n") : "";
}

function requiredValue(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少环境变量 ${name}。`);
  }
  return value.trim();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  syncGiteeRelease().then(
    (result) => {
      console.log(`Gitee 国内更新源已同步：${result.releaseUrl}`);
      console.log(`已上传：${result.assets.join("、")}`);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
