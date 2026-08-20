import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCommitMessage,
  collectArtifacts,
  compareVersions,
  createGitHubProxyTransport,
  detectProvider,
  expectedWindowsUpdateArtifacts,
  isTransientGitIndexLockFailure,
  isTransientGitNetworkFailure,
  mergeReleaseNotes,
  parseGiteeRepository,
  parseGitHubRepository,
  parseStatusPorcelain,
  parseVersion,
  recommendVersions,
  retryPush,
  resolveGitHubProxy,
  resolveNpmInvocation,
  runGitWithIndexLockRetry,
  runGitWithNetworkRetry,
  runProcess,
  startReleaseConsole,
  validateWindowsUpdateArtifacts,
  waitForGitHubReleaseReady
} from "./release-console.mjs";
import { collectWindowsUpdateFiles, createGiteeUpdateManifest, syncGiteeRelease } from "./sync-gitee-release.mjs";

test("解析并推荐稳定版本号", () => {
  assert.deepEqual(parseVersion("0.1.5"), { major: 0, minor: 1, patch: 5, text: "0.1.5" });
  assert.equal(parseVersion("v0.1.5"), null);
  assert.equal(parseVersion("01.1.5"), null);
  assert.deepEqual(recommendVersions("0.1.5"), {
    patch: "0.1.6",
    minor: "0.2.0",
    major: "1.0.0"
  });
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
});

test("解析包含暂存、未暂存、未跟踪和重命名的工作区状态", () => {
  const files = parseStatusPorcelain("M  src/a.ts\0 M src/b.ts\0?? docs/new.md\0R  src/new.ts\0src/old.ts\0");
  assert.deepEqual(files, [
    { code: "M ", path: "src/a.ts", staged: true, untracked: false },
    { code: " M", path: "src/b.ts", staged: false, untracked: false },
    { code: "??", path: "docs/new.md", staged: false, untracked: true },
    { code: "R ", path: "src/new.ts", previousPath: "src/old.ts", staged: true, untracked: false }
  ]);
});

test("生成符合仓库规则的中文分段提交信息", () => {
  assert.equal(
    buildCommitMessage({
      title: "chore(release): 发布 v0.1.6",
      notes: ["更新版本号", "生成 Windows 安装包"],
      files: ["package.json", "package-lock.json"]
    }),
    "chore(release): 发布 v0.1.6\n\n1. 更新版本号\n2. 生成 Windows 安装包\n\n涉及文件:\n1. package.json\n2. package-lock.json\n"
  );
});

test("自动版本说明不能被提交请求删除", () => {
  assert.deepEqual(
    mergeReleaseNotes(["自动记录一", "自动记录二"], ["自动记录二", "补充说明"]),
    ["自动记录一", "自动记录二", "补充说明"]
  );
  assert.deepEqual(mergeReleaseNotes(["自动记录一"], []), ["自动记录一"]);
});

test("识别 GitHub 与 Gitee 远端", () => {
  assert.equal(detectProvider("https://github.com/example/repo.git"), "github");
  assert.equal(detectProvider("git@gitee.com:example/repo.git"), "gitee");
  assert.equal(detectProvider("https://git.example.com/repo.git"), "other");
});

test("从常见 GitHub 远端地址解析仓库", () => {
  const expected = { owner: "example-owner", repository: "repo.name" };
  assert.deepEqual(parseGitHubRepository("https://github.com/example-owner/repo.name.git"), expected);
  assert.deepEqual(parseGitHubRepository("git@github.com:example-owner/repo.name.git"), expected);
  assert.deepEqual(parseGitHubRepository("ssh://git@github.com/example-owner/repo.name.git"), expected);
  assert.deepEqual(parseGitHubRepository("git+https://github.com/example-owner/repo.name.git"), expected);
  assert.equal(parseGitHubRepository("https://gitee.com/example-owner/repo.name.git"), null);
  assert.equal(parseGitHubRepository("https://github.com/example-owner/repo/extra"), null);
});

test("GitHub 正式版检查复用 Git URL 匹配代理", async () => {
  const commandCalls = [];
  const proxyUrl = await resolveGitHubProxy(
    "https://github.com/example/repo/releases/download/v1.0.0/latest.yml",
    {
      runCommand: async (args, options) => {
        commandCalls.push({ args, options });
        return { code: 0, stdout: "http://127.0.0.1:7897\n", stderr: "", timedOut: false };
      }
    }
  );
  assert.equal(proxyUrl, "http://127.0.0.1:7897/");
  assert.deepEqual(commandCalls, [{
    args: ["config", "--get-urlmatch", "http.proxy", "https://github.com/example/repo/releases/download/v1.0.0/latest.yml"],
    options: { allowFailure: true }
  }]);

  let receivedDispatcher = null;
  let dispatcherClosed = false;
  const dispatcher = { close: async () => { dispatcherClosed = true; } };
  const transport = createGitHubProxyTransport(proxyUrl, {
    createDispatcher: (url) => {
      assert.equal(url, proxyUrl);
      return dispatcher;
    },
    fetchImpl: async (_url, options) => {
      receivedDispatcher = options.dispatcher;
      return new Response("ok");
    }
  });
  assert.equal((await transport.fetchImpl("https://github.com/example/repo")).status, 200);
  assert.equal(receivedDispatcher, dispatcher);
  await transport.close();
  assert.equal(dispatcherClosed, true);
});

test("GitHub 代理未配置时保持直连，配置读取失败或协议不受支持时明确拒绝", async () => {
  assert.equal(await resolveGitHubProxy("https://github.com/example/repo", {
    runCommand: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false })
  }), null);

  assert.equal(await resolveGitHubProxy("https://github.com/example/repo", {
    runCommand: async () => ({ code: 0, stdout: "socks5://127.0.0.1:7897", stderr: "", timedOut: false })
  }), "socks5://127.0.0.1:7897");

  await assert.rejects(
    resolveGitHubProxy("https://github.com/example/repo", {
      runCommand: async () => ({ code: 2, stdout: "", stderr: "配置读取失败", timedOut: false })
    }),
    /读取 GitHub 的 Git 代理配置失败：配置读取失败/
  );
  await assert.rejects(
    resolveGitHubProxy("https://github.com/example/repo", {
      runCommand: async () => ({ code: 0, stdout: "socks5h://127.0.0.1:7897", stderr: "", timedOut: false })
    }),
    /代理协议 socks5h: 不受发布控制台支持/
  );
});

test("只将临时 Git 网络故障识别为可重试错误", () => {
  assert.equal(
    isTransientGitNetworkFailure("fatal: unable to access 'https://github.com/example/repo.git/': schannel: failed to receive handshake, SSL/TLS connection failed"),
    true
  );
  assert.equal(isTransientGitNetworkFailure("fatal: unable to access repository: Failed to connect to github.com"), true);
  assert.equal(isTransientGitNetworkFailure("GnuTLS recv error (-110): The TLS connection was non-properly terminated."), true);
  assert.equal(isTransientGitNetworkFailure("fatal: unable to access repository: Connection refused"), true);
  assert.equal(isTransientGitNetworkFailure("remote: Repository not found.\nfatal: Authentication failed"), false);
  assert.equal(isTransientGitNetworkFailure("error: RPC failed; HTTP 401 curl 22"), false);
  assert.equal(isTransientGitNetworkFailure("error: RPC failed; HTTP 403 curl 22"), false);
  assert.equal(isTransientGitNetworkFailure("SSL certificate problem: certificate has expired"), false);
  assert.equal(isTransientGitNetworkFailure("fatal: couldn't find remote ref refs/heads/master"), false);
});

test("临时网络故障恢复后停止重试", async () => {
  const results = [
    { code: 1, stdout: "", stderr: "Connection was reset", timedOut: false },
    { code: 1, stdout: "", stderr: "", timedOut: true },
    { code: 0, stdout: "ok", stderr: "", timedOut: false }
  ];
  const waits = [];
  const job = { logs: [] };
  let calls = 0;
  const result = await runGitWithNetworkRetry(["ls-remote", "github"], {
    job,
    retryLabel: "github ",
    retryDelays: [0, 0],
    runCommand: async () => results[calls++],
    wait: async (delayMs) => waits.push(delayMs)
  });

  assert.equal(result.stdout, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [0, 0]);
  assert.deepEqual(
    job.logs.map((entry) => entry.message),
    ["github 连接暂时中断，0 秒后自动重试（2/3）", "github 连接暂时中断，0 秒后自动重试（3/3）"]
  );
});

test("非网络错误不会重试，连续网络错误最多尝试三次", async () => {
  let calls = 0;
  await assert.rejects(
    runGitWithNetworkRetry(["ls-remote", "github"], {
      retryDelays: [0, 0],
      runCommand: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "Authentication failed", timedOut: false };
      },
      wait: async () => {}
    }),
    /Authentication failed/
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    runGitWithNetworkRetry(["ls-remote", "github"], {
      retryDelays: [0, 0],
      runCommand: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "Connection timed out", timedOut: false };
      },
      wait: async () => {}
    }),
    /已自动尝试 3 次/
  );
  assert.equal(calls, 3);
});

test("只把 Git index.lock 临时占用识别为可重试错误", () => {
  assert.equal(
    isTransientGitIndexLockFailure(
      "fatal: Unable to create 'E:/Projects/Git-UI-Pro/.git/index.lock': File exists. Another git process seems to be running"
    ),
    true
  );
  assert.equal(isTransientGitIndexLockFailure("fatal: could not lock index file .git/index.lock: File exists"), true);
  assert.equal(isTransientGitIndexLockFailure("fatal: Unable to create '.git/index.lock': Permission denied"), false);
  assert.equal(isTransientGitIndexLockFailure("fatal: not a git repository"), false);
});

test("Git 索引锁释放后继续执行且保留安全的显示参数", async () => {
  const results = [
    {
      code: 128,
      stdout: "",
      stderr: "fatal: Unable to create 'E:/repo/.git/index.lock': File exists.",
      timedOut: false
    },
    { code: 0, stdout: "ok", stderr: "", timedOut: false }
  ];
  const calls = [];
  const waits = [];
  const job = { logs: [] };
  const result = await runGitWithIndexLockRetry(["commit", "-F", "secret-path"], {
    job,
    displayArgs: ["commit", "-F", "<release-message>"],
    retryDelays: [25],
    runCommand: async (args, options) => {
      calls.push({ args, options });
      return results[calls.length - 1];
    },
    wait: async (delayMs) => waits.push(delayMs)
  });

  assert.equal(result.stdout, "ok");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options.displayArgs, ["commit", "-F", "<release-message>"]);
  assert.equal(calls[0].options.allowFailure, true);
  assert.deepEqual(waits, [25]);
  assert.deepEqual(job.logs.map((entry) => entry.message), ["Git 索引暂时被占用，0.025 秒后自动重试（2/2）"]);
});

test("Git 索引非锁错误立即失败且不重试", async () => {
  let calls = 0;
  await assert.rejects(
    runGitWithIndexLockRetry(["add", "-A"], {
      retryDelays: [0, 0],
      runCommand: async () => {
        calls += 1;
        return { code: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false };
      },
      wait: async () => {}
    }),
    /not a git repository/
  );
  assert.equal(calls, 1);
});

test("命令超时会终止包含子进程的进程树", { timeout: 10_000 }, async () => {
  const childScript = [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
    "setInterval(() => {}, 1000);"
  ].join("");
  const startedAt = Date.now();
  const result = await runProcess(process.execPath, ["-e", childScript], {
    allowFailure: true,
    timeoutMs: 500
  });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 5_000, "进程树应在超时后及时退出");
});

test("Windows 通过 Node 执行 npm CLI，避免直接 spawn npm.cmd", () => {
  const invocation = resolveNpmInvocation({
    platform: "win32",
    execPath: "C:\\node\\node.exe",
    npmExecPath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
    fileExists: (candidate) => candidate.endsWith("npm-cli.js")
  });
  assert.deepEqual(invocation, {
    command: "C:\\node\\node.exe",
    prefixArgs: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js"]
  });
});

test("当前环境解析出的 npm 调用可以正常启动", () => {
  const invocation = resolveNpmInvocation();
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, "--version"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("收集 Windows 安装版与 Portable 正式发布所需的四项产物", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "git-ui-pro-release-"));
  const version = "0.1.13";
  const expected = expectedWindowsUpdateArtifacts(version);
  try {
    await Promise.all([
      writeFile(path.join(directory, expected.installer), "installer"),
      writeFile(path.join(directory, expected.blockmap), "blockmap"),
      writeFile(path.join(directory, expected.metadata), "version: 0.1.13"),
      writeFile(path.join(directory, expected.portable), "portable"),
      writeFile(path.join(directory, "Git-UI-Pro-Setup-0.1.12-x64.exe"), "stale")
    ]);

    const artifacts = await collectArtifacts(version, directory);
    assert.deepEqual(
      artifacts.map((artifact) => artifact.name).sort(),
      Object.values(expected).sort()
    );
    assert.equal(validateWindowsUpdateArtifacts(version, artifacts).valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("从常见 Gitee 远端地址解析仓库", () => {
  const expected = { owner: "example-owner", repository: "repo.name" };
  assert.deepEqual(parseGiteeRepository("https://gitee.com/example-owner/repo.name.git"), expected);
  assert.deepEqual(parseGiteeRepository("git@gitee.com:example-owner/repo.name.git"), expected);
  assert.equal(parseGiteeRepository("https://github.com/example-owner/repo.name.git"), null);
});

test("Gitee 镜像清单固定绑定标签、安装包名称、大小与 SHA-256", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "git-ui-pro-gitee-mirror-"));
  const nested = path.join(directory, "windows-x64");
  const version = "0.1.26";
  const installer = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const portable = `Git-UI-Pro-Portable-${version}-x64.exe`;
  try {
    await mkdir(nested, { recursive: true });
    await Promise.all([
      writeFile(path.join(nested, installer), "installer"),
      writeFile(path.join(nested, `${installer}.blockmap`), "blockmap"),
      writeFile(path.join(nested, portable), "portable"),
      writeFile(path.join(nested, "latest.yml"), `version: ${version}`)
    ]);
    const files = await collectWindowsUpdateFiles(directory, `v${version}`);
    assert.deepEqual([...files.keys()], [installer, `${installer}.blockmap`, portable, "latest.yml"]);

    const manifest = createGiteeUpdateManifest(`v${version}`, {
      name: installer,
      size: 82_000_000,
      sha256: "B".repeat(64)
    }, {
      name: portable,
      size: 80_000_000,
      sha256: "C".repeat(64)
    });
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      version,
      tagName: `v${version}`,
      installer: {
        name: installer,
        size: 82_000_000,
        sha256: "b".repeat(64)
      },
      portable: {
        name: portable,
        size: 80_000_000,
        sha256: "c".repeat(64)
      }
    });
    assert.throws(
      () => createGiteeUpdateManifest(
        `v${version}`,
        { name: "foreign.exe", size: 1, sha256: "a".repeat(64) },
        { name: portable, size: 1, sha256: "b".repeat(64) }
      ),
      /安装包信息无效/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gitee 镜像发布时先创建发行版并最后上传校验清单", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "git-ui-pro-gitee-publish-"));
  const version = "0.1.26";
  const tagName = `v${version}`;
  const installer = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const portable = `Git-UI-Pro-Portable-${version}-x64.exe`;
  const uploads = [];
  const requests = [];
  const deletedAssets = [];
  const uploadedAssets = [{ id: 99, name: installer, size: Buffer.byteLength("installer") }];
  try {
    await Promise.all([
      writeFile(path.join(directory, installer), "installer"),
      writeFile(path.join(directory, `${installer}.blockmap`), "blockmap"),
      writeFile(path.join(directory, portable), "portable"),
      writeFile(path.join(directory, "latest.yml"), `version: ${version}`)
    ]);
    const fetchImpl = async (requestUrl, options = {}) => {
      const url = new URL(requestUrl);
      requests.push({ host: url.hostname, path: url.pathname, method: options.method ?? "GET" });
      if (url.hostname === "api.github.com") {
        return Response.json({
          tag_name: tagName,
          name: `Git UI Pro v${version}`,
          body: "同步国内镜像",
          draft: false,
          prerelease: false
        });
      }
      if (url.pathname.endsWith(`/releases/tags/${tagName}`)) {
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/releases") && options.method === "POST") {
        return Response.json({ id: 26, tag_name: tagName });
      }
      if (url.pathname.endsWith("/releases") && (options.method ?? "GET") === "GET") {
        return Response.json([
          { id: 26, tag_name: tagName },
          { id: 25, tag_name: "v0.1.25" },
          { id: 24, tag_name: "v0.1.24" },
          { id: 23, tag_name: "v0.1.23" }
        ]);
      }
      if (url.pathname.endsWith("/releases/26/attach_files") && (options.method ?? "GET") === "GET") {
        return Response.json(uploadedAssets);
      }
      if (url.pathname.endsWith("/releases/23/attach_files") && (options.method ?? "GET") === "GET") {
        return Response.json([
          { id: 230, name: "Git-UI-Pro-Setup-0.1.23-x64.exe", size: 82_000_000 },
          { id: 231, name: "manual-notes.txt", size: 100 }
        ]);
      }
      if (url.pathname.endsWith("/releases/23/attach_files/230") && options.method === "DELETE") {
        deletedAssets.push(230);
        return new Response(null, { status: 204 });
      }
      throw new Error(`未处理的镜像请求：${options.method ?? "GET"} ${url}`);
    };
    const progressEvents = [];
    const uploadImpl = async ({ url, token, filename, source, timeoutMs, idleTimeoutMs, responseTimeoutMs, onProgress }) => {
      assert.equal(new URL(url).pathname, "/api/v5/repos/zjx_master/git-ui-pro/releases/26/attach_files");
      assert.equal(token, "gitee-secret");
      assert.equal(timeoutMs, 25 * 60_000);
      assert.equal(idleTimeoutMs, 2 * 60_000);
      assert.equal(responseTimeoutMs, 3 * 60_000);
      assert.equal(Boolean(source.filePath) || Buffer.isBuffer(source.data), true);
      uploads.push(filename);
      const size = source.filePath ? (await stat(source.filePath)).size : source.data.length;
      onProgress?.({ uploadedBytes: size, totalBytes: size, percent: 100 });
      uploadedAssets.push({ id: uploads.length, name: filename, size });
    };

    const result = await syncGiteeRelease({
      giteeToken: "gitee-secret",
      githubRepository: "example/repo",
      tagName,
      artifactsDirectory: directory,
      giteeOwner: "zjx_master",
      giteeRepository: "git-ui-pro",
      fetchImpl,
      uploadImpl,
      onProgress: (event) => progressEvents.push(event)
    });

    assert.deepEqual(uploads, [`${installer}.blockmap`, portable, "latest.yml", "update-manifest.json"]);
    assert.deepEqual(deletedAssets, [230]);
    assert.deepEqual(result.skippedAssets, [installer]);
    assert.equal(result.releaseUrl, `https://gitee.com/zjx_master/git-ui-pro/releases/tag/${tagName}`);
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(requests.filter((request) => request.path.endsWith("/attach_files")).length, 11);
    assert.equal(progressEvents.at(-1).phase, "completed");
    assert.equal(progressEvents.some((event) => event.phase === "cleanup" && /释放 78\.2 MB/.test(event.message)), true);
    assert.equal(progressEvents.at(-1).overallUploadedBytes, progressEvents.at(-1).overallTotalBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gitee 镜像在启动前取消时不会发起任何网络或文件操作", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    syncGiteeRelease({
      giteeToken: "gitee-secret",
      githubRepository: "example/repo",
      tagName: "v0.1.26",
      artifactsDirectory: ".",
      signal: controller.signal,
      fetchImpl: async () => {
        throw new Error("取消后不应访问网络");
      }
    }),
    /已取消/
  );
});

test("缺少 blockmap、Portable 或 latest.yml 时拒绝发布 Windows 正式版", () => {
  const version = "0.1.13";
  const expected = expectedWindowsUpdateArtifacts(version);
  const validation = validateWindowsUpdateArtifacts(version, [
    { name: expected.installer, size: 1 }
  ]);

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missing, [expected.blockmap, expected.portable, expected.metadata]);
});

test("等待 GitHub 安装包与最新版指针全部就绪后才完成发布", async () => {
  const version = "0.1.17";
  const tag = `v${version}`;
  const expected = expectedWindowsUpdateArtifacts(version);
  const requestedUrls = [];
  const progress = [];
  let metadataCalls = 0;
  let blockmapCalls = 0;
  let latestCalls = 0;
  let clock = 0;

  const fetchImpl = async (requestUrl) => {
    const url = new URL(requestUrl);
    requestedUrls.push(url);
    if (url.pathname.endsWith(`/${expected.metadata}`)) {
      metadataCalls += 1;
      if (metadataCalls === 1) {
        return new Response(null, { status: 404 });
      }
      return new Response(`version: ${version}\nfiles:\n  - url: ${expected.installer}\n`, { status: 200 });
    }
    if (url.pathname.endsWith(`/${expected.installer}`)) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://objects.githubusercontent.com/installer" }
      });
    }
    if (url.pathname.endsWith(`/${expected.blockmap}`)) {
      blockmapCalls += 1;
      return blockmapCalls === 1
        ? new Response(null, { status: 404 })
        : new Response(null, {
            status: 302,
            headers: { location: "https://objects.githubusercontent.com/blockmap" }
          });
    }
    if (url.pathname.endsWith(`/${expected.portable}`)) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://objects.githubusercontent.com/portable" }
      });
    }
    if (url.pathname.endsWith("/releases/latest")) {
      latestCalls += 1;
      const latestTag = latestCalls === 1 ? "v0.1.16" : tag;
      return new Response(null, {
        status: 302,
        headers: { location: `https://github.com/example/repo/releases/tag/${latestTag}` }
      });
    }
    throw new Error(`未处理的测试请求：${url}`);
  };

  const result = await waitForGitHubReleaseReady(
    { owner: "example", repository: "repo" },
    tag,
    version,
    {
      fetchImpl,
      timeoutMs: 100,
      pollIntervalMs: 10,
      requestTimeoutMs: 10,
      now: () => clock,
      wait: async (delayMs) => {
        clock += delayMs;
      },
      onProgress: (entry) => progress.push(entry)
    }
  );

  assert.deepEqual(result, {
    tag,
    version,
    latestTag: tag,
    assets: Object.values(expected)
  });
  assert.deepEqual(progress.map((entry) => entry.key), [
    "waiting-release",
    "waiting-assets",
    "waiting-latest",
    "ready"
  ]);
  assert.equal(metadataCalls, 4);
  assert.equal(blockmapCalls, 3);
  assert.equal(latestCalls, 2);
  assert.ok(requestedUrls.every((url) => url.searchParams.has("release-console")));
});

test("GitHub Actions 超时未生成正式安装包时保留可重试错误", async () => {
  let clock = 0;
  await assert.rejects(
    waitForGitHubReleaseReady(
      { owner: "example", repository: "repo" },
      "v0.1.17",
      "0.1.17",
      {
        fetchImpl: async () => new Response(null, { status: 404 }),
        timeoutMs: 25,
        pollIntervalMs: 10,
        requestTimeoutMs: 10,
        now: () => clock,
        wait: async (delayMs) => {
          clock += delayMs;
        }
      }
    ),
    /标签 v0\.1\.17 已推送，但 GitHub Windows 正式版.*请检查 .*\/actions，工作流完成后重试发布流程/
  );
});

test("GitHub 正式版等待时间会中止仍在挂起的网络请求", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    waitForGitHubReleaseReady(
      { owner: "example", repository: "repo" },
      "v0.1.17",
      "0.1.17",
      {
        fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        }),
        timeoutMs: 40,
        pollIntervalMs: 10,
        requestTimeoutMs: 1_000
      }
    ),
    /GitHub Windows 正式版在 1 分钟内仍未就绪/
  );
  assert.ok(Date.now() - startedAt < 250, "总等待时间不应被单次网络请求额外延长");
});

test("GitHub 证书错误会立即停止正式版检查", async () => {
  let calls = 0;
  await assert.rejects(
    waitForGitHubReleaseReady(
      { owner: "example", repository: "repo" },
      "v0.1.17",
      "0.1.17",
      {
        fetchImpl: async () => {
          calls += 1;
          throw new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
        },
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        requestTimeoutMs: 100
      }
    ),
    /GitHub TLS 证书校验失败（CERT_HAS_EXPIRED）/
  );
  assert.equal(calls, 1);
});

test("GitHub 确定性 HTTP 错误不会反复重试", async () => {
  let calls = 0;
  await assert.rejects(
    waitForGitHubReleaseReady(
      { owner: "example", repository: "repo" },
      "v0.1.17",
      "0.1.17",
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 403 });
        },
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        requestTimeoutMs: 100
      }
    ),
    /latest\.yml 返回 HTTP 403/
  );
  assert.equal(calls, 1);
});

test("拒绝将非 GitHub 资产或其他仓库的重定向判定为发布完成", async () => {
  const version = "0.1.17";
  const tag = `v${version}`;
  const expected = expectedWindowsUpdateArtifacts(version);
  const metadata = `version: ${version}\nfiles:\n  - url: ${expected.installer}\n`;

  await assert.rejects(
    waitForGitHubReleaseReady(
      { owner: "example", repository: "repo" },
      tag,
      version,
      {
        fetchImpl: async (requestUrl) => {
          const url = new URL(requestUrl);
          if (url.pathname.endsWith(`/${expected.metadata}`)) {
            return new Response(metadata, { status: 200 });
          }
          return new Response(null, {
            status: 302,
            headers: { location: "https://download.example.com/file" }
          });
        },
        timeoutMs: 100,
        pollIntervalMs: 10,
        requestTimeoutMs: 10
      }
    ),
    /非 GitHub 发布资产地址/
  );

  await assert.rejects(
    waitForGitHubReleaseReady(
      { owner: "example", repository: "repo" },
      tag,
      version,
      {
        fetchImpl: async (requestUrl) => {
          const url = new URL(requestUrl);
          if (url.pathname.endsWith(`/${expected.metadata}`)) {
            return new Response(metadata, { status: 200 });
          }
          if (url.pathname.endsWith("/releases/latest")) {
            return new Response(null, {
              status: 302,
              headers: { location: `https://github.com/another/repo/releases/tag/${tag}` }
            });
          }
          return new Response(null, {
            status: 302,
            headers: { location: "https://release-assets.githubusercontent.com/file" }
          });
        },
        timeoutMs: 100,
        pollIntervalMs: 10,
        requestTimeoutMs: 10
      }
    ),
    /非目标仓库重定向/
  );
});

function createRetryJob(pushedRemotes) {
  return {
    id: "retry-test",
    state: "failed",
    currentStage: "github",
    stages: [
      { key: "gitee", label: "推送 Gitee", status: pushedRemotes.gitee ? "completed" : "failed" },
      { key: "github", label: "GitHub 正式版", status: "failed" }
    ],
    logs: [],
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    version: "0.1.17",
    tag: "v0.1.17",
    artifacts: [],
    error: "测试失败",
    canRetryPush: true,
    pushedRemotes: { ...pushedRemotes },
    releaseContext: {
      branch: "master",
      gitee: { name: "origin" },
      github: { name: "github" }
    }
  };
}

test("远端均已推送时重试只检查正式版并可再次重试", async () => {
  const job = createRetryJob({ gitee: true, github: true });
  const calls = [];
  await retryPush(job, {
    verifyTag: async () => calls.push("verify"),
    pushRemote: async (key) => calls.push(`push:${key}`),
    confirmRelease: async () => calls.push("confirm")
  });

  assert.deepEqual(calls, ["confirm"]);
  assert.equal(job.state, "completed");
  assert.equal(job.canRetryPush, false);
  assert.equal(job.stages.find((stage) => stage.key === "github").status, "completed");

  const failedJob = createRetryJob({ gitee: true, github: true });
  await assert.rejects(
    retryPush(failedJob, {
      verifyTag: async () => {
        throw new Error("不应校验 HEAD");
      },
      pushRemote: async () => {
        throw new Error("不应重复推送");
      },
      confirmRelease: async () => {
        throw new Error("正式版尚未就绪");
      }
    }),
    /正式版尚未就绪/
  );
  assert.equal(failedJob.state, "failed");
  assert.equal(failedJob.canRetryPush, true);
  assert.equal(failedJob.stages.find((stage) => stage.key === "github").status, "failed");
});

test("部分远端已推送时只补推缺失远端", async () => {
  const job = createRetryJob({ gitee: true, github: false });
  const calls = [];
  await retryPush(job, {
    verifyTag: async () => calls.push("verify"),
    pushRemote: async (key) => calls.push(`push:${key}`),
    confirmRelease: async () => calls.push("confirm")
  });

  assert.deepEqual(calls, ["verify", "push:github", "confirm"]);
  assert.deepEqual(job.pushedRemotes, { gitee: true, github: true });
  assert.equal(job.state, "completed");
});

test("发布控制台仅凭令牌返回仓库状态", async () => {
  const { server, url, token } = await startReleaseConsole({ port: 0, openBrowser: false });
  try {
    const forbidden = await fetch(`${url}/api/status`);
    assert.equal(forbidden.status, 403);

    const forbiddenMutation = await fetch(`${url}/api/releases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-token": token
      },
      body: "{}"
    });
    assert.equal(forbiddenMutation.status, 403);

    const response = await fetch(`${url}/api/status`, {
      headers: { "x-release-token": token }
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.repository, "git-ui-pro");
    assert.ok(parseVersion(status.packageVersion));
    assert.ok(compareVersions(status.recommendations.patch, status.baselineVersion) > 0);
    assert.equal(status.remotes.gitee.provider, "gitee");
    assert.ok(Array.isArray(status.history));
    assert.ok(Array.isArray(status.files));

    const noJobResponse = await fetch(`${url}/api/jobs/latest`, {
      headers: { "x-release-token": token }
    });
    assert.equal(noJobResponse.status, 200);
    assert.equal(await noJobResponse.json(), null);

    const noMirrorResponse = await fetch(`${url}/api/gitee-mirror`, {
      headers: { "x-release-token": token }
    });
    assert.equal(noMirrorResponse.status, 200);
    assert.equal(await noMirrorResponse.json(), null);
    assert.equal(typeof status.giteeMirror.tokenConfigured, "boolean");
    assert.match(status.giteeMirror.defaultTag, /^v\d+\.\d+\.\d+$/);

    const createResponse = await fetch(`${url}/api/releases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": url,
        "x-release-token": token
      },
      body: JSON.stringify({
        version: "invalid",
        notes: ["测试恢复任务"],
        buildMode: "unsigned",
        expectedCurrentVersion: status.packageVersion
      })
    });
    assert.equal(createResponse.status, 202);
    const createdJob = await createResponse.json();

    const latestJobResponse = await fetch(`${url}/api/jobs/latest`, {
      headers: { "x-release-token": token }
    });
    assert.equal(latestJobResponse.status, 200);
    assert.equal((await latestJobResponse.json()).id, createdJob.id);

    let terminalJob = createdJob;
    for (let attempt = 0; attempt < 200 && ["queued", "running"].includes(terminalJob.state); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const jobResponse = await fetch(`${url}/api/jobs/${createdJob.id}`, {
        headers: { "x-release-token": token }
      });
      terminalJob = await jobResponse.json();
    }
    assert.equal(terminalJob.state, "failed");

    const restoredJobResponse = await fetch(`${url}/api/jobs/latest`, {
      headers: { "x-release-token": token }
    });
    const restoredJob = await restoredJobResponse.json();
    assert.equal(restoredJob.id, createdJob.id);
    assert.equal(restoredJob.state, "failed");
    assert.equal(restoredJob.canRetryPush, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
