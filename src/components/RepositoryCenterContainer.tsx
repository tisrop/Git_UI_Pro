import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiClient } from "../api/client";
import type {
  BranchInfo,
  GitHostingAccountSummary,
  GitHostingChangeRequest,
  GitHostingLinks,
  GitHostingProvider,
  GitOperationResult,
  GitProject,
  GitRemoteInfo,
  GitStatusSummary,
  ProjectLibraryState,
  UiPreferences
} from "../types/domain";
import {
  RepositoryCenter,
  type RepositoryActiveOperation,
  type RepositoryCenterActions,
  type RepositoryCenterData,
  type RepositoryCenterSection,
  type RepositoryCenterTab,
  type RepositoryHostingChange,
  type RepositoryHostingLink,
  type RepositoryPreferences,
  type RepositoryProjectSummary,
  type RepositoryResource,
  type RepositorySigningSettings
} from "./RepositoryCenter";

interface RepositoryCenterContainerProps {
  open: boolean;
  project?: GitProject;
  projects: GitProject[];
  initialTab?: RepositoryCenterTab;
  onClose: () => void;
  onOpenProject: (projectId: string, openedProject?: GitProject) => void;
  onProjectsChange: (projects: GitProject[]) => void;
  onLibraryChange: (library: ProjectLibraryState) => void;
  onRepositoryChange: () => void | Promise<void>;
  onPreferencesChange: (preferences: UiPreferences) => void;
}

const shortcutLabels: Record<string, string> = {
  "project.search": "搜索项目",
  "repository.center": "打开仓库中心",
  "git.fetch": "获取远程更新",
  "git.pull": "拉取当前分支",
  "git.push": "推送当前分支",
  "terminal.toggle": "显示或隐藏控制台"
};

const TAB_SECTIONS: Record<RepositoryCenterTab, readonly RepositoryCenterSection[]> = {
  recovery: ["stashes", "operation", "reflog"],
  refs: ["rebaseTargets", "branches", "tags"],
  remotes: ["remotes", "hosting", "hostingAccounts"],
  tools: ["worktrees", "submodules", "lfs", "gitignore", "signing", "identity"],
  projects: ["projects", "groups", "recent"],
  preferences: ["preferences"]
};

const TAB_DEFERRED_SECTIONS: Partial<Record<RepositoryCenterTab, readonly RepositoryCenterSection[]>> = {
  remotes: ["hostingChanges"],
  tools: ["lfsLocks"]
};

const STASH_REFRESH_SECTIONS = ["stashes", "operation"] as const satisfies readonly RepositoryCenterSection[];
const OPERATION_REFRESH_SECTIONS = ["operation", "rebaseTargets", "branches", "reflog"] as const satisfies readonly RepositoryCenterSection[];
const REMOTE_REFRESH_SECTIONS = ["operation", "remotes", "branches", "hosting", "hostingChanges"] as const satisfies readonly RepositoryCenterSection[];
const REF_REFRESH_SECTIONS = ["operation", "rebaseTargets", "branches", "tags", "reflog"] as const satisfies readonly RepositoryCenterSection[];
const WORKTREE_REFRESH_SECTIONS = ["worktrees", "rebaseTargets", "branches"] as const satisfies readonly RepositoryCenterSection[];
const SUBMODULE_REFRESH_SECTIONS = ["operation", "submodules"] as const satisfies readonly RepositoryCenterSection[];
const LFS_REFRESH_SECTIONS = ["operation", "lfs", "lfsLocks"] as const satisfies readonly RepositoryCenterSection[];
const REPOSITORY_DATA_SECTIONS = [
  "stashes", "operation", "rebaseTargets", "remotes", "branches", "tags", "reflog", "worktrees",
  "submodules", "lfs", "lfsLocks", "gitignore", "signing", "identity", "hosting", "hostingAccounts", "hostingChanges"
] as const satisfies readonly RepositoryCenterSection[];

export function RepositoryCenterContainer({
  open,
  project,
  projects,
  initialTab,
  onClose,
  onOpenProject,
  onProjectsChange,
  onLibraryChange,
  onRepositoryChange,
  onPreferencesChange
}: RepositoryCenterContainerProps) {
  const [data, setData] = useState<RepositoryCenterData>(() => emptyCenterData());
  const [repositoryStatus, setRepositoryStatus] = useState<GitStatusSummary | undefined>(project?.status);
  const [activeTab, setActiveTab] = useState<RepositoryCenterTab>(initialTab ?? "recovery");
  const loadTokenRef = useRef(0);
  const loadedSectionsRef = useRef(new Set<RepositoryCenterSection>());
  const projectRef = useRef(project);
  const projectsRef = useRef(projects);

  projectRef.current = project;
  projectsRef.current = projects;

  useEffect(() => {
    setRepositoryStatus(project?.remote?.connectionEnabled === false ? undefined : project?.status);
  }, [project?.id, project?.remote?.connectionEnabled, project?.status]);

  const loadAll = useCallback(async (
    projectSource: GitProject[] = projectsRef.current,
    options: { sections?: readonly RepositoryCenterSection[] } = {}
  ): Promise<boolean> => {
    const loadToken = ++loadTokenRef.current;
    const selectedProject = projectRef.current?.remote?.connectionEnabled === false ? undefined : projectRef.current;
    const requestedSections = new Set(options.sections ?? Object.keys(emptyCenterData()) as RepositoryCenterSection[]);
    const shouldLoad = (section: RepositoryCenterSection) => requestedSections.has(section);
    const needsLibrary = shouldLoad("projects") || shouldLoad("groups") || shouldLoad("recent");
    const needsStatus = shouldLoad("operation") || shouldLoad("hosting");
    const needsBranches = shouldLoad("branches") || shouldLoad("rebaseTargets");
    const needsTags = shouldLoad("tags") || shouldLoad("rebaseTargets");
    const needsRemotes = shouldLoad("remotes") || shouldLoad("hosting") || shouldLoad("hostingChanges");
    const needsLfs = shouldLoad("lfs") || shouldLoad("lfsLocks");
    const needsHostingAccounts = shouldLoad("hostingAccounts") || shouldLoad("hostingChanges");

    const libraryPromise = needsLibrary ? asResource(() => apiClient.getProjectLibrary()) : Promise.resolve(readyResource<ProjectLibraryState>({ groups: [], recentProjectIds: [] }));
    const preferencesPromise = shouldLoad("preferences") ? asResource(() => apiClient.getUiPreferences()) : Promise.resolve(readyResource(defaultPreferences()));
    const statusPromise = selectedProject && needsStatus ? asResource(() => apiClient.getProjectStatus(selectedProject)) : Promise.resolve(readyResource<GitStatusSummary | undefined>(undefined));
    const branchesPromise = selectedProject && needsBranches ? asResource(() => apiClient.getBranches(selectedProject)) : Promise.resolve(readyResource<BranchInfo[]>([]));
    const remotesPromise = selectedProject && needsRemotes ? asResource(() => apiClient.getRemotes(selectedProject)) : Promise.resolve(readyResource<GitRemoteInfo[]>([]));

    const [library, preferences, status, branches, remotes, stashes, tags, reflog, worktrees, submodules, lfs, gitignore, signing, identity, hostingAccounts] = await Promise.all([
      libraryPromise,
      preferencesPromise,
      statusPromise,
      branchesPromise,
      remotesPromise,
      selectedProject && shouldLoad("stashes") ? asResource(() => apiClient.getStashes(selectedProject)) : Promise.resolve(readyResource([])),
      selectedProject && needsTags ? asResource(() => apiClient.getTags(selectedProject)) : Promise.resolve(readyResource([])),
      selectedProject && shouldLoad("reflog") ? asResource(() => apiClient.getReflog(selectedProject, 150)) : Promise.resolve(readyResource([])),
      selectedProject && shouldLoad("worktrees") ? asResource(() => apiClient.getLinkedWorktrees(selectedProject)) : Promise.resolve(readyResource([])),
      selectedProject && shouldLoad("submodules") ? asResource(() => apiClient.getSubmodules(selectedProject)) : Promise.resolve(readyResource([])),
      selectedProject && needsLfs ? asResource(() => apiClient.getLfsStatus(selectedProject)) : Promise.resolve(readyResource(undefined)),
      selectedProject && shouldLoad("gitignore") ? asResource(() => apiClient.readGitIgnore(selectedProject)) : Promise.resolve(readyResource(undefined)),
      selectedProject && shouldLoad("signing") ? asResource(() => apiClient.getSigningConfig(selectedProject)) : Promise.resolve(readyResource(undefined)),
      selectedProject && shouldLoad("identity") ? asResource(() => apiClient.getGitIdentity(selectedProject)) : Promise.resolve(readyResource(undefined)),
      needsHostingAccounts ? asResource(() => apiClient.listHostingAccounts()) : Promise.resolve(readyResource<GitHostingAccountSummary[]>([]))
    ]);

    const lfsLocks = !shouldLoad("lfsLocks") || !selectedProject || lfs.status !== "ready" || !lfs.data?.installed
      ? readyResource([])
      : await asResource(() => apiClient.getLfsLocks(selectedProject));

    const resolvedStatus = status.status === "ready" ? status.data : undefined;
    const hosting = !shouldLoad("hosting") || !selectedProject
      ? readyResource<RepositoryHostingLink[]>([])
      : remotes.status === "error"
        ? errorResource<RepositoryHostingLink[]>(remotes.error, [])
        : await loadHostingResources(selectedProject, remotes.data, resolvedStatus?.currentBranch ?? undefined);
    const hostingChanges = !shouldLoad("hostingChanges") || !selectedProject
      ? readyResource<RepositoryHostingChange[]>([])
      : remotes.status === "error"
        ? errorResource<RepositoryHostingChange[]>(remotes.error, [])
        : hostingAccounts.status === "error"
          ? errorResource<RepositoryHostingChange[]>(hostingAccounts.error, [])
          : await loadConfiguredHostingChanges(remotes.data, hostingAccounts.data);

    if (loadToken !== loadTokenRef.current) {
      return false;
    }

    if (needsLibrary && library.status === "ready") {
      onLibraryChange(library.data);
    }
    if (needsStatus) {
      setRepositoryStatus(resolvedStatus);
    }

    const libraryData = library.status === "ready" ? library.data : { groups: [], recentProjectIds: [] };
    const projectSummaries = projectSource.map(projectSummary);
    const recentById = new Map(projectSummaries.map((item) => [item.id, item]));
    const branchData = branches.status === "ready" ? branches.data : [];

    setData((current) => ({
      stashes: shouldLoad("stashes") ? mapResource(stashes, (entries) => entries.map((entry, index) => ({
        id: entry.selector,
        targetHash: entry.hash,
        index: stashIndex(entry.selector, index),
        subject: entry.subject,
        branch: stashBranch(entry.subject),
        createdAt: entry.createdAt
      })), []) : current.stashes,
      operation: shouldLoad("operation") ? (status.status === "error" ? errorResource(status.error, null) : readyResource(activeOperation(resolvedStatus))) : current.operation,
      rebaseTargets: shouldLoad("rebaseTargets") ? (branches.status === "error"
        ? errorResource(branches.error, [])
        : tags.status === "error"
          ? errorResource(tags.error, [])
          : readyResource([
              ...branches.data.map((branch) => ({
                ref: branch.fullName,
                label: branch.name,
                kind: branch.type === "local" ? "local" as const : "remote" as const,
                isCurrent: branch.current
              })),
              ...tags.data.map((tag) => ({ ref: `refs/tags/${tag.name}`, label: tag.name, kind: "tag" as const }))
            ])) : current.rebaseTargets,
      remotes: shouldLoad("remotes") ? mapResource(remotes, (entries) => entries.map((remote) => ({
        id: remote.name,
        name: remote.name,
        fetchUrl: remote.fetchUrls[0] ?? "",
        pushUrl: remote.pushUrls[0] ?? "",
        explicitPushUrl: remote.explicitPushUrls[0],
        defaultBranch: remote.defaultBranch,
        hostingProvider: hostingProviderFromRemote(remote.fetchUrls[0] ?? ""),
        isDefaultFetch: remote.defaultFetch,
        isDefaultPush: remote.defaultPush
      })), []) : current.remotes,
      branches: shouldLoad("branches") ? mapResource(branches, (entries) => entries.map((branch) => ({
        id: branch.fullName,
        name: branch.name,
        kind: branch.type,
        current: branch.current,
        upstream: branch.upstream,
        headHash: branch.headHash.slice(0, 10),
        ahead: branch.ahead,
        behind: branch.behind,
        merged: branch.merged
      })), []) : current.branches,
      tags: shouldLoad("tags") ? mapResource(tags, (entries) => entries.map((tag) => ({
        id: tag.name,
        name: tag.name,
        targetHash: tag.targetHash.slice(0, 10),
        subject: tag.subject,
        annotated: tag.annotated,
        pushedRemotes: []
      })), []) : current.tags,
      reflog: shouldLoad("reflog") ? mapResource(reflog, (entries) => entries.map((entry) => ({
        id: entry.selector,
        targetHash: entry.hash,
        selector: entry.selector,
        shortHash: entry.hash.slice(0, 10),
        action: entry.action,
        subject: entry.message || entry.action,
        createdAt: entry.authorDate
      })), []) : current.reflog,
      worktrees: shouldLoad("worktrees") ? mapResource(worktrees, (entries) => entries.map((entry) => ({
        id: entry.path,
        path: entry.path,
        branch: entry.branch,
        headHash: entry.head.slice(0, 10),
        locked: Boolean(entry.lockedReason),
        lockReason: entry.lockedReason,
        prunable: Boolean(entry.prunableReason),
        prunableReason: entry.prunableReason,
        isMain: Boolean(selectedProject && normalizePath(entry.path) === normalizePath(selectedProject.path))
      })), []) : current.worktrees,
      submodules: shouldLoad("submodules") ? mapResource(submodules, (entries) => entries.map((entry) => ({
        id: entry.path,
        name: entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path,
        path: entry.path,
        url: entry.url,
        branch: entry.branch,
        status: entry.state === "initialized" ? "ready" as const : entry.state === "uninitialized" ? "uninitialized" as const : entry.state === "conflicted" ? "conflict" as const : "modified" as const,
        headHash: entry.hash.slice(0, 10)
      })), []) : current.submodules,
      lfs: shouldLoad("lfs") ? mapResource(lfs, (value) => ({
        installed: value?.installed ?? false,
        initialized: value?.initialized ?? false,
        version: value?.version ?? "",
        changedFileCount: value?.files.length ?? 0,
        stagedFileCount: value?.files.filter((file) => file.staged).length ?? 0,
        files: value?.files ?? []
      }), { installed: false, initialized: false, version: "", changedFileCount: 0, stagedFileCount: 0, files: [] }) : current.lfs,
      lfsLocks: shouldLoad("lfsLocks") ? lfsLocks : current.lfsLocks,
      gitignore: shouldLoad("gitignore") ? mapResource(gitignore, (value) => ({ path: ".gitignore", content: value?.content ?? "", revision: value?.revision ?? "missing", modified: false }), { path: ".gitignore", content: "", revision: "missing", modified: false }) : current.gitignore,
      signing: shouldLoad("signing") ? mapResource(signing, (value): RepositorySigningSettings => ({
        enabled: Boolean(value?.commitGpgSign),
        format: value?.format ?? "openpgp",
        key: value?.signingKey ?? "",
        signTags: Boolean(value?.tagGpgSign)
      }), { enabled: false, format: "openpgp", key: "", signTags: false }) : current.signing,
      identity: shouldLoad("identity") ? mapResource(identity, (value) => value ?? { valid: false, issues: [] }, { valid: false, issues: [] }) : current.identity,
      hosting: shouldLoad("hosting") ? hosting : current.hosting,
      hostingAccounts: shouldLoad("hostingAccounts") ? hostingAccounts : current.hostingAccounts,
      hostingChanges: shouldLoad("hostingChanges") ? hostingChanges : current.hostingChanges,
      projects: shouldLoad("projects") ? readyResource(projectSummaries) : current.projects,
      groups: shouldLoad("groups") ? (library.status === "error" ? errorResource(library.error, []) : readyResource(libraryData.groups.map((group) => ({
        id: group.id,
        name: group.name,
        projectIds: projectSource.filter((item) => item.groupId === group.id).map((item) => item.id)
      })))) : current.groups,
      recent: shouldLoad("recent") ? (library.status === "error" ? errorResource(library.error, []) : readyResource(
        libraryData.recentProjectIds.map((id) => recentById.get(id)).filter((item): item is RepositoryProjectSummary => Boolean(item))
      )) : current.recent,
      preferences: shouldLoad("preferences") ? mapResource(preferences, toRepositoryPreferences, toRepositoryPreferences(defaultPreferences())) : current.preferences
    }));
    return true;
  }, [onLibraryChange]);

  useEffect(() => {
    loadedSectionsRef.current.clear();
    loadTokenRef.current += 1;
    setActiveTab(initialTab ?? "recovery");
  }, [initialTab, open, project?.id, project?.remote?.connectionEnabled]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const tabSections = TAB_SECTIONS[activeTab];
    const requestedSections = [...new Set<RepositoryCenterSection>([...tabSections, "preferences"])]
      .filter((section) => !loadedSectionsRef.current.has(section));
    const deferredSections = (TAB_DEFERRED_SECTIONS[activeTab] ?? [])
      .filter((section) => !loadedSectionsRef.current.has(section));
    if (requestedSections.length === 0 && deferredSections.length === 0) {
      return;
    }

    setData((current) => loadingCenterData(current, new Set([...requestedSections, ...deferredSections])));
    void (async () => {
      if (requestedSections.length > 0) {
        const loaded = await loadAll(projectsRef.current, { sections: requestedSections });
        if (!loaded) {
          return;
        }
        requestedSections.forEach((section) => loadedSectionsRef.current.add(section));
      }
      if (deferredSections.length > 0) {
        const loaded = await loadAll(projectsRef.current, { sections: deferredSections });
        if (loaded) {
          deferredSections.forEach((section) => loadedSectionsRef.current.add(section));
        }
      }
    })();
  }, [activeTab, initialTab, loadAll, open, project?.id, project?.remote?.connectionEnabled]);

  const handleTabChange = useCallback((tab: RepositoryCenterTab) => {
    setActiveTab(tab);
  }, []);

  async function refreshSections(
    sections: readonly RepositoryCenterSection[],
    projectSource: GitProject[] = projectsRef.current
  ) {
    sections.forEach((section) => loadedSectionsRef.current.delete(section));
    const loaded = await loadAll(projectSource, { sections });
    if (loaded) {
      sections.forEach((section) => loadedSectionsRef.current.add(section));
    }
  }

  async function completeGit(resultPromise: Promise<GitOperationResult>, sections?: readonly RepositoryCenterSection[]): Promise<void>;
  async function completeGit(resultPromise: Promise<GitOperationResult>, sections: readonly RepositoryCenterSection[], includeFeedback: true): Promise<string>;
  async function completeGit(
    resultPromise: Promise<GitOperationResult>,
    sections: readonly RepositoryCenterSection[] = OPERATION_REFRESH_SECTIONS,
    includeFeedback = false
  ): Promise<void | string> {
    const result = await resultPromise;
    ensureGitSuccess(result);
    const feedback = operationFeedback(result);
    try {
      await Promise.all([
        onRepositoryChange(),
        refreshSections(sections)
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const notice = `${includeFeedback ? feedback : "Git 操作已完成"}；界面刷新失败：${detail}`;
      if (includeFeedback) {
        return notice;
      }
      toast.warning("Git 操作已完成，但界面刷新失败", { description: detail });
      return;
    }
    return includeFeedback ? feedback : undefined;
  }

  async function reloadProjects() {
    const configuredProjects = await apiClient.getProjects();
    const currentProjects = projectsRef.current;
    const statusById = new Map(currentProjects.map((item) => [item.id, { status: item.status, statusError: item.statusError }]));
    const nextProjects = configuredProjects.map((item) => ({ ...item, ...statusById.get(item.id) }));
    projectsRef.current = nextProjects;
    onProjectsChange(nextProjects);
    const sections = ["projects", "groups", "recent"] as const;
    await refreshSections(sections, nextProjects);
  }

  function applyProjectGroupChange(updatedProject: GitProject, groupId?: string) {
    const currentProjects = projectsRef.current;
    const existingProject = currentProjects.find((item) => item.id === updatedProject.id);
    if (!existingProject) {
      return;
    }

    const nextProject: GitProject = {
      ...existingProject,
      ...updatedProject,
      groupId,
      status: existingProject.status,
      statusError: existingProject.statusError
    };
    const nextProjects = currentProjects.map((item) => item.id === nextProject.id ? nextProject : item);
    const nextSummary = projectSummary(nextProject);
    projectsRef.current = nextProjects;
    onProjectsChange(nextProjects);
    setData((current) => ({
      ...current,
      projects: {
        ...current.projects,
        data: current.projects.data.map((item) => item.id === nextSummary.id ? nextSummary : item)
      },
      groups: {
        ...current.groups,
        data: current.groups.data.map((group) => ({
          ...group,
          projectIds: group.id === groupId
            ? [...group.projectIds.filter((projectId) => projectId !== nextProject.id), nextProject.id]
            : group.projectIds.filter((projectId) => projectId !== nextProject.id)
        }))
      },
      recent: {
        ...current.recent,
        data: current.recent.data.map((item) => item.id === nextSummary.id ? nextSummary : item)
      }
    }));
  }

  function requireProject(): GitProject {
    if (!project) {
      throw new Error("请先选择一个 Git 项目。");
    }
    if (project.remote?.connectionEnabled === false) {
      throw new Error("远程连接已暂停，请先开启连接。");
    }
    return project;
  }

  function findBranch(branchId: string) {
    const branch = data.branches.data.find((item) => item.id === branchId);
    if (!branch) {
      throw new Error("分支记录已变化，请刷新后重试。");
    }
    return branch;
  }

  function requireRemote(remoteId: string) {
    const remote = data.remotes.data.find((item) => item.id === remoteId);
    if (!remote) {
      throw new Error("远程仓库记录已变化，请刷新后重试。");
    }
    return remote;
  }

  async function reloadHostingChanges(provider: GitHostingProvider, remoteId: string) {
    const remote = requireRemote(remoteId);
    const changes = await apiClient.listHostingChangeRequests(provider, hostingRemoteUrl(remote));
    const scopedChanges = changes.map((change): RepositoryHostingChange => ({ ...change, provider, remoteId }));
    setData((current) => ({
      ...current,
      hostingChanges: readyResource([
        ...current.hostingChanges.data.filter((change) => change.provider !== provider || change.remoteId !== remoteId),
        ...scopedChanges
      ])
    }));
  }

  function upsertHostingChange(provider: GitHostingProvider, remoteId: string, change: GitHostingChangeRequest) {
    setData((current) => ({
      ...current,
      hostingChanges: readyResource([
        { ...change, provider, remoteId },
        ...current.hostingChanges.data.filter((item) => item.provider !== provider || item.remoteId !== remoteId || item.number !== change.number)
      ])
    }));
  }

  function patchHostingChange(
    provider: GitHostingProvider,
    remoteId: string,
    number: number,
    patch: Partial<GitHostingChangeRequest>
  ) {
    setData((current) => ({
      ...current,
      hostingChanges: readyResource(current.hostingChanges.data.map((item) =>
        item.provider === provider && item.remoteId === remoteId && item.number === number
          ? { ...item, ...patch }
          : item
      ))
    }));
  }

  const actions = useMemo<RepositoryCenterActions>(() => ({
    onClose,
    onReload: (section: RepositoryCenterSection) => refreshSections([section]),
    onCreateStash: (input) => completeGit(apiClient.createStash(requireProject(), input), STASH_REFRESH_SECTIONS),
    onLoadStashDetails: (stashId) => apiClient.getStashDetails(requireProject(), stashId),
    onApplyStash: (stashId, restoreIndex) => completeGit(apiClient.applyStash(requireProject(), stashId, restoreIndex), STASH_REFRESH_SECTIONS),
    onPopStash: (stashId, restoreIndex) => completeGit(apiClient.popStash(requireProject(), stashId, restoreIndex), STASH_REFRESH_SECTIONS),
    onDeleteStash: (stashId) => completeGit(apiClient.dropStash(requireProject(), stashId), STASH_REFRESH_SECTIONS),
    onContinueOperation: (kind) => {
      const selected = requireProject();
      if (kind === "merge") return completeGit(apiClient.continueMerge(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "rebase") return completeGit(apiClient.continueRebase(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "cherry-pick") return completeGit(apiClient.continueCherryPick(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "revert") return completeGit(apiClient.continueRevert(selected), OPERATION_REFRESH_SECTIONS);
      throw new Error("二分定位请明确选择标记正常或标记异常。");
    },
    onSkipOperation: (kind) => {
      const selected = requireProject();
      if (kind === "rebase") return completeGit(apiClient.skipRebase(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "cherry-pick") return completeGit(apiClient.skipCherryPick(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "revert") return completeGit(apiClient.skipRevert(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "bisect") return completeGit(apiClient.skipBisect(selected), OPERATION_REFRESH_SECTIONS);
      throw new Error("合并操作不支持跳过。");
    },
    onAbortOperation: (kind) => {
      const selected = requireProject();
      if (kind === "merge") return completeGit(apiClient.abortMerge(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "rebase") return completeGit(apiClient.abortRebase(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "cherry-pick") return completeGit(apiClient.abortCherryPick(selected), OPERATION_REFRESH_SECTIONS);
      if (kind === "revert") return completeGit(apiClient.abortRevert(selected), OPERATION_REFRESH_SECTIONS);
      return completeGit(apiClient.resetBisect(selected), OPERATION_REFRESH_SECTIONS);
    },
    onMarkBisect: (result) => completeGit(result === "good" ? apiClient.markBisectGood(requireProject()) : apiClient.markBisectBad(requireProject()), OPERATION_REFRESH_SECTIONS, true),
    onStartBisect: ({ badRef, goodRef }) => completeGit(apiClient.startBisect(requireProject(), badRef, goodRef), OPERATION_REFRESH_SECTIONS),
    onLoadRebasePlan: async (target) => apiClient.getRebasePlan(requireProject(), target),
    onStartRebase: ({ target, interactive, onto, plan }) => interactive
      ? completeGit(apiClient.startInteractiveRebase(requireProject(), target, plan ?? [], onto), OPERATION_REFRESH_SECTIONS)
      : completeGit(apiClient.startRebase(requireProject(), target, onto), OPERATION_REFRESH_SECTIONS),
    onForcePushWithLease: () => completeGit(apiClient.push(requireProject(), { forceWithLease: true }), REF_REFRESH_SECTIONS),
    onPublishCurrentBranch: async ({ remoteId, remoteUrl }) => {
      const selected = requireProject();
      const currentBranch = data.branches.data.find((branch) => branch.kind === "local" && branch.current);
      if (!currentBranch) {
        throw new Error("当前仓库还没有可发布的分支，请先完成一次提交。");
      }

      let targetRemote = remoteId?.trim() ?? "";
      let configurationChanged = false;
      let operationError: unknown;
      let feedback = "";
      try {
        if (remoteUrl?.trim()) {
          if (data.remotes.data.length > 0) {
            throw new Error("当前仓库已经配置远程地址，请从已有远程中选择发布目标。");
          }
          targetRemote = "origin";
          ensureGitSuccess(await apiClient.addRemote(selected, targetRemote, remoteUrl.trim()));
          configurationChanged = true;
        } else {
          requireRemote(targetRemote);
        }

        ensureGitSuccess(await apiClient.setDefaultRemote(selected, targetRemote, "push", currentBranch.name));
        configurationChanged = true;
        ensureGitSuccess(await apiClient.push(selected));
        feedback = `已将 ${currentBranch.name} 发布到 ${targetRemote}，后续可直接推送。`;
      } catch (error) {
        operationError = error;
      }

      if (configurationChanged) {
        const refreshResults = await Promise.allSettled([
          onRepositoryChange(),
          refreshSections(REMOTE_REFRESH_SECTIONS)
        ]);
        if (!operationError) {
          const refreshFailure = refreshResults.find((result) => result.status === "rejected");
          if (refreshFailure?.status === "rejected") {
            throw new Error(`首次发布已完成，但界面刷新失败：${refreshFailure.reason instanceof Error ? refreshFailure.reason.message : String(refreshFailure.reason)}`);
          }
        }
      }

      if (operationError) {
        throw operationError;
      }
      return feedback;
    },
    onSaveRemote: async (input) => {
      const selected = requireProject();
      if (input.id) {
        await completeGit(apiClient.updateRemote(selected, input.id, { name: input.name, fetchUrl: input.fetchUrl, pushUrl: input.pushUrl }), REMOTE_REFRESH_SECTIONS);
        return;
      }
      await completeGit(apiClient.addRemote(selected, input.name, input.fetchUrl, input.pushUrl ?? undefined), REMOTE_REFRESH_SECTIONS);
    },
    onDeleteRemote: (remoteId) => completeGit(apiClient.removeRemote(requireProject(), remoteId), REMOTE_REFRESH_SECTIONS),
    onFetchRemote: (remoteId) => completeGit(apiClient.fetchRemote(requireProject(), remoteId), REMOTE_REFRESH_SECTIONS),
    onPruneRemote: (remoteId) => completeGit(apiClient.fetchRemote(requireProject(), remoteId, true), REMOTE_REFRESH_SECTIONS),
    onSetDefaultRemote: async ({ remoteId, role }) => {
      const selected = requireProject();
      const latestStatus = await apiClient.getProjectStatus(selected);
      if (!latestStatus) {
        throw new Error("无法读取当前分支状态，未修改默认远程仓库。");
      }
      await completeGit(apiClient.setDefaultRemote(selected, remoteId, role, latestStatus.currentBranch ?? undefined), REMOTE_REFRESH_SECTIONS);
    },
    onRenameBranch: ({ branchId, nextName }) => completeGit(apiClient.renameBranch(requireProject(), findBranch(branchId).name, nextName), REF_REFRESH_SECTIONS),
    onDeleteBranch: (branchId, force) => completeGit(apiClient.deleteBranch(requireProject(), findBranch(branchId).name, force), REF_REFRESH_SECTIONS),
    onDeleteRemoteBranch: (branchId) => {
      const branch = findBranch(branchId);
      const separator = branch.name.indexOf("/");
      if (branch.kind !== "remote" || separator <= 0 || separator === branch.name.length - 1) {
        throw new Error("远程分支引用无效，无法确定远程仓库与分支名。");
      }
      return completeGit(apiClient.deleteRemoteBranch(requireProject(), branch.name.slice(0, separator), branch.name.slice(separator + 1)), REF_REFRESH_SECTIONS);
    },
    onSetBranchUpstream: ({ branchId, upstream }) => {
      const branch = findBranch(branchId);
      return completeGit(upstream ? apiClient.setBranchUpstream(requireProject(), branch.name, upstream) : apiClient.unsetBranchUpstream(requireProject(), branch.name), REF_REFRESH_SECTIONS);
    },
    onCreateTag: ({ name, target, message, annotated }) => completeGit(apiClient.createTag(requireProject(), name, target, annotated ? message : undefined), REF_REFRESH_SECTIONS),
    onDeleteTag: (tagId) => completeGit(apiClient.deleteTag(requireProject(), tagId), REF_REFRESH_SECTIONS),
    onDeleteRemoteTag: ({ tagId, remoteId }) => completeGit(apiClient.deleteRemoteTag(requireProject(), remoteId, tagId), REF_REFRESH_SECTIONS),
    onPushTag: ({ tagId, remoteId }) => completeGit(apiClient.pushTag(requireProject(), remoteId, tagId), REF_REFRESH_SECTIONS),
    onRestoreReflog: ({ entryId, mode, branchName }) => mode === "branch"
      ? completeGit(apiClient.createBranch(requireProject(), branchName ?? "", false, entryId), REF_REFRESH_SECTIONS)
      : completeGit(apiClient.resetToReflogEntry(requireProject(), entryId, mode === "reset-hard" ? "hard" : "mixed"), REF_REFRESH_SECTIONS),
    onAddWorktree: ({ path, branch, createBranch }) => completeGit(apiClient.addLinkedWorktree(requireProject(), createBranch ? { path, newBranch: branch } : { path, ref: branch || undefined }), WORKTREE_REFRESH_SECTIONS),
    onRemoveWorktree: (worktreeId, force) => completeGit(apiClient.removeLinkedWorktree(requireProject(), worktreeId, force), WORKTREE_REFRESH_SECTIONS),
    onPruneWorktrees: () => completeGit(apiClient.pruneLinkedWorktrees(requireProject()), WORKTREE_REFRESH_SECTIONS),
    onLockWorktree: ({ worktreeId, reason }) => completeGit(apiClient.lockLinkedWorktree(requireProject(), worktreeId, reason), WORKTREE_REFRESH_SECTIONS),
    onUnlockWorktree: (worktreeId) => completeGit(apiClient.unlockLinkedWorktree(requireProject(), worktreeId), WORKTREE_REFRESH_SECTIONS),
    onMoveWorktree: ({ worktreeId, destinationPath }) => completeGit(apiClient.moveLinkedWorktree(requireProject(), { worktreePath: worktreeId, destinationPath }), WORKTREE_REFRESH_SECTIONS),
    onRepairWorktrees: (worktreeIds = []) => completeGit(apiClient.repairLinkedWorktrees(requireProject(), worktreeIds), WORKTREE_REFRESH_SECTIONS),
    onInitSubmodules: () => completeGit(apiClient.initializeSubmodules(requireProject()), SUBMODULE_REFRESH_SECTIONS),
    onUpdateSubmodules: (recursive) => completeGit(apiClient.updateSubmodules(requireProject(), { initialize: true, recursive }), SUBMODULE_REFRESH_SECTIONS),
    onSyncSubmodules: () => completeGit(apiClient.syncSubmodules(requireProject(), true), SUBMODULE_REFRESH_SECTIONS),
    onAddSubmodule: (input) => completeGit(apiClient.addSubmodule(requireProject(), input), SUBMODULE_REFRESH_SECTIONS),
    onSetSubmoduleBranch: ({ moduleId, branch }) => completeGit(apiClient.setSubmoduleBranch(requireProject(), moduleId, branch), SUBMODULE_REFRESH_SECTIONS),
    onDeinitSubmodule: (moduleId, force) => completeGit(apiClient.deinitializeSubmodule(requireProject(), moduleId, force), SUBMODULE_REFRESH_SECTIONS),
    onRemoveSubmodule: (moduleId, force) => completeGit(apiClient.removeSubmodule(requireProject(), moduleId, force), SUBMODULE_REFRESH_SECTIONS),
    onInstallLfs: () => completeGit(apiClient.installLfs(requireProject(), "local"), LFS_REFRESH_SECTIONS),
    onPullLfs: () => completeGit(apiClient.pullLfs(requireProject()), LFS_REFRESH_SECTIONS),
    onPruneLfs: () => completeGit(apiClient.pruneLfs(requireProject()), LFS_REFRESH_SECTIONS),
    onTrackLfsPatterns: (patterns) => completeGit(apiClient.trackLfsPatterns(requireProject(), patterns), LFS_REFRESH_SECTIONS),
    onUntrackLfsPatterns: (patterns) => completeGit(apiClient.untrackLfsPatterns(requireProject(), patterns), LFS_REFRESH_SECTIONS),
    onLockLfsFile: (filePath) => completeGit(apiClient.lockLfsFile(requireProject(), filePath), LFS_REFRESH_SECTIONS),
    onUnlockLfsFile: (lockId, force) => completeGit(apiClient.unlockLfsFile(requireProject(), lockId, force), LFS_REFRESH_SECTIONS),
    onMigrateLfs: (input) => completeGit(apiClient.migrateLfs(requireProject(), input), LFS_REFRESH_SECTIONS),
    onSaveGitignore: async (content, expectedRevision) => {
      await apiClient.writeGitIgnore(requireProject(), content, expectedRevision);
      const sections = ["operation", "gitignore"] as const;
      await Promise.all([onRepositoryChange(), refreshSections(sections)]);
    },
    onSaveSigning: async (settings) => {
      ensureGitSuccess(await apiClient.setSigningConfig(requireProject(), {
        commitGpgSign: settings.enabled,
        tagGpgSign: settings.signTags,
        format: settings.format,
        signingKey: settings.key || null
      }));
      await refreshSections(["signing"]);
    },
    onTestSigning: async () => {
      const result = await apiClient.verifyCommitSignature(requireProject(), "HEAD");
      ensureGitSuccess(result);
      return operationFeedback(result);
    },
    onSaveIdentity: async (input) => {
      ensureGitSuccess(await apiClient.setGitIdentity(requireProject(), input));
      await refreshSections(["identity"]);
    },
    onOpenHostingLink: async (linkId) => {
      const link = data.hosting.data.find((item) => item.id === linkId);
      if (!link) throw new Error("托管平台链接已变化，请刷新后重试。");
      await apiClient.openExternal(link.url);
    },
    onCopyHostingLink: async (linkId) => {
      const link = data.hosting.data.find((item) => item.id === linkId);
      if (!link) throw new Error("托管平台链接已变化，请刷新后重试。");
      await navigator.clipboard.writeText(link.url);
    },
    onSaveHostingAccount: async ({ provider, remoteId, token }) => {
      const remote = requireRemote(remoteId);
      const account = await apiClient.saveHostingAccount(provider, hostingRemoteUrl(remote), token);
      setData((current) => ({
        ...current,
        hostingAccounts: readyResource([
          account,
          ...current.hostingAccounts.data.filter((item) => item.provider !== account.provider || item.host !== account.host)
        ])
      }));
    },
    onDeleteHostingAccount: async ({ provider, host }) => {
      const removed = await apiClient.removeHostingAccount(provider, host);
      if (!removed) {
        throw new Error("平台账号已经不存在，请刷新后重试。");
      }
      setData((current) => ({
        ...current,
        hostingAccounts: readyResource(current.hostingAccounts.data.filter((item) => item.provider !== provider || item.host !== host))
      }));
    },
    onReloadHostingChanges: ({ provider, remoteId }) => reloadHostingChanges(provider, remoteId),
    onRefreshHostingChange: async ({ provider, remoteId, number }) => {
      const remote = requireRemote(remoteId);
      const change = await apiClient.getHostingChangeRequest(provider, hostingRemoteUrl(remote), number);
      upsertHostingChange(provider, remoteId, change);
      return "已读取平台最新状态";
    },
    onCreateHostingChange: async ({ provider, remoteId, change }) => {
      const remote = requireRemote(remoteId);
      const targetRemoteUrl = hostingRemoteUrl(remote);
      const sourceRemoteUrl = remote.pushUrl.trim();
      const created = await apiClient.createHostingChangeRequest(provider, targetRemoteUrl, {
        ...change,
        sourceRemoteUrl: sourceRemoteUrl && sourceRemoteUrl !== targetRemoteUrl ? sourceRemoteUrl : undefined
      });
      upsertHostingChange(provider, remoteId, created);
    },
    onCommentHostingChange: async ({ provider, remoteId, number, body }) => {
      const remote = requireRemote(remoteId);
      await apiClient.commentHostingChangeRequest(provider, hostingRemoteUrl(remote), number, body);
      patchHostingChange(provider, remoteId, number, { updatedAt: new Date().toISOString() });
      return "评论已提交";
    },
    onReviewHostingChange: async ({ provider, remoteId, number, headSha, event, body }) => {
      const remote = requireRemote(remoteId);
      await apiClient.reviewHostingChangeRequest(provider, hostingRemoteUrl(remote), { number, headSha, event, body });
      patchHostingChange(provider, remoteId, number, {
        reviewStatus: event === "approve" ? "当前提交已批准" : "已请求修改",
        updatedAt: new Date().toISOString()
      });
      return event === "approve" ? "审核已批准" : "修改请求已提交";
    },
    onMergeHostingChange: async ({ provider, remoteId, number, headSha, method }) => {
      const remote = requireRemote(remoteId);
      await apiClient.mergeHostingChangeRequest(provider, hostingRemoteUrl(remote), { number, headSha, method });
      patchHostingChange(provider, remoteId, number, {
        state: "merged",
        mergeReadiness: "blocked",
        mergeStatus: "merged",
        updatedAt: new Date().toISOString()
      });
      try {
        await onRepositoryChange();
        return "平台合并已完成";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return `平台合并已完成；本地仓库刷新失败：${detail}`;
      }
    },
    onOpenHostingChange: async ({ provider, remoteId, number }) => {
      const change = data.hostingChanges.data.find((item) => item.provider === provider && item.remoteId === remoteId && item.number === number);
      if (!change) {
        throw new Error("合并请求记录已变化，请刷新后重试。");
      }
      await apiClient.openExternal(change.webUrl);
    },
    onCloneRepository: async (input) => {
      const created = await apiClient.cloneRepository(input.url, input.destination, {
        branch: input.branch,
        depth: input.depth,
        recurseSubmodules: input.recurseSubmodules
      });
      ensureGitSuccess(created.result);
      await reloadProjects();
    },
    onInitRepository: async (input) => {
      const created = await apiClient.initializeRepository(input.path, input.initialBranch, input.createGitignore);
      ensureGitSuccess(created.result);
      await reloadProjects();
    },
    onCreateGroup: async (name) => {
      await apiClient.createProjectGroup(name);
      await refreshSections(["groups"]);
    },
    onRenameGroup: async ({ groupId, name }) => {
      await apiClient.renameProjectGroup(groupId, name);
      await refreshSections(["groups"]);
    },
    onDeleteGroup: async (groupId) => { await apiClient.deleteProjectGroup(groupId); await reloadProjects(); },
    onAssignProjectGroup: async ({ projectId, groupId }) => {
      const updatedProject = await apiClient.setProjectGroup(projectId, groupId ?? undefined);
      applyProjectGroupChange(updatedProject, groupId ?? undefined);
    },
    onOpenProject: async (projectId) => {
      const openedProject = await apiClient.markProjectOpened(projectId);
      const updatedProjects = projects.map((item) => item.id === openedProject.id ? { ...item, ...openedProject } : item);
      projectsRef.current = updatedProjects;
      onProjectsChange(updatedProjects);
      onOpenProject(projectId, openedProject);
    },
    onRemoveRecentProject: async (projectId) => {
      await apiClient.removeRecentProject(projectId);
      await refreshSections(["recent"]);
    },
    onRunBatchAction: async ({ projectIds, action }) => {
      const results = await Promise.all(projectIds.map(async (projectId) => {
        const target = projects.find((item) => item.id === projectId);
        if (!target) {
          return { projectId, name: projectId, error: "项目已被移除。" };
        }
        try {
          if (action === "fetch") {
            ensureGitSuccess(await apiClient.fetch(target));
          } else if (action === "pull") {
            ensureGitSuccess(await apiClient.pull(target, data.preferences.data.pullStrategy));
          } else if (action === "prune") {
            const targetRemotes = await apiClient.getRemotes(target);
            for (const remote of targetRemotes) {
              ensureGitSuccess(await apiClient.fetchRemote(target, remote.name, true));
            }
          }
          return { projectId, name: target.name, status: await apiClient.getProjectStatus(target) };
        } catch (error) {
          return { projectId, name: target.name, error: error instanceof Error ? error.message : String(error) };
        }
      }));

      const resultById = new Map(results.map((result) => [result.projectId, result] as const));
      const updatedProjects = projects.map((item) => {
        const result = resultById.get(item.id);
        if (!result) {
          return item;
        }
        if (result.error) {
          return { ...item, status: undefined, statusError: result.error };
        }
        return { ...item, status: result.status, statusError: undefined };
      });
      projectsRef.current = updatedProjects;
      onProjectsChange(updatedProjects);
      setData((current) => ({
        ...current,
        projects: readyResource(updatedProjects.map(projectSummary))
      }));

      const selectedResult = project ? resultById.get(project.id) : undefined;
      if (selectedResult && !selectedResult.error) {
        setRepositoryStatus(selectedResult.status);
      }
      if (selectedResult) {
        REPOSITORY_DATA_SECTIONS.forEach((section) => loadedSectionsRef.current.delete(section));
        await onRepositoryChange();
      }

      const failures = results.filter((result) => result.error);
      if (failures.length > 0) {
        throw new Error([
          `批量操作完成：${results.length - failures.length} 个成功，${failures.length} 个失败。`,
          ...failures.map((result) => `${result.name}：${result.error}`)
        ].join("\n"));
      }
    },
    onSavePreferences: async (preferences) => {
      const saved = await apiClient.updateUiPreferences(fromRepositoryPreferences(preferences));
      onPreferencesChange(saved);
      setData((current) => ({ ...current, preferences: readyResource(toRepositoryPreferences(saved)) }));
    }
  }), [data, loadAll, onClose, onOpenProject, onPreferencesChange, onProjectsChange, onRepositoryChange, project, projects]);

  const currentStatus = repositoryStatus;
  return (
    <RepositoryCenter
      open={open}
      initialTab={initialTab}
      repository={{
        id: project?.id ?? "no-project",
        name: project?.name ?? "项目管理",
        path: project?.path ?? "未选择仓库",
        branch: currentStatus?.currentBranch ?? null,
        upstream: currentStatus?.upstream,
        ahead: currentStatus?.ahead ?? 0,
        behind: currentStatus?.behind ?? 0,
        changedFiles: currentStatus ? currentStatus.stagedCount + currentStatus.unstagedCount + currentStatus.untrackedCount + currentStatus.conflictedCount : 0,
        hasConflicts: Boolean(currentStatus?.hasConflicts)
      }}
      data={data}
      actions={actions}
      activeTab={activeTab}
      onTabChange={handleTabChange}
    />
  );
}

function emptyCenterData(): RepositoryCenterData {
  return {
    stashes: readyResource([]), operation: readyResource(null), rebaseTargets: readyResource([]), remotes: readyResource([]), branches: readyResource([]),
    tags: readyResource([]), reflog: readyResource([]), worktrees: readyResource([]), submodules: readyResource([]),
    lfs: readyResource({ installed: false, initialized: false, version: "", changedFileCount: 0, stagedFileCount: 0, files: [] }),
    lfsLocks: readyResource([]),
    gitignore: readyResource({ path: ".gitignore", content: "", revision: "missing", modified: false }),
    signing: readyResource({ enabled: false, format: "openpgp", key: "", signTags: false }),
    identity: readyResource({ valid: false, issues: [] }),
    hosting: readyResource([]), hostingAccounts: readyResource([]), hostingChanges: readyResource([]),
    projects: readyResource([]), groups: readyResource([]), recent: readyResource([]),
    preferences: readyResource(toRepositoryPreferences(defaultPreferences()))
  };
}

function loadingCenterData(data: RepositoryCenterData, sections: ReadonlySet<RepositoryCenterSection>): RepositoryCenterData {
  return Object.fromEntries(Object.entries(data).map(([key, resource]) => [
    key,
    sections.has(key as RepositoryCenterSection) ? { ...resource, status: "loading", error: undefined } : resource
  ])) as unknown as RepositoryCenterData;
}

async function asResource<T>(loader: () => Promise<T>): Promise<RepositoryResource<T>> {
  try {
    return readyResource(await loader());
  } catch (error) {
    return errorResource(error instanceof Error ? error.message : String(error));
  }
}

function readyResource<T>(data: T): RepositoryResource<T> {
  return { status: "ready", data };
}

function errorResource<T>(error = "读取失败", data = undefined as T): RepositoryResource<T> {
  return { status: "error", data, error };
}

function mapResource<T, U>(resource: RepositoryResource<T>, mapper: (value: T) => U, fallback: U): RepositoryResource<U> {
  return resource.status === "ready" ? readyResource(mapper(resource.data)) : errorResource(resource.error, fallback);
}

function ensureGitSuccess(result: GitOperationResult) {
  if (!result.ok) {
    throw new Error([result.messageZh, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || "Git 操作失败。");
  }
}

function activeOperation(status?: GitStatusSummary): RepositoryActiveOperation | null {
  const kind = status?.operationState;
  if (!kind) return null;
  return {
    kind,
    source: status?.mergeSourceBranch,
    target: status?.mergeTargetBranch,
    conflictedFiles: status.conflictedCount,
    canContinue: !status.hasConflicts,
    canSkip: kind !== "merge",
    canAbort: true
  };
}

function projectSummary(project: GitProject): RepositoryProjectSummary {
  const status = project.status;
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    branch: status?.currentBranch ?? null,
    groupId: project.groupId,
    changedFiles: status ? status.stagedCount + status.unstagedCount + status.untrackedCount + status.conflictedCount : 0,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
    statusError: project.remote?.connectionEnabled === false ? "远程连接已暂停" : project.statusError,
    lastOpenedAt: project.lastOpenedAt
  };
}

async function loadHostingResources(
  project: GitProject,
  remotes: Array<{ name: string; fetchUrls: string[] }>,
  branchName?: string
): Promise<RepositoryResource<RepositoryHostingLink[]>> {
  const supportedRemotes = remotes.filter((remote) => remote.fetchUrls.some(isSupportedHostingRemote));
  if (supportedRemotes.length === 0) {
    return readyResource([]);
  }
  const resources = await Promise.all(supportedRemotes.map(async (remote) => ({
    remote,
    resource: await asResource(() => apiClient.getHostingLinks(project, remote.name, undefined, branchName))
  })));
  const failed = resources.filter((item) => item.resource.status === "error");
  if (failed.length > 0) {
    return errorResource(failed.map((item) => `${item.remote.name}：${item.resource.error}`).join("\n"), []);
  }
  return readyResource(resources.flatMap(({ remote, resource }) => hostingLinks(resource.data, remote.name)));
}

async function loadConfiguredHostingChanges(
  remotes: GitRemoteInfo[],
  accounts: GitHostingAccountSummary[]
): Promise<RepositoryResource<RepositoryHostingChange[]>> {
  const targets = remotes.flatMap((remote) => {
    const remoteUrl = remote.fetchUrls[0] ?? "";
    const host = hostingRemoteHost(remoteUrl);
    if (!host) {
      return [];
    }
    const inferredProvider = hostingProviderFromRemote(remoteUrl);
    return accounts
      .filter((account) => account.host.toLocaleLowerCase() === host && (!inferredProvider || account.provider === inferredProvider))
      .map((account) => ({ provider: account.provider, remoteId: remote.name, remoteUrl }));
  });
  if (targets.length === 0) {
    return readyResource([]);
  }

  const resources = await Promise.all(targets.map(async (target) => ({
    target,
    resource: await asResource(() => apiClient.listHostingChangeRequests(target.provider, target.remoteUrl))
  })));
  const failed = resources.filter((item) => item.resource.status === "error");
  const loadedChanges = resources.flatMap(({ target, resource }) => resource.status === "ready"
    ? resource.data.map((change): RepositoryHostingChange => ({
        ...change,
        provider: target.provider,
        remoteId: target.remoteId
      }))
    : []);
  if (failed.length > 0) {
    return errorResource(
      failed.map((item) => `${item.target.remoteId}：${item.resource.error}`).join("\n"),
      loadedChanges
    );
  }
  return readyResource(loadedChanges);
}

function hostingRemoteUrl(remote: { fetchUrl: string; pushUrl: string }): string {
  const remoteUrl = remote.fetchUrl.trim();
  if (!remoteUrl) {
    throw new Error("远程仓库没有可用的 Fetch 地址，无法确定托管目标仓库。");
  }
  return remoteUrl;
}

function hostingRemoteHost(remoteUrl: string): string {
  const source = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      return (url.protocol === "ssh:" ? url.hostname : url.host).toLocaleLowerCase();
    } catch {
      return "";
    }
  }
  return source.match(/^(?:[^@/:]+@)?([^/:]+):/)?.[1]?.toLocaleLowerCase() ?? "";
}

function hostingProviderFromRemote(remoteUrl: string): GitHostingProvider | undefined {
  const host = hostingRemoteHost(remoteUrl).replace(/^\[|\]$/g, "").split(":")[0];
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  if (host === "gitee.com") return "gitee";
  return undefined;
}

function hostingLinks(links: GitHostingLinks, remoteName: string): RepositoryHostingLink[] {
  const entries: RepositoryHostingLink[] = [
    { id: `${remoteName}:repository`, label: `${remoteName} · 仓库主页`, provider: links.provider, kind: "repository", url: links.repositoryUrl },
    { id: `${remoteName}:commits`, label: `${remoteName} · 提交记录`, provider: links.provider, kind: "commits", url: links.commitsUrl },
    { id: `${remoteName}:branches`, label: `${remoteName} · 分支管理`, provider: links.provider, kind: "branches", url: links.branchesUrl },
    { id: `${remoteName}:pullRequests`, label: `${remoteName} · ${links.provider === "github" ? "Pull Requests" : "合并请求"}`, provider: links.provider, kind: "pullRequests", url: links.pullRequestsUrl },
    { id: `${remoteName}:issues`, label: `${remoteName} · Issues`, provider: links.provider, kind: "issues", url: links.issuesUrl }
  ];
  if (links.branchUrl) entries.push({ id: `${remoteName}:current-branch`, label: `${remoteName} · 当前分支`, provider: links.provider, kind: "branches", url: links.branchUrl });
  return entries;
}

function isSupportedHostingRemote(remoteUrl: string): boolean {
  const source = remoteUrl.trim();
  let host = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    try {
      host = new URL(source).hostname.toLocaleLowerCase();
    } catch {
      return false;
    }
  } else {
    host = source.match(/^(?:[^@/:]+@)?([^/:]+):/)?.[1]?.toLocaleLowerCase() ?? "";
  }
  return ["github.com", "gitlab.com", "gitee.com"].includes(host.replace(/^www\./, ""));
}

function toRepositoryPreferences(value: UiPreferences): RepositoryPreferences {
  return {
    theme: value.theme,
    fontFamily: value.fontFamily.toLowerCase().includes("mono") ? "mono" : "system",
    fontSize: value.fontSize,
    diffMode: value.diffViewMode,
    diffWrap: value.diffWrap,
    pullStrategy: value.pullStrategy,
    density: value.density,
    sidebarPosition: value.sidebarPosition,
    sidebarWidth: value.sidebarWidth,
    rightPanelWidth: value.rightPanelWidth,
    consoleHeight: value.consoleHeight,
    bottomConsoleVisible: value.bottomConsoleVisible,
    confirmDestructiveActions: value.confirmDestructiveActions,
    shortcuts: Object.entries(value.shortcuts).map(([id, keys]) => ({ id, label: shortcutLabels[id] ?? id, keys }))
  };
}

function fromRepositoryPreferences(value: RepositoryPreferences): Partial<UiPreferences> {
  return {
    theme: value.theme,
    fontFamily: value.fontFamily === "mono" ? "monospace" : "system-ui",
    fontSize: value.fontSize,
    diffViewMode: value.diffMode,
    diffWrap: value.diffWrap,
    pullStrategy: value.pullStrategy,
    density: value.density,
    sidebarPosition: value.sidebarPosition,
    sidebarWidth: value.sidebarWidth,
    rightPanelWidth: value.rightPanelWidth,
    consoleHeight: value.consoleHeight,
    bottomConsoleVisible: value.bottomConsoleVisible,
    confirmDestructiveActions: value.confirmDestructiveActions,
    shortcuts: Object.fromEntries(value.shortcuts.map((shortcut) => [shortcut.id, shortcut.keys]))
  };
}

function operationFeedback(result: GitOperationResult): string {
  return [result.messageZh?.trim(), result.stdout.trim(), result.stderr.trim()]
    .filter((value): value is string => Boolean(value))
    .join("\n") || "Git 操作已完成。";
}

function defaultPreferences(): UiPreferences {
  return {
    theme: "system", language: "zh-CN", bottomConsoleVisible: true, sidebarWidth: 240, rightPanelWidth: 420, consoleHeight: 240,
    fontSize: 14, fontFamily: "system-ui", diffViewMode: "split", diffWrap: false, pullStrategy: "ff-only", density: "comfortable", sidebarPosition: "left",
    confirmDestructiveActions: true, shortcuts: {}
  };
}

function stashIndex(selector: string, fallback: number) {
  const match = selector.match(/\{(\d+)\}/);
  return match ? Number(match[1]) : fallback;
}

function stashBranch(subject: string) {
  return subject.match(/(?:WIP on|On) ([^:]+):/)?.[1] ?? "当前分支";
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}
