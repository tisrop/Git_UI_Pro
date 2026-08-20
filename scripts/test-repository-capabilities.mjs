import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { GitService, parseHostedRemoteUrl } = require("../dist-electron/gitService.js");
const testRoot = await mkdtemp(path.join(os.tmpdir(), "git-ui-pro-capabilities-"));

function git(repositoryPath, ...args) {
  return execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function createRepository(name) {
  const repositoryPath = path.join(testRoot, name);
  const service = new GitService();
  const initResult = await service.initializeRepository(repositoryPath, "main");
  assert.equal(initResult.ok, true, initResult.messageZh ?? initResult.stderr);
  git(repositoryPath, "config", "user.name", "Capability Test");
  git(repositoryPath, "config", "user.email", "capability-test@example.com");
  git(repositoryPath, "config", "core.autocrlf", "false");
  await writeFile(path.join(repositoryPath, "tracked.txt"), "base\n", "utf8");
  git(repositoryPath, "add", "tracked.txt");
  git(repositoryPath, "commit", "-m", "base");
  return repositoryPath;
}

function assertSuccess(result) {
  assert.equal(result.ok, true, result.messageZh ?? result.stderr);
}

test("file diffs include whole-file context and preserve patch-like source lines", async () => {
  const repositoryPath = await createRepository("full-file-diff");
  const service = new GitService();
  const filePath = path.join(repositoryPath, "tracked.txt");
  const originalLines = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`);
  await writeFile(filePath, `${originalLines.join("\n")}\n`, "utf8");
  git(repositoryPath, "add", "tracked.txt");
  git(repositoryPath, "commit", "-m", "full diff baseline");

  const currentLines = [...originalLines];
  currentLines[7] = "++ changed marker";
  await writeFile(filePath, `${currentLines.join("\n")}\n`, "utf8");

  const worktreeDiff = await service.getWorktreeDiff(repositoryPath, "tracked.txt", false);
  assert.equal(worktreeDiff[0].content, "line 1");
  assert.equal(worktreeDiff.at(-1).content, "line 15");
  assert.equal(worktreeDiff.filter((line) => line.type === "context").length, 14);
  assert.equal(worktreeDiff.find((line) => line.type === "add")?.content, "++ changed marker");

  git(repositoryPath, "add", "tracked.txt");
  git(repositoryPath, "commit", "-m", "change middle line");
  const commitHash = git(repositoryPath, "rev-parse", "HEAD");
  const commitDiff = await service.getCommitDiff(repositoryPath, commitHash, "tracked.txt");
  assert.equal(commitDiff[0].content, "line 1");
  assert.equal(commitDiff.at(-1).content, "line 15");
  assert.equal(commitDiff.find((line) => line.type === "add")?.content, "++ changed marker");
});

test("long Git operations expose an explicit cancelling state and reject unknown task ids", () => {
  const service = new GitService();
  const progress = [];
  let killed = false;
  service.activeLongOperations.set("operation-123456", {
    child: { kill: () => { killed = true; } },
    context: {
      id: "operation-123456",
      kind: "fetch",
      label: "获取远程更新",
      repositoryPath: "repo",
      onProgress: (value) => progress.push(value)
    },
    cancelled: false
  });

  assert.equal(service.cancelLongOperation("operation-123456"), true);
  assert.equal(killed, true);
  assert.equal(service.activeLongOperations.get("operation-123456").cancelled, true);
  assert.equal(progress.at(-1).phase, "cancelling");
  assert.equal(progress.at(-1).message, "正在取消");
  assert.equal(service.cancelLongOperation("missing-operation"), false);
});

test("stash operations preserve explicit apply, pop, and drop behavior", async () => {
  const repositoryPath = await createRepository("stash");
  const service = new GitService();

  await writeFile(path.join(repositoryPath, "tracked.txt"), "stashed\n", "utf8");
  await writeFile(path.join(repositoryPath, "untracked.txt"), "untracked\n", "utf8");
  assertSuccess(await service.createStash(repositoryPath, { message: "saved state", includeUntracked: true }));
  const [entry] = await service.getStashes(repositoryPath);
  assert.equal(entry.selector, "stash@{0}");
  assert.match(entry.subject, /saved state/);

  await writeFile(path.join(repositoryPath, "tracked.txt"), "newer stash\n", "utf8");
  assertSuccess(await service.createStash(repositoryPath, { message: "newer state" }));
  const [newerEntry] = await service.getStashes(repositoryPath);
  assertSuccess(await service.applyStash(repositoryPath, entry.hash));
  assert.equal(await readFile(path.join(repositoryPath, "tracked.txt"), "utf8"), "stashed\n");
  git(repositoryPath, "reset", "--hard");
  git(repositoryPath, "clean", "-fd");
  assertSuccess(await service.dropStash(repositoryPath, entry.hash));
  assertSuccess(await service.popStash(repositoryPath, newerEntry.hash));
  assert.equal(await readFile(path.join(repositoryPath, "tracked.txt"), "utf8"), "newer stash\n");
  assert.equal((await service.getStashes(repositoryPath)).length, 0);
});

test("every push command path uses force-with-lease only when explicitly requested and never uses bare force", async () => {
  const service = new GitService();
  const calls = [];
  service.getStatus = async () => ({
    currentBranch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    hasConflicts: false,
    conflictedCount: 0
  });
  service.run = async (_cwd, args) => {
    calls.push(args);
    return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
  };

  assertSuccess(await service.push("repo"));
  assertSuccess(await service.push("repo", { forceWithLease: true }));
  service.getStatus = async () => ({
    currentBranch: "feature/rewrite",
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    hasConflicts: false,
    conflictedCount: 0
  });
  service.getPushRemote = async () => "origin";
  assertSuccess(await service.push("repo"));
  assertSuccess(await service.push("repo", { forceWithLease: true }));

  service.getStatus = async () => ({
    currentBranch: null,
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    hasConflicts: false,
    conflictedCount: 0
  });
  assertSuccess(await service.push("repo"));
  assertSuccess(await service.push("repo", { forceWithLease: true }));

  assert.deepEqual(calls, [
    ["push", "--progress"],
    ["push", "--progress", "--force-with-lease"],
    ["push", "--progress", "--set-upstream", "origin", "feature/rewrite"],
    ["push", "--progress", "--force-with-lease", "--set-upstream", "origin", "feature/rewrite"],
    ["push", "--progress"],
    ["push", "--progress", "--force-with-lease"]
  ]);
  for (const args of calls) {
    assert.equal(args.includes("--force"), false);
    assert.equal(args.filter((arg) => arg.startsWith("--force")).every((arg) => arg === "--force-with-lease"), true);
  }
  await assert.rejects(service.push("repo", { forceWithLease: "yes" }), /必须是布尔值/);
  await assert.rejects(service.push("repo", null), /选项格式不正确/);
});

test("force-with-lease refuses to overwrite a remote branch changed by another clone", async () => {
  const repositoryPath = await createRepository("push-lease");
  const barePath = path.join(testRoot, "push-lease-remote.git");
  await mkdir(barePath);
  git(barePath, "init", "--bare", "--initial-branch=main");
  const service = new GitService();
  assertSuccess(await service.addRemote(repositoryPath, "origin", barePath));
  const firstPush = await service.push(repositoryPath);
  assertSuccess(firstPush);
  assert.doesNotMatch(firstPush.command, /(?:^|\s)--force(?:\s|$)/);

  const rootHash = git(repositoryPath, "rev-parse", "HEAD");
  await writeFile(path.join(repositoryPath, "second.txt"), "second\n", "utf8");
  git(repositoryPath, "add", "second.txt");
  git(repositoryPath, "commit", "-m", "second");
  assertSuccess(await service.push(repositoryPath));

  git(repositoryPath, "reset", "--hard", rootHash);
  const rewrittenPush = await service.push(repositoryPath, { forceWithLease: true });
  assertSuccess(rewrittenPush);
  assert.match(rewrittenPush.command, /--force-with-lease/);
  assert.doesNotMatch(rewrittenPush.command, /(?:^|\s)--force(?:\s|$)/);
  assert.equal(git(barePath, "rev-parse", "refs/heads/main"), rootHash);

  const peerPath = path.join(testRoot, "push-lease-peer");
  git(testRoot, "clone", barePath, peerPath);
  git(peerPath, "config", "user.name", "Peer Author");
  git(peerPath, "config", "user.email", "peer@example.com");
  await writeFile(path.join(peerPath, "peer.txt"), "peer\n", "utf8");
  git(peerPath, "add", "peer.txt");
  git(peerPath, "commit", "-m", "peer update");
  git(peerPath, "push", "origin", "main");
  const peerHash = git(peerPath, "rev-parse", "HEAD");

  await writeFile(path.join(repositoryPath, "local.txt"), "local\n", "utf8");
  git(repositoryPath, "add", "local.txt");
  git(repositoryPath, "commit", "-m", "local rewrite");
  const staleLeaseResult = await service.push(repositoryPath, { forceWithLease: true });
  assert.equal(staleLeaseResult.ok, false);
  assert.match(staleLeaseResult.command, /--force-with-lease/);
  assert.doesNotMatch(staleLeaseResult.command, /(?:^|\s)--force(?:\s|$)/);
  assert.equal(git(barePath, "rev-parse", "refs/heads/main"), peerHash);
});

test("repository Git identity reads effective values, saves local values, validates input, and rolls back partial updates", async () => {
  const repositoryPath = await createRepository("identity");
  const service = new GitService();
  const initial = await service.getGitIdentity(repositoryPath);
  assert.equal(initial.valid, true);
  assert.equal(initial.localName, "Capability Test");
  assert.equal(initial.localEmail, "capability-test@example.com");

  assertSuccess(await service.setGitIdentity(repositoryPath, { name: "Repository Author", email: "author@example.com" }));
  assert.equal(git(repositoryPath, "config", "--local", "user.name"), "Repository Author");
  assert.equal(git(repositoryPath, "config", "--local", "user.email"), "author@example.com");
  await assert.rejects(
    service.setGitIdentity(repositoryPath, { name: "Invalid\nName", email: "not-an-email" }),
    /不能包含控制字符.*邮箱格式不正确/
  );

  const originalRun = service.run.bind(service);
  let injectedFailure = false;
  service.run = async (cwd, args, options) => {
    if (!injectedFailure && args[0] === "config" && args[1] === "--local" && args[2] === "--replace-all" && args[3] === "user.email") {
      injectedFailure = true;
      return {
        ok: false,
        command: "git config --local --replace-all user.email",
        stdout: "",
        stderr: "injected identity failure",
        exitCode: 73,
        messageZh: "注入的身份配置失败"
      };
    }
    return originalRun(cwd, args, options);
  };
  const failedUpdate = await service.setGitIdentity(repositoryPath, { name: "Partial Author", email: "partial@example.com" });
  assert.equal(failedUpdate.ok, false);
  assert.match(failedUpdate.messageZh ?? "", /已恢复原配置/);
  assert.equal(git(repositoryPath, "config", "--local", "user.name"), "Repository Author");
  assert.equal(git(repositoryPath, "config", "--local", "user.email"), "author@example.com");
});

test("resetLastCommit safely undoes a root commit in soft, mixed, and hard modes", async () => {
  const softRepositoryPath = await createRepository("root-reset-soft");
  const softService = new GitService();
  const softHead = git(softRepositoryPath, "rev-parse", "HEAD");
  const softResult = await softService.resetLastCommit(softRepositoryPath, "soft");
  assertSuccess(softResult);
  assert.match(softResult.messageZh ?? "", /ORIG_HEAD.*保持暂存/);
  assert.equal(git(softRepositoryPath, "rev-parse", "ORIG_HEAD"), softHead);
  assert.throws(() => git(softRepositoryPath, "rev-parse", "--verify", "HEAD"));
  assert.equal(git(softRepositoryPath, "status", "--porcelain"), "A  tracked.txt");

  const mixedRepositoryPath = await createRepository("root-reset-mixed");
  const mixedService = new GitService();
  const mixedHead = git(mixedRepositoryPath, "rev-parse", "HEAD");
  const mixedResult = await mixedService.resetLastCommit(mixedRepositoryPath, "mixed");
  assertSuccess(mixedResult);
  assert.match(mixedResult.messageZh ?? "", /ORIG_HEAD.*取消暂存/);
  assert.equal(git(mixedRepositoryPath, "rev-parse", "ORIG_HEAD"), mixedHead);
  assert.throws(() => git(mixedRepositoryPath, "rev-parse", "--verify", "HEAD"));
  assert.equal(git(mixedRepositoryPath, "status", "--porcelain"), "?? tracked.txt");

  const hardRepositoryPath = await createRepository("root-reset-hard");
  const hardService = new GitService();
  const hardHead = git(hardRepositoryPath, "rev-parse", "HEAD");
  await writeFile(path.join(hardRepositoryPath, "untracked.txt"), "untracked\n", "utf8");
  const hardResult = await hardService.resetLastCommit(hardRepositoryPath, "hard");
  assertSuccess(hardResult);
  assert.match(hardResult.messageZh ?? "", /ORIG_HEAD.*工作区移除/);
  assert.equal(git(hardRepositoryPath, "rev-parse", "ORIG_HEAD"), hardHead);
  assert.throws(() => git(hardRepositoryPath, "rev-parse", "--verify", "HEAD"));
  await assert.rejects(readFile(path.join(hardRepositoryPath, "tracked.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(path.join(hardRepositoryPath, "untracked.txt"), "utf8"), "untracked\n");
  assert.equal(git(hardRepositoryPath, "status", "--porcelain"), "?? untracked.txt");

  const detachedRepositoryPath = await createRepository("root-reset-detached");
  const detachedService = new GitService();
  const detachedHead = git(detachedRepositoryPath, "rev-parse", "HEAD");
  git(detachedRepositoryPath, "checkout", "--detach", "HEAD");
  for (const mode of ["soft", "mixed", "hard"]) {
    const detachedResult = await detachedService.resetLastCommit(detachedRepositoryPath, mode);
    assert.equal(detachedResult.ok, false);
    assert.match(detachedResult.messageZh ?? "", /detached HEAD/);
    assert.equal(git(detachedRepositoryPath, "rev-parse", "HEAD"), detachedHead);
    assert.equal(git(detachedRepositoryPath, "status", "--porcelain"), "");
  }
});

test("repository, remote, branch, tag, reflog, and hosting capabilities use real Git state", async () => {
  const repositoryPath = await createRepository("repository");
  const service = new GitService();
  const barePath = path.join(testRoot, "repository-remote.git");
  await mkdir(barePath);
  git(barePath, "init", "--bare", "--initial-branch=main");

  assertSuccess(await service.addRemote(repositoryPath, "origin", barePath));
  git(repositoryPath, "push", "--set-upstream", "origin", "main");
  git(repositoryPath, "remote", "set-head", "origin", "--auto");
  const remotes = await service.getRemotes(repositoryPath);
  assert.deepEqual(remotes.map((remote) => remote.name), ["origin"]);
  assert.equal(remotes[0].fetchUrls[0].replace(/\\/g, "/"), barePath.replace(/\\/g, "/"));
  assert.equal(remotes[0].defaultBranch, "main");

  const mirrorPath = path.join(testRoot, "mirror.git");
  await mkdir(mirrorPath);
  git(mirrorPath, "init", "--bare", "--initial-branch=main");
  assertSuccess(await service.updateRemote(repositoryPath, "origin", { name: "upstream", pushUrl: mirrorPath }));
  assertSuccess(await service.setBranchUpstream(repositoryPath, "main", "upstream/main"));
  assertSuccess(await service.updateRemote(repositoryPath, "upstream", { pushUrl: null }));

  assertSuccess(await service.createBranch(repositoryPath, "feature/rename", false));
  assertSuccess(await service.renameBranch(repositoryPath, "feature/rename", "feature/renamed"));
  assertSuccess(await service.deleteBranch(repositoryPath, "feature/renamed", true));

  git(repositoryPath, "switch", "-c", "remote/delete-me");
  await writeFile(path.join(repositoryPath, "remote.txt"), "remote\n", "utf8");
  git(repositoryPath, "add", "remote.txt");
  git(repositoryPath, "commit", "-m", "remote branch");
  git(repositoryPath, "push", "upstream", "remote/delete-me");
  git(repositoryPath, "switch", "main");
  assertSuccess(await service.deleteRemoteBranch(repositoryPath, "upstream", "remote/delete-me"));

  assertSuccess(await service.createTag(repositoryPath, "v-test", "HEAD", "annotated test"));
  const tag = (await service.getTags(repositoryPath)).find((item) => item.name === "v-test");
  assert.equal(tag?.annotated, true);
  assert.equal(tag?.subject, "annotated test");
  assertSuccess(await service.pushTag(repositoryPath, "upstream", "v-test"));
  assertSuccess(await service.deleteRemoteTag(repositoryPath, "upstream", "v-test"));
  assertSuccess(await service.deleteTag(repositoryPath, "v-test"));

  await writeFile(path.join(repositoryPath, "second.txt"), "second\n", "utf8");
  git(repositoryPath, "add", "second.txt");
  git(
    repositoryPath,
    "commit",
    "--author=Historical Author <historical@example.com>",
    "--date=2001-01-01T00:00:00+00:00",
    "-m",
    "second"
  );
  const reflog = await service.getReflog(repositoryPath, 10);
  assert.match(reflog[0].selector, /@\{0\}$/);
  assert.equal(reflog[0].action, "commit");
  assert.equal(reflog[0].authorName, "Capability Test");
  assert.notEqual(reflog[0].authorDate.slice(0, 4), "2001", "reflog 必须显示引用变更时间，而不是提交作者时间");
  assertSuccess(await service.resetToReflogEntry(repositoryPath, reflog[1].hash, "mixed"));

  assertSuccess(await service.addRemote(repositoryPath, "github", "git@github.com:sample-org/sample-repo.git"));
  const links = await service.getHostingLinks(repositoryPath, "abc123", "feature/test", "github");
  assert.equal(links.repositoryUrl, "https://github.com/sample-org/sample-repo");
  assert.equal(links.commitUrl, "https://github.com/sample-org/sample-repo/commit/abc123");
  assert.equal(links.branchUrl, "https://github.com/sample-org/sample-repo/tree/feature/test");

  const gitlab = parseHostedRemoteUrl("https://gitlab.com/group/subgroup/repo.git", "deadbeef", "main");
  assert.equal(gitlab?.commitUrl, "https://gitlab.com/group/subgroup/repo/-/commit/deadbeef");
  assert.equal(gitlab?.branchUrl, "https://gitlab.com/group/subgroup/repo/-/tree/main");
  assert.equal(parseHostedRemoteUrl("ssh://internal.example.com/team/repo.git"), null);

  assertSuccess(await service.removeRemote(repositoryPath, "github"));
});

test("remote updates restore the exact original name and URLs after a later command fails", async () => {
  const repositoryPath = await createRepository("remote-transaction");
  const service = new GitService();
  const fetchPath = path.join(testRoot, "remote-transaction-fetch.git");
  const pushPath = path.join(testRoot, "remote-transaction-push.git");
  const nextFetchPath = path.join(testRoot, "remote-transaction-next-fetch.git");
  const nextPushPath = path.join(testRoot, "remote-transaction-next-push.git");
  for (const targetPath of [fetchPath, pushPath, nextFetchPath, nextPushPath]) {
    await mkdir(targetPath);
    git(targetPath, "init", "--bare", "--initial-branch=main");
  }
  assertSuccess(await service.addRemote(repositoryPath, "origin", fetchPath));
  git(repositoryPath, "remote", "set-url", "--push", "origin", pushPath);

  const originalRun = service.run.bind(service);
  let injectedFailure = false;
  service.run = async (cwd, args, options) => {
    if (!injectedFailure && args[0] === "remote" && args[1] === "set-url" && args[2] === "--push") {
      injectedFailure = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected push-url failure",
        exitCode: 73,
        messageZh: "注入的推送地址更新失败"
      };
    }
    return originalRun(cwd, args, options);
  };

  const result = await service.updateRemote(repositoryPath, "origin", {
    name: "upstream",
    fetchUrl: nextFetchPath,
    pushUrl: nextPushPath
  });
  assert.equal(result.ok, false);
  assert.match(result.messageZh ?? "", /已恢复原配置/);
  assert.equal(git(repositoryPath, "remote"), "origin");
  assert.equal(git(repositoryPath, "config", "--local", "--get-all", "remote.origin.url").replace(/\\/g, "/"), fetchPath.replace(/\\/g, "/"));
  assert.equal(git(repositoryPath, "config", "--local", "--get-all", "remote.origin.pushurl").replace(/\\/g, "/"), pushPath.replace(/\\/g, "/"));

  let primaryFailureInjected = false;
  let rollbackFailureInjected = false;
  service.run = async (cwd, args, options) => {
    if (!primaryFailureInjected && args[0] === "remote" && args[1] === "set-url" && args[2] === "--push") {
      primaryFailureInjected = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected push-url failure",
        exitCode: 73,
        messageZh: "注入的推送地址更新失败"
      };
    }
    if (primaryFailureInjected && !rollbackFailureInjected && args[0] === "config" && args.includes("--unset-all") && args.at(-1) === "remote.upstream.pushurl") {
      rollbackFailureInjected = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected rollback failure",
        exitCode: 75,
        messageZh: "注入的恢复失败"
      };
    }
    return originalRun(cwd, args, options);
  };
  const rollbackFailureResult = await service.updateRemote(repositoryPath, "origin", {
    name: "upstream",
    fetchUrl: nextFetchPath,
    pushUrl: nextPushPath
  });
  assert.equal(rollbackFailureResult.ok, false);
  assert.match(rollbackFailureResult.messageZh ?? "", /恢复原配置失败/);
});

test("remote creation removes the new remote when its custom push URL cannot be configured", async () => {
  const repositoryPath = await createRepository("remote-add-transaction");
  const service = new GitService();
  const originalRun = service.run.bind(service);
  let injectedFailure = false;
  service.run = async (cwd, args, options) => {
    if (!injectedFailure && args[0] === "remote" && args[1] === "set-url" && args[2] === "--push") {
      injectedFailure = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected push-url failure",
        exitCode: 73,
        messageZh: "注入的推送地址配置失败"
      };
    }
    return originalRun(cwd, args, options);
  };

  const result = await service.addRemote(
    repositoryPath,
    "origin",
    "https://example.com/fetch.git",
    "https://example.com/push.git"
  );
  assert.equal(result.ok, false);
  assert.match(result.messageZh ?? "", /已恢复原配置/);
  assert.equal(git(repositoryPath, "remote"), "");
});

test("branch pushRemote wins default-push selection and an empty push URL clears the explicit value", async () => {
  const repositoryPath = await createRepository("remote-default-priority");
  const service = new GitService();
  const originPath = path.join(testRoot, "remote-default-origin.git");
  const mirrorPath = path.join(testRoot, "remote-default-mirror.git");
  await mkdir(originPath);
  await mkdir(mirrorPath);
  git(originPath, "init", "--bare", "--initial-branch=main");
  git(mirrorPath, "init", "--bare", "--initial-branch=main");
  assertSuccess(await service.addRemote(repositoryPath, "origin", originPath));
  assertSuccess(await service.addRemote(repositoryPath, "mirror", mirrorPath, originPath));
  git(repositoryPath, "config", "branch.main.remote", "origin");
  git(repositoryPath, "config", "remote.pushDefault", "origin");
  git(repositoryPath, "config", "branch.main.pushRemote", "mirror");

  const remotes = await service.getRemotes(repositoryPath);
  assert.equal(remotes.find((remote) => remote.name === "mirror")?.defaultPush, true);
  assert.equal(remotes.find((remote) => remote.name === "origin")?.defaultPush, false);

  assertSuccess(await service.updateRemote(repositoryPath, "mirror", { pushUrl: "" }));
  assert.throws(
    () => git(repositoryPath, "config", "--local", "--get-all", "remote.mirror.pushurl"),
    (error) => error?.status === 1
  );
  assert.equal(git(repositoryPath, "remote", "get-url", "--push", "mirror").replace(/\\/g, "/"), mirrorPath.replace(/\\/g, "/"));

  const inheritedRemote = (await service.getRemotes(repositoryPath)).find((remote) => remote.name === "mirror");
  assert.deepEqual(inheritedRemote?.explicitPushUrls, []);
  assert.equal(inheritedRemote?.pushUrls[0].replace(/\\/g, "/"), mirrorPath.replace(/\\/g, "/"));

  const nextMirrorPath = path.join(testRoot, "remote-default-next-mirror.git");
  await mkdir(nextMirrorPath);
  git(nextMirrorPath, "init", "--bare", "--initial-branch=main");
  assertSuccess(await service.updateRemote(repositoryPath, "mirror", { fetchUrl: nextMirrorPath, pushUrl: null }));
  assert.throws(
    () => git(repositoryPath, "config", "--local", "--get-all", "remote.mirror.pushurl"),
    (error) => error?.status === 1
  );
  const movedInheritedRemote = (await service.getRemotes(repositoryPath)).find((remote) => remote.name === "mirror");
  assert.deepEqual(movedInheritedRemote?.explicitPushUrls, []);
  assert.equal(movedInheritedRemote?.pushUrls[0].replace(/\\/g, "/"), nextMirrorPath.replace(/\\/g, "/"));
});

test("history marks the exact attached and detached HEAD even when it is not the first graph row", async () => {
  const repositoryPath = await createRepository("history-head-identity");
  const service = new GitService();
  await writeFile(path.join(repositoryPath, "second.txt"), "second\n", "utf8");
  git(repositoryPath, "add", "second.txt");
  git(repositoryPath, "commit", "-m", "second");

  const attachedHistory = await service.getHistory(repositoryPath, { mode: "all" });
  const attachedHeadCommits = attachedHistory.filter((commit) => commit.refs.some((ref) => ref.type === "head"));
  assert.equal(attachedHeadCommits.length, 1);
  assert.equal(attachedHeadCommits[0].hash, git(repositoryPath, "rev-parse", "HEAD"));
  assert.equal(attachedHeadCommits[0].refs.some((ref) => ref.type === "localBranch" && ref.name === "main"), true);

  git(repositoryPath, "checkout", "--detach", "HEAD~1");
  const detachedHeadHash = git(repositoryPath, "rev-parse", "HEAD");
  const detachedHistory = await service.getHistory(repositoryPath, { mode: "all" });
  const detachedHeadCommits = detachedHistory.filter((commit) => commit.refs.some((ref) => ref.type === "head"));
  assert.equal(detachedHeadCommits.length, 1);
  assert.equal(detachedHeadCommits[0].hash, detachedHeadHash);
  assert.notEqual(detachedHistory[0].hash, detachedHeadHash);
});

test("signing updates restore every exact prior local value after a later key fails", async () => {
  const repositoryPath = await createRepository("signing-transaction");
  const service = new GitService();
  git(repositoryPath, "config", "--local", "--add", "commit.gpgSign", "true");
  git(repositoryPath, "config", "--local", "--add", "commit.gpgSign", "false");
  git(repositoryPath, "config", "--local", "gpg.format", "openpgp");

  const originalRun = service.run.bind(service);
  let injectedFailure = false;
  service.run = async (cwd, args, options) => {
    if (!injectedFailure && args[0] === "config" && args.at(-2) === "gpg.format") {
      injectedFailure = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected signing-format failure",
        exitCode: 74,
        messageZh: "注入的签名格式更新失败"
      };
    }
    return originalRun(cwd, args, options);
  };

  const result = await service.setSigningConfig(repositoryPath, { commitGpgSign: true, format: "ssh" });
  assert.equal(result.ok, false);
  assert.match(result.messageZh ?? "", /已恢复原配置/);
  assert.deepEqual(git(repositoryPath, "config", "--local", "--get-all", "commit.gpgSign").split(/\r?\n/), ["true", "false"]);
  assert.equal(git(repositoryPath, "config", "--local", "--get", "gpg.format"), "openpgp");

  service.run = originalRun;
  assertSuccess(await service.setSigningConfig(repositoryPath, { tagGpgSign: null }));
});

test("branch divergence and conflict counts reflect each real ref and conflicted file", async () => {
  const repositoryPath = await createRepository("branch-divergence");
  const service = new GitService();
  const barePath = path.join(testRoot, "branch-divergence-remote.git");
  await mkdir(barePath);
  git(barePath, "init", "--bare", "--initial-branch=main");
  assertSuccess(await service.addRemote(repositoryPath, "origin", barePath));
  git(repositoryPath, "push", "--set-upstream", "origin", "main");

  const peerPath = path.join(testRoot, "branch-divergence-peer");
  execFileSync("git", ["clone", barePath, peerPath], { cwd: testRoot, stdio: ["ignore", "pipe", "pipe"] });
  git(peerPath, "config", "user.name", "Peer Test");
  git(peerPath, "config", "user.email", "peer@example.com");
  await writeFile(path.join(peerPath, "peer.txt"), "peer\n", "utf8");
  git(peerPath, "add", "peer.txt");
  git(peerPath, "commit", "-m", "peer commit");
  git(peerPath, "push", "origin", "main");

  await writeFile(path.join(repositoryPath, "local.txt"), "local\n", "utf8");
  git(repositoryPath, "add", "local.txt");
  git(repositoryPath, "commit", "-m", "local commit");
  git(repositoryPath, "fetch", "origin");
  git(repositoryPath, "branch", "without-upstream");
  const repositoryStatus = await service.getStatus(repositoryPath);
  assert.equal(repositoryStatus.headHash, git(repositoryPath, "rev-parse", "HEAD"));
  const branches = await service.getBranches(repositoryPath);
  const main = branches.find((branch) => branch.name === "main" && branch.type === "local");
  assert.equal(main?.ahead, 1);
  assert.equal(main?.behind, 1);
  const withoutUpstream = branches.find((branch) => branch.name === "without-upstream" && branch.type === "local");
  assert.equal(withoutUpstream?.upstream, undefined);
  assert.equal(withoutUpstream?.ahead, undefined);
  assert.equal(withoutUpstream?.behind, undefined);

  const conflictPath = await createRepository("conflict-count");
  git(conflictPath, "switch", "-c", "conflict-side");
  await writeFile(path.join(conflictPath, "tracked.txt"), "side\n", "utf8");
  git(conflictPath, "add", "tracked.txt");
  git(conflictPath, "commit", "-m", "side change");
  git(conflictPath, "switch", "main");
  await writeFile(path.join(conflictPath, "tracked.txt"), "main\n", "utf8");
  git(conflictPath, "add", "tracked.txt");
  git(conflictPath, "commit", "-m", "main change");
  const mergeResult = await service.run(conflictPath, ["merge", "conflict-side"]);
  assert.equal(mergeResult.ok, false);
  const conflictStatus = await service.getStatus(conflictPath);
  assert.equal(conflictStatus.hasConflicts, true);
  assert.equal(conflictStatus.conflictedCount, 1);
  const conflictDetails = await service.getConflictFileDetails(conflictPath, "tracked.txt");
  assert.equal(conflictDetails.currentContent, "main\n");
  assert.equal(conflictDetails.incomingContent, "side\n");
  git(conflictPath, "merge", "--abort");
});

test("renamed files stage, unstage, and discard both the original and current path", async () => {
  const repositoryPath = await createRepository("renamed-files");
  const service = new GitService();
  const oldPath = "tracked.txt";
  const newPath = "renamed.txt";
  await rename(path.join(repositoryPath, oldPath), path.join(repositoryPath, newPath));

  const renameFile = { path: newPath, oldPath, status: "renamed", staged: false };
  assertSuccess(await service.stageFile(repositoryPath, renameFile));
  assert.equal(git(repositoryPath, "diff", "--cached", "--name-status", "-M"), `R100\t${oldPath}\t${newPath}`);

  const stagedRename = (await service.getWorktree(repositoryPath)).stagedFiles.find((file) => file.status === "renamed");
  assert.deepEqual({ path: stagedRename?.path, oldPath: stagedRename?.oldPath }, { path: newPath, oldPath });
  assertSuccess(await service.unstageFile(repositoryPath, stagedRename));
  assert.equal(git(repositoryPath, "diff", "--cached", "--name-status"), "");

  assertSuccess(await service.stageFile(repositoryPath, renameFile));
  const stagedForDiscard = (await service.getWorktree(repositoryPath)).stagedFiles.find((file) => file.status === "renamed");
  assertSuccess(await service.discardFile(repositoryPath, stagedForDiscard));
  assert.equal(await readFile(path.join(repositoryPath, oldPath), "utf8"), "base\n");
  await assert.rejects(readFile(path.join(repositoryPath, newPath), "utf8"), { code: "ENOENT" });
  assert.equal(git(repositoryPath, "status", "--porcelain"), "");
});

test("ignored files and directories never enter status or worktree changes", async () => {
  const repositoryPath = await createRepository("ignored-worktree");
  await writeFile(path.join(repositoryPath, ".gitignore"), "*.log\ncache/\n", "utf8");
  git(repositoryPath, "add", ".gitignore");
  git(repositoryPath, "commit", "-m", "add ignore rules");

  await writeFile(path.join(repositoryPath, "tracked.txt"), "modified\n", "utf8");
  await writeFile(path.join(repositoryPath, "visible.txt"), "visible\n", "utf8");
  await writeFile(path.join(repositoryPath, "ignored.log"), "ignored\n", "utf8");
  await mkdir(path.join(repositoryPath, "cache"));
  await writeFile(path.join(repositoryPath, "cache", "nested.txt"), "ignored directory\n", "utf8");

  const service = new GitService();
  const statusCommands = [];
  const originalRun = service.run.bind(service);
  service.run = async (location, args, options) => {
    if (args[0] === "status") {
      statusCommands.push([...args]);
    }
    return originalRun(location, args, options);
  };

  const status = await service.getStatus(repositoryPath);
  assert.deepEqual(
    {
      stagedCount: status.stagedCount,
      unstagedCount: status.unstagedCount,
      untrackedCount: status.untrackedCount
    },
    { stagedCount: 0, unstagedCount: 1, untrackedCount: 1 }
  );
  assert.equal(statusCommands[0].includes("--ignored=matching"), false);

  const worktree = await service.getWorktree(repositoryPath);
  assert.deepEqual(worktree.stagedFiles, []);
  assert.deepEqual(
    worktree.unstagedFiles.map((file) => ({ path: file.path, status: file.status })),
    [
      { path: "tracked.txt", status: "modified" },
      { path: "visible.txt", status: "untracked" }
    ]
  );

  const defensiveService = new GitService();
  const defensiveRun = defensiveService.run.bind(defensiveService);
  defensiveService.run = (location, args, options) => defensiveRun(
    location,
    args[0] === "status" ? [...args, "--ignored=matching"] : args,
    options
  );
  const defensiveStatus = await defensiveService.getStatus(repositoryPath);
  const defensiveWorktree = await defensiveService.getWorktree(repositoryPath);
  assert.equal(defensiveStatus.unstagedCount, 1);
  assert.equal(defensiveStatus.untrackedCount, 1);
  assert.deepEqual(
    defensiveWorktree.unstagedFiles.map((file) => file.path),
    ["tracked.txt", "visible.txt"]
  );
});

test("clone, linked worktree, gitignore, signing, LFS, and signature checks are executable", async () => {
  const repositoryPath = await createRepository("extended");
  const service = new GitService();
  const clonePath = path.join(testRoot, "extended-clone");
  assertSuccess(await service.cloneRepository(repositoryPath, clonePath, { branch: "main", depth: 1 }));
  assert.equal(git(clonePath, "branch", "--show-current"), "main");

  const linkedPath = path.join(testRoot, "extended-worktree");
  assertSuccess(await service.addLinkedWorktree(repositoryPath, { path: linkedPath, newBranch: "worktree/test" }));
  const linked = await service.getLinkedWorktrees(repositoryPath);
  assert.equal(linked.some((item) => item.branch === "worktree/test"), true);
  await writeFile(path.join(linkedPath, "dirty.txt"), "dirty\n", "utf8");
  git(repositoryPath, "worktree", "lock", linkedPath);
  const lockedRemoval = await service.removeLinkedWorktree(repositoryPath, linkedPath);
  assert.equal(lockedRemoval.ok, false);
  assertSuccess(await service.removeLinkedWorktree(repositoryPath, linkedPath, true));
  assertSuccess(await service.pruneLinkedWorktrees(repositoryPath, true));

  assert.deepEqual(await service.readGitIgnore(repositoryPath), { exists: false, content: "", revision: "missing" });
  assert.equal(await service.createGitIgnoreIfMissing(repositoryPath), true);
  const emptyGitIgnore = await service.readGitIgnore(repositoryPath);
  assert.equal(emptyGitIgnore.exists, true);
  assert.equal(emptyGitIgnore.content, "");
  assert.match(emptyGitIgnore.revision, /^git:[0-9a-f]{40,64}$/);
  await service.writeGitIgnore(repositoryPath, "node_modules/\n*.log\n", emptyGitIgnore.revision);
  assert.equal(await service.createGitIgnoreIfMissing(repositoryPath), false);
  const savedGitIgnore = await service.readGitIgnore(repositoryPath);
  assert.equal(savedGitIgnore.content, "node_modules/\n*.log\n");
  await writeFile(path.join(repositoryPath, ".gitignore"), "external-rule/\n", "utf8");
  await assert.rejects(
    service.writeGitIgnore(repositoryPath, "stale-editor-rule/\n", savedGitIgnore.revision),
    /外部发生变化/
  );
  assert.equal(await readFile(path.join(repositoryPath, ".gitignore"), "utf8"), "external-rule/\n");

  assertSuccess(
    await service.setSigningConfig(repositoryPath, {
      commitGpgSign: false,
      signingKey: "test-key",
      format: "ssh"
    })
  );
  assert.deepEqual(await service.getSigningConfig(repositoryPath), {
    commitGpgSign: false,
    signingKey: "test-key",
    format: "ssh"
  });
  assertSuccess(await service.setSigningConfig(repositoryPath, { signingKey: null, format: null }));

  const uninitializedLfsStatus = await service.getLfsStatus(repositoryPath);
  assert.equal(uninitializedLfsStatus.installed, true);
  assert.equal(uninitializedLfsStatus.initialized, false);
  assertSuccess(await service.installLfs(repositoryPath, "local"));
  const lfsStatus = await service.getLfsStatus(repositoryPath);
  assert.equal(lfsStatus.installed, true);
  assert.equal(lfsStatus.initialized, true);
  assert.match(lfsStatus.version, /^git-lfs\//);
  assert.deepEqual(lfsStatus.files, []);
  const hookPath = git(repositoryPath, "rev-parse", "--git-path", "hooks/pre-push");
  await rm(path.resolve(repositoryPath, hookPath));
  const missingHookStatus = await service.getLfsStatus(repositoryPath);
  assert.equal(missingHookStatus.installed, true);
  assert.equal(missingHookStatus.initialized, false);
  assertSuccess(await service.pullLfs(repositoryPath));
  git(repositoryPath, "lfs", "track", "*.bin");
  await writeFile(path.join(repositoryPath, "asset.bin"), "first\n", "utf8");
  git(repositoryPath, "add", ".gitattributes", "asset.bin");
  git(repositoryPath, "commit", "-m", "add lfs asset");
  await writeFile(path.join(repositoryPath, "asset.bin"), "second\n", "utf8");
  const changedLfsStatus = await service.getLfsStatus(repositoryPath);
  assert.equal(changedLfsStatus.files.some((file) => file.path === "asset.bin" && file.staged === false), true);
  assertSuccess(await service.pruneLfs(repositoryPath, true));

  assertSuccess(await service.showCommitSignature(repositoryPath, "HEAD"));
  const verification = await service.verifyCommitSignature(repositoryPath, "HEAD");
  assert.equal(verification.ok, false, "未签名提交不得被报告为签名验证成功");
});

test("submodule state and lifecycle commands are backed by Git", async () => {
  const grandchildPath = await createRepository("submodule-grandchild");
  const childPath = await createRepository("submodule-child");
  git(childPath, "-c", "protocol.file.allow=always", "submodule", "add", grandchildPath, "nested/grandchild");
  git(childPath, "commit", "-m", "add nested submodule");
  const repositoryPath = await createRepository("submodule-parent");
  const service = new GitService();
  git(repositoryPath, "-c", "protocol.file.allow=always", "submodule", "add", childPath, "modules/child");
  git(repositoryPath, "commit", "-m", "add submodule");

  let modules = await service.getSubmodules(repositoryPath);
  let [submodule] = modules;
  assert.equal(submodule.path, "modules/child");
  assert.equal(submodule.state, "initialized");
  const nestedSubmodule = modules.find((item) => item.path === "modules/child/nested/grandchild");
  assert.equal(nestedSubmodule?.url.replace(/\\/g, "/"), grandchildPath.replace(/\\/g, "/"));
  assertSuccess(await service.syncSubmodules(repositoryPath));

  git(repositoryPath, "submodule", "deinit", "--force", "modules/child");
  modules = await service.getSubmodules(repositoryPath);
  [submodule] = modules;
  assert.equal(submodule.state, "uninitialized");
  assertSuccess(await service.initializeSubmodules(repositoryPath, ["modules/child"]));
  const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = "file";
  try {
    assertSuccess(await service.updateSubmodules(repositoryPath, { paths: ["modules/child"], initialize: true, recursive: true }));
  } finally {
    if (previousAllowedProtocols === undefined) {
      delete process.env.GIT_ALLOW_PROTOCOL;
    } else {
      process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocols;
    }
  }
});

test("history pagination, advanced filters, file history, and blame use complete Git data", async () => {
  const repositoryPath = await createRepository("history");
  const service = new GitService();

  await writeFile(path.join(repositoryPath, "history.txt"), "first\n", "utf8");
  git(repositoryPath, "add", "history.txt");
  git(repositoryPath, "-c", "user.name=Alice", "-c", "user.email=alice@example.com", "commit", "-m", "feat: alice history");
  await writeFile(path.join(repositoryPath, "history.txt"), "first\nsecond\n", "utf8");
  git(repositoryPath, "add", "history.txt");
  git(repositoryPath, "-c", "user.name=Bob", "-c", "user.email=bob@example.com", "commit", "-m", "fix: bob history");
  await writeFile(path.join(repositoryPath, "other.txt"), "other\n", "utf8");
  git(repositoryPath, "add", "other.txt");
  git(repositoryPath, "commit", "-m", "docs: unrelated file");

  const firstPage = await service.getHistoryPage(repositoryPath, { limit: 2 });
  assert.equal(firstPage.commits.length, 2);
  assert.equal(firstPage.hasMore, true);
  const secondPage = await service.getHistoryPage(repositoryPath, { limit: 2, skip: firstPage.nextSkip });
  assert.equal(secondPage.commits.some((commit) => firstPage.commits.some((known) => known.hash === commit.hash)), false);

  const authorPage = await service.getHistoryPage(repositoryPath, { author: "Alice", limit: 20 });
  assert.deepEqual(authorPage.commits.map((commit) => commit.authorName), ["Alice"]);
  const messagePage = await service.getHistoryPage(repositoryPath, { search: "bob history", limit: 20 });
  assert.equal(messagePage.commits.length, 1);
  assert.equal(messagePage.commits[0].authorName, "Bob");
  const filePage = await service.getHistoryPage(repositoryPath, { path: "history.txt", limit: 20 });
  assert.deepEqual(filePage.commits.map((commit) => commit.subject), ["fix: bob history", "feat: alice history"]);

  const blame = await service.getBlame(repositoryPath, "history.txt");
  assert.equal(blame.length, 2);
  assert.equal(blame[0].authorName, "Alice");
  assert.equal(blame[1].authorName, "Bob");
});

test("advanced history treats message text literally and includes the full end date", async () => {
  const service = new GitService();
  const calls = [];
  service.getStatus = async () => ({
    currentBranch: "main",
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    hasConflicts: false,
    conflictedCount: 0
  });
  service.run = async (_cwd, args) => {
    calls.push(args);
    return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
  };

  await service.getHistoryPage("repo", { search: "[literal]", after: "2026-08-01", before: "2026-08-02", limit: 20 });
  const [logArgs] = calls;
  assert.equal(logArgs.includes("--fixed-strings"), true);
  assert.equal(logArgs.includes("--grep=[literal]"), true);
  assert.equal(logArgs.includes("--since=2026-08-01 00:00:00.000"), true);
  assert.equal(logArgs.includes("--until=2026-08-02 23:59:59.999"), true);
  await assert.rejects(service.getHistoryPage("repo", { before: "2026-02-30" }), /不是有效日期/);
});

test("complete history API follows every page and rejects a stalled cursor", async () => {
  const service = new GitService();
  const calls = [];
  service.getHistoryPage = async (_repositoryPath, query) => {
    calls.push(query);
    if (query.skip === 0) {
      return { commits: [{ hash: "first" }], hasMore: true, nextSkip: 1 };
    }
    return { commits: [{ hash: "second" }], hasMore: false, nextSkip: 2 };
  };
  const history = await service.getHistory("repo", { mode: "all" });
  assert.deepEqual(history.map((commit) => commit.hash), ["first", "second"]);
  assert.deepEqual(calls.map((query) => ({ filter: query.filter, skip: query.skip, limit: query.limit })), [
    { filter: { mode: "all" }, skip: 0, limit: 500 },
    { filter: { mode: "all" }, skip: 1, limit: 500 }
  ]);

  const stalledService = new GitService();
  stalledService.getHistoryPage = async () => ({ commits: [], hasMore: true, nextSkip: 0 });
  await assert.rejects(stalledService.getHistory("repo"), /分页位置没有向后推进/);
});

test("interactive rebase plan executes the submitted order and actions", async () => {
  const repositoryPath = await createRepository("interactive-rebase");
  const service = new GitService();
  const upstream = git(repositoryPath, "rev-parse", "HEAD");

  for (const [name, subject] of [["one.txt", "feat: one"], ["two.txt", "feat: two"], ["three.txt", "fix: three"]]) {
    await writeFile(path.join(repositoryPath, name), `${subject}\n`, "utf8");
    git(repositoryPath, "add", name);
    git(repositoryPath, "commit", "-m", subject);
  }

  const plan = await service.getRebasePlan(repositoryPath, upstream);
  assert.deepEqual(plan.map((item) => item.subject), ["feat: one", "feat: two", "fix: three"]);
  const reorderedPlan = [
    { ...plan[1], action: "pick" },
    { ...plan[0], action: "pick" },
    { ...plan[2], action: "fixup" }
  ];
  assertSuccess(await service.startInteractiveRebase(repositoryPath, upstream, reorderedPlan));

  const subjects = git(repositoryPath, "log", "--reverse", "--format=%s", `${upstream}..HEAD`).split(/\r?\n/);
  assert.deepEqual(subjects, ["feat: two", "feat: one"]);
  assert.equal(git(repositoryPath, "show", "HEAD:three.txt"), "fix: three");
});

test("status, untracked, conflict-stage, and merge-state read failures remain explicit", async () => {
  const operationService = new GitService();
  operationService.run = async () => ({
    ok: false,
    command: "git rev-parse --git-path",
    stdout: "",
    stderr: "injected operation-state failure",
    exitCode: 73,
    messageZh: "注入的操作状态读取失败"
  });
  await assert.rejects(operationService.getOperationState("repo"), /注入的操作状态读取失败/);

  const untrackedService = new GitService();
  untrackedService.run = async (_cwd, args) => args[0] === "status"
    ? { ok: true, command: "git status", stdout: "", stderr: "", exitCode: 0 }
    : {
        ok: false,
        command: "git ls-files",
        stdout: "",
        stderr: "injected untracked failure",
        exitCode: 74,
        messageZh: "注入的未跟踪扫描失败"
      };
  await assert.rejects(untrackedService.getWorktree("repo"), /注入的未跟踪扫描失败/);
  await assert.rejects(untrackedService.isUntrackedFile("repo", "file.txt"), /注入的未跟踪扫描失败/);

  const conflictService = new GitService();
  conflictService.run = async () => ({
    ok: true,
    command: "git ls-files --unmerged",
    stdout: `100644 ${"a".repeat(40)} 2\tconflict.txt\n`,
    stderr: "",
    exitCode: 0
  });
  conflictService.runBinary = async () => ({
    ok: false,
    command: "git show :2:conflict.txt",
    stdout: Buffer.alloc(0),
    stderr: "injected blob failure",
    exitCode: 75,
    messageZh: "注入的冲突版本读取失败"
  });
  conflictService.readRepositoryFile = async () => null;
  await assert.rejects(conflictService.loadConflictSnapshot("repo", "conflict.txt"), /注入的冲突版本读取失败/);

  const cleanupService = new GitService();
  cleanupService.getOperationState = async () => undefined;
  cleanupService.run = async (_cwd, args) => args[0] === "status"
    ? { ok: true, command: "git status", stdout: "# branch.head main\n", stderr: "", exitCode: 0 }
    : {
        ok: false,
        command: "git rev-parse --git-path git-ui-pro-merge-state.json",
        stdout: "",
        stderr: "injected cleanup failure",
        exitCode: 76,
        messageZh: "注入的合并状态清理失败"
      };
  await assert.rejects(cleanupService.getStatus("repo"), /注入的合并状态清理失败/);

  const removeFailureService = new GitService();
  removeFailureService.run = async () => ({
    ok: true,
    command: "git rev-parse --git-path git-ui-pro-merge-state.json",
    stdout: ".git/git-ui-pro-merge-state.json\n",
    stderr: "",
    exitCode: 0
  });
  removeFailureService.removeTargetFile = async () => {
    throw new Error("注入的合并状态文件删除失败");
  };
  await assert.rejects(removeFailureService.clearManagedMergeState("repo"), /注入的合并状态文件删除失败/);

  const repositoryPath = await createRepository("invalid-merge-recovery-state");
  const statePath = git(repositoryPath, "rev-parse", "--git-path", "git-ui-pro-merge-state.json");
  await writeFile(path.resolve(repositoryPath, statePath), "{invalid json\n", "utf8");
  const recoveryService = new GitService();
  await assert.rejects(recoveryService.readManagedMergeState(repositoryPath), /合并恢复状态文件无法解析/);
});

test("merge preview rejects command failures instead of treating them as divergence or zero counts", async () => {
  const cleanStatus = {
    currentBranch: "source",
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    hasConflicts: false,
    conflictedCount: 0
  };
  const ancestorService = new GitService();
  ancestorService.getStatus = async () => cleanStatus;
  ancestorService.run = async (_cwd, args) => {
    if (args[0] === "check-ref-format" || args[0] === "show-ref") {
      return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "merge-base" && args[1] !== "--is-ancestor") {
      return { ok: true, command: `git ${args.join(" ")}`, stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "merge-base" && args[2] === "source") {
      return { ok: false, command: `git ${args.join(" ")}`, stdout: "", stderr: "not ancestor", exitCode: 1 };
    }
    return {
      ok: false,
      command: `git ${args.join(" ")}`,
      stdout: "",
      stderr: "injected ancestor failure",
      exitCode: 128,
      messageZh: "注入的祖先关系检查失败"
    };
  };
  await assert.rejects(ancestorService.getMergePreview("repo", "target"), /注入的祖先关系检查失败/);

  const divergenceService = new GitService();
  divergenceService.getStatus = async () => cleanStatus;
  divergenceService.run = async (_cwd, args) => {
    if (args[0] === "check-ref-format" || args[0] === "show-ref") {
      return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "merge-base" && args[1] !== "--is-ancestor") {
      return { ok: true, command: `git ${args.join(" ")}`, stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "merge-base") {
      return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "for-each-ref") {
      return { ok: true, command: `git ${args.join(" ")}`, stdout: "origin/target\n", stderr: "", exitCode: 0 };
    }
    return {
      ok: false,
      command: `git ${args.join(" ")}`,
      stdout: "",
      stderr: "injected divergence failure",
      exitCode: 128,
      messageZh: "注入的领先落后计算失败"
    };
  };
  await assert.rejects(divergenceService.getMergePreview("repo", "target"), /注入的领先落后计算失败/);
});

test("operation methods issue one exact Git command and never substitute another command", async () => {
  const service = new GitService();
  const calls = [];
  service.run = async (_cwd, args) => {
    calls.push(args);
    return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
  };

  await service.stageFile("repo", { path: "renamed.txt", oldPath: "tracked.txt", status: "renamed", staged: false });
  await service.unstageFile("repo", { path: "tracked.txt", status: "modified", staged: true });
  await service.unstageAll("repo");
  await service.pull("repo", "ff-only");
  await service.pull("repo", "rebase");
  await service.pull("repo", "rebase-autostash");
  await assert.rejects(service.pull("repo", "merge"), /不支持的拉取策略/);
  await service.createBranch("repo", "feature/exact", true, "main");
  await service.switchBranch("repo", { type: "local", name: "main" });
  await service.switchBranch("repo", { type: "remote", name: "origin/feature" });
  await service.startRebase("repo", "upstream", "onto");
  await service.continueRebase("repo");
  await service.skipRebase("repo");
  await service.abortRebase("repo");
  await service.continueCherryPick("repo");
  await service.skipCherryPick("repo");
  await service.abortCherryPick("repo");
  await service.continueRevert("repo");
  await service.skipRevert("repo");
  await service.abortRevert("repo");
  await service.startBisect("repo", "bad", "good");
  await service.markBisectGood("repo", "good");
  await service.markBisectBad("repo");
  await service.skipBisect("repo", ["one", "two"]);
  await service.resetBisect("repo");
  await service.removeLinkedWorktree("repo", "linked", true);

  assert.deepEqual(calls, [
    ["add", "--", "tracked.txt", "renamed.txt"],
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    ["restore", "--staged", "--", "tracked.txt"],
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    ["restore", "--staged", "--", "."],
    ["pull", "--progress", "--ff-only"],
    ["pull", "--progress", "--rebase"],
    ["pull", "--progress", "--rebase", "--autostash"],
    ["check-ref-format", "--branch", "feature/exact"],
    ["switch", "-c", "feature/exact", "main"],
    ["switch", "main"],
    ["switch", "--track", "origin/feature"],
    ["rebase", "--onto", "onto", "upstream"],
    ["-c", "core.editor=true", "rebase", "--continue"],
    ["rebase", "--skip"],
    ["rebase", "--abort"],
    ["-c", "core.editor=true", "cherry-pick", "--continue"],
    ["cherry-pick", "--skip"],
    ["cherry-pick", "--abort"],
    ["-c", "core.editor=true", "revert", "--continue"],
    ["revert", "--skip"],
    ["revert", "--abort"],
    ["bisect", "start", "bad", "good"],
    ["bisect", "good", "good"],
    ["bisect", "bad"],
    ["bisect", "skip", "one", "two"],
    ["bisect", "reset"],
    ["worktree", "remove", "--force", "--force", "linked"]
  ]);

  const unbornService = new GitService();
  const unbornCalls = [];
  unbornService.run = async (_cwd, args) => {
    unbornCalls.push(args);
    if (args[0] === "rev-parse") {
      return { ok: false, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 1 };
    }
    return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
  };
  await unbornService.unstageFile("repo", { path: "first.txt", status: "added", staged: true });
  assert.deepEqual(unbornCalls, [
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    ["rm", "--cached", "-r", "--", "first.txt"]
  ]);
});

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
