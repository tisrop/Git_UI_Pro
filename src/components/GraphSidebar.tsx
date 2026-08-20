import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudDownload,
  CloudUpload,
  Copy,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  Github,
  GitMerge,
  GitPullRequest,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Tag,
  Undo2,
  X
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject, type UIEvent as ReactUIEvent } from "react";
import { createPortal } from "react-dom";
import { apiClient } from "../api/client";
import { PathTooltip } from "./PathTooltip";
import type { ChangedFile, CommitGraphAction, CommitNode, CommitRef, GitBlameLine, GitHistoryFilter, GitHistoryQuery, GitHistoryRef, GitOperationState, GitProject } from "../types/domain";
import { fileIconInfo } from "../utils/fileIcon";
import { absoluteFilePath } from "../utils/filePath";

interface GraphSidebarProps {
  project?: GitProject;
  commits: CommitNode[];
  historyRefs: GitHistoryRef[];
  historyFilter: GitHistoryFilter;
  loading: boolean;
  onHistoryFilterChange: (filter: GitHistoryFilter) => void;
  advancedQuery: Pick<GitHistoryQuery, "search" | "author" | "after" | "before" | "path">;
  onAdvancedQueryChange: (query: Pick<GitHistoryQuery, "search" | "author" | "after" | "before" | "path">) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  selectedHash: string;
  onSelectCommit: (hash: string) => void;
  onSelectCommitFile: (commit: CommitNode, file: ChangedFile) => void;
  onPinCommitFile: (commit: CommitNode, file: ChangedFile) => void;
  selectedCommitFileHash?: string;
  selectedCommitFilePath?: string;
  onOperation: (operation: string) => void;
  onCommitAction: (action: CommitGraphAction, commit: CommitNode) => void;
  onContinueMerge: () => void;
  onAbortMerge: () => void;
  operationBusy: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

const graphOperations = [
  { id: "fetch", label: "fetch", title: "抓取远程更新", menuLabel: "抓取远程更新", icon: RefreshCw },
  { id: "pull", label: "pull", title: "拉取当前分支", menuLabel: "拉取当前分支", icon: CloudDownload },
  { id: "push", label: "push", title: "推送当前分支", menuLabel: "推送当前分支", icon: CloudUpload },
  { id: "merge", label: "合并分支", title: "将当前分支合并到目标分支", menuLabel: "合并分支", icon: GitMerge },
  { id: "branch", label: "新建分支", title: "新建分支", menuLabel: "新建分支", icon: Plus }
];

const graphBranchTones = ["branch-rose", "branch-cyan", "branch-violet", "branch-amber", "branch-green"] as const;
const graphRowHeight = 28;
const graphNodeCenterY = 14;
const graphNodeRadius = 4.2;
const graphMergeRingRadius = 5.2;
const graphNodeCurveControl = 3.2;
const graphLaneCurveControl = 5;
const graphFileBaseGutter = 24;
const graphFileLanePadding = 10;

type GraphBranchTone = (typeof graphBranchTones)[number];
type GraphTone = "local" | "remote" | "primary" | "secondary" | "synced" | "plain" | GraphBranchTone;
type GraphFileViewMode = "list" | "tree";
type RemoteHostingProvider = "github" | "gitee";
type GraphSegment =
  | {
      type: "line";
      tone: GraphTone;
      x: number;
      y1: number;
      y2: number;
    }
  | {
      type: "curve";
      tone: GraphTone;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      merge?: boolean;
      connectToNode?: boolean;
    };
type GraphRowLayout = {
  segments: GraphSegment[];
  expansionLines: GraphExpansionLine[];
  nodeX: number;
  nodeTone: GraphTone;
  merge: boolean;
};
type GraphExpansionLine = {
  x: number;
  tone: GraphTone;
};
type GraphLaneNode = {
  id: string;
  tone: GraphTone;
};
type VisibleGraphParent = {
  hash: string;
  parentIndex: number;
};
type CommitContextMenuState = {
  commit: CommitNode;
  x: number;
  y: number;
  isHead: boolean;
  isLocalOnly: boolean;
  canUndoHead: boolean;
};
type GraphBranchContext = {
  currentBranch?: string;
  upstream?: string;
  visibleRefIds: Set<string>;
  showAllRefs: boolean;
};

const GRAPH_TOOLBAR_ICON_SIZE = 16;
const COMMIT_HOVER_CARD_WIDTH = 400;
const COMMIT_HOVER_VIEWPORT_GAP = 12;
const COMMIT_HOVER_PANEL_GAP = 8;
const COMMIT_HOVER_TOP_OFFSET = 20;
const COMMIT_HOVER_ARROW_SIZE = 8;
const COMMIT_DETAILS_PREFETCH_LIMIT = 8;
const GRAPH_VIRTUAL_THRESHOLD = 40;
const GRAPH_VIRTUAL_OVERSCAN = 10;
const GRAPH_OPERATION_ROW_HEIGHT = 28;
const GRAPH_SYNC_ROW_HEIGHT = 26;

export function GraphSidebar({
  project,
  commits,
  historyRefs,
  historyFilter,
  loading,
  onHistoryFilterChange,
  advancedQuery,
  onAdvancedQueryChange,
  hasMore,
  loadingMore,
  onLoadMore,
  selectedHash,
  onSelectCommit,
  onSelectCommitFile,
  onPinCommitFile,
  selectedCommitFileHash,
  selectedCommitFilePath,
  onOperation,
  onCommitAction,
  onContinueMerge,
  onAbortMerge,
  operationBusy,
  panelOpen,
  onTogglePanel
}: GraphSidebarProps) {
  const [commitQuery, setCommitQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedDialogRef = useRef<HTMLElement>(null);
  const advancedOpenerRef = useRef<HTMLElement | null>(null);
  const [advancedDraft, setAdvancedDraft] = useState(advancedQuery);
  const [blameLines, setBlameLines] = useState<GitBlameLine[]>([]);
  const [blameLoading, setBlameLoading] = useState(false);
  const [blameError, setBlameError] = useState("");
  const [fileViewMode, setFileViewMode] = useState<GraphFileViewMode>("list");
  const [refsMenuOpen, setRefsMenuOpen] = useState(false);
  const [refsQuery, setRefsQuery] = useState("");
  const [refsMenuFilter, setRefsMenuFilter] = useState<GitHistoryFilter | null>(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [viewMenuPosition, setViewMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [commitContextMenu, setCommitContextMenu] = useState<CommitContextMenuState | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [commitDetailsByHash, setCommitDetailsByHash] = useState<Record<string, CommitNode>>({});
  const [loadingDetailsHash, setLoadingDetailsHash] = useState<string | null>(null);
  const [detailsErrorByHash, setDetailsErrorByHash] = useState<Record<string, string>>({});
  const [hoveredCommit, setHoveredCommit] = useState<CommitNode | undefined>();
  const [hoveredDotHash, setHoveredDotHash] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState({ x: 0, y: 0 });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchRowRef = useRef<HTMLDivElement>(null);
  const graphListRef = useRef<HTMLDivElement>(null);
  const refsButtonRef = useRef<HTMLButtonElement>(null);
  const refsMenuRef = useRef<HTMLDivElement>(null);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const commitContextMenuRef = useRef<HTMLDivElement>(null);
  const commitContextMenuOpenerRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimerRef = useRef<number | undefined>();
  const closeTimerRef = useRef<number | undefined>();
  const graphScrollFrameRef = useRef<number | undefined>();
  const [graphListHeight, setGraphListHeight] = useState(0);
  const [graphListScrollTop, setGraphListScrollTop] = useState(0);
  const [remoteProviders, setRemoteProviders] = useState<Record<string, RemoteHostingProvider>>({});
  const filteredCommits = useMemo(() => {
    const keyword = commitQuery.trim().toLowerCase();
    if (!keyword) {
      return commits;
    }

    return commits.filter((commit) => `${commit.hash} ${commit.subject} ${commit.authorName} ${commit.authorEmail}`.toLowerCase().includes(keyword));
  }, [commits, commitQuery]);
  const advancedActive = hasAdvancedQuery(advancedQuery);
  const graphContext = useMemo(() => buildGraphBranchContext(project, historyRefs, historyFilter), [project, historyRefs, historyFilter]);
  const historyFilterLabel = graphHistoryFilterLabel(historyFilter, historyRefs);
  const rowTones = useMemo(() => buildGraphTones(filteredCommits, graphContext), [filteredCommits, graphContext]);
  const graphLayouts = useMemo(() => buildGraphLayouts(filteredCommits, rowTones, graphContext), [filteredCommits, rowTones, graphContext]);
  const operationProject = project && (project.status?.operationState || project.status?.hasConflicts) ? project : undefined;
  const gitOperationLocked = operationBusy || Boolean(project?.status?.operationState || project?.status?.hasConflicts);
  const syncProject = project && ((project.status?.ahead ?? 0) > 0 || (project.status?.behind ?? 0) > 0) ? project : undefined;
  const remoteDiverged = (project?.status?.ahead ?? 0) > 0 && (project?.status?.behind ?? 0) > 0;
  const visibleGraphOperations = graphOperations.map((operation) =>
    operation.label === "pull" && remoteDiverged
      ? { ...operation, label: "合并远程更改", title: `合并 ${project?.status?.upstream ?? "远程分支"} 的新提交`, menuLabel: "合并远程更改", icon: GitPullRequest }
      : operation
  );
  const primaryGraphOperations = visibleGraphOperations.slice(0, 3);
  const secondaryGraphOperations = visibleGraphOperations.slice(3);
  const virtualGraphEnabled = filteredCommits.length > GRAPH_VIRTUAL_THRESHOLD && !expandedHash;
  const graphVirtualRange = useMemo(() => {
    if (!virtualGraphEnabled) {
      return {
        startIndex: 0,
        endIndex: filteredCommits.length,
        topPadding: 0,
        bottomPadding: 0
      };
    }

    const fixedRowsOffset = (operationProject ? GRAPH_OPERATION_ROW_HEIGHT : 0) + (syncProject ? GRAPH_SYNC_ROW_HEIGHT : 0);
    const viewportStart = Math.max(0, graphListScrollTop - fixedRowsOffset);
    const viewportEnd = Math.max(viewportStart, graphListScrollTop + graphListHeight - fixedRowsOffset);
    const startIndex = clampNumber(Math.floor(viewportStart / graphRowHeight) - GRAPH_VIRTUAL_OVERSCAN, 0, filteredCommits.length);
    const endIndex = clampNumber(Math.ceil(viewportEnd / graphRowHeight) + GRAPH_VIRTUAL_OVERSCAN, startIndex, filteredCommits.length);

    return {
      startIndex,
      endIndex,
      topPadding: startIndex * graphRowHeight,
      bottomPadding: (filteredCommits.length - endIndex) * graphRowHeight
    };
  }, [filteredCommits.length, graphListHeight, graphListScrollTop, operationProject, syncProject, virtualGraphEnabled]);
  const visibleCommits = virtualGraphEnabled ? filteredCommits.slice(graphVirtualRange.startIndex, graphVirtualRange.endIndex) : filteredCommits;

  useEffect(
    () => () => {
      window.clearTimeout(hoverTimerRef.current);
      window.clearTimeout(closeTimerRef.current);
      window.cancelAnimationFrame(graphScrollFrameRef.current ?? 0);
    },
    []
  );

  useEffect(() => {
    let active = true;
    setRemoteProviders({});
    if (!project) {
      return () => {
        active = false;
      };
    }

    void apiClient.getRemotes(project).then((remotes) => {
      if (!active) {
        return;
      }
      const nextProviders: Record<string, RemoteHostingProvider> = {};
      for (const remote of remotes) {
        const provider = remoteHostingProvider([...remote.fetchUrls, ...remote.pushUrls]);
        if (provider) {
          nextProviders[remote.name.toLowerCase()] = provider;
        }
      }
      setRemoteProviders(nextProviders);
    }).catch(() => {
      if (active) {
        setRemoteProviders({});
      }
    });

    return () => {
      active = false;
    };
  }, [project?.id, project?.path, project?.remote?.host, project?.remote?.username, project?.remote?.port, project?.remote?.identityFile, project?.remote?.connectionEnabled]);

  useEffect(() => {
    if (advancedOpen) {
      setAdvancedDraft(advancedQuery);
      setBlameLines([]);
      setBlameError("");
    }
  }, [advancedOpen, advancedQuery]);

  useEffect(() => {
    if (!advancedOpen) {
      return;
    }
    advancedOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => advancedDialogRef.current?.querySelector<HTMLInputElement>("input")?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAdvancedOpen(false);
        return;
      }
      if (event.key !== "Tab" || !advancedDialogRef.current) {
        return;
      }
      const focusable = Array.from(advancedDialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"))
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      advancedOpenerRef.current?.focus();
    };
  }, [advancedOpen]);

  useLayoutEffect(() => {
    const list = graphListRef.current;
    if (!list) {
      return;
    }

    const measure = () => setGraphListHeight(list.clientHeight);
    measure();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(list);
    return () => resizeObserver.disconnect();
  }, [panelOpen]);

  useEffect(() => {
    setGraphListScrollTop(0);
    if (graphListRef.current) {
      graphListRef.current.scrollTop = 0;
    }
  }, [project?.id, commitQuery]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (searchRowRef.current?.contains(target) || searchButtonRef.current?.contains(target)) {
        return;
      }

      setSearchOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [searchOpen]);

  useEffect(() => {
    if (!refsMenuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (refsMenuRef.current?.contains(target) || refsButtonRef.current?.contains(target)) {
        return;
      }

      closeRefsMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeRefsMenu();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [refsMenuOpen]);

  useEffect(() => {
    if (refsMenuOpen) {
      setRefsMenuFilter(cloneHistoryFilter(historyFilter));
    }
  }, [historyFilter, refsMenuOpen]);

  useEffect(() => {
    if (!viewMenuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (viewMenuRef.current?.contains(target) || viewMenuButtonRef.current?.contains(target)) {
        return;
      }

      setViewMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setViewMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [viewMenuOpen]);

  useEffect(() => {
    if (!commitContextMenu) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      commitContextMenuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not(:disabled)")?.focus();
    });

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (commitContextMenuRef.current?.contains(target)) {
        return;
      }

      setCommitContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCommitContextMenu(true);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [commitContextMenu]);

  useEffect(() => {
    setExpandedHash(null);
    setCommitDetailsByHash({});
    setDetailsErrorByHash({});
    setLoadingDetailsHash(null);
    setHoveredDotHash(null);
  }, [project?.id]);

  useEffect(() => {
    let cancelled = false;

    const prefetch = async () => {
      for (const commit of commits.slice(0, COMMIT_DETAILS_PREFETCH_LIMIT)) {
        if (cancelled || document.hidden) {
          return;
        }

        await ensureCommitDetails(commit);
      }
    };

    void prefetch();
    return () => {
      cancelled = true;
    };
  }, [project?.id, commits]);

  function handleGraphListScroll(event: ReactUIEvent<HTMLDivElement>) {
    const scrollTop = event.currentTarget.scrollTop;
    window.cancelAnimationFrame(graphScrollFrameRef.current ?? 0);
    graphScrollFrameRef.current = window.requestAnimationFrame(() => {
      setGraphListScrollTop(scrollTop);
    });
  }

  function scheduleHover(commit: CommitNode, row: HTMLElement) {
    setHoveredDotHash(commit.hash);
    window.clearTimeout(closeTimerRef.current);
    window.clearTimeout(hoverTimerRef.current);
    const rowRect = row.getBoundingClientRect();
    const sourcePaneRect = row.closest(".source-control-pane")?.getBoundingClientRect();
    const dividerRect = row.closest(".main-grid")?.querySelector<HTMLElement>(".detail-resize")?.getBoundingClientRect();
    const nextPosition = {
      x: (dividerRect?.right ?? sourcePaneRect?.right ?? rowRect.right) + COMMIT_HOVER_PANEL_GAP,
      y: rowRect.top + rowRect.height / 2
    };
    const showHover = () => {
      setHoverPosition(nextPosition);
      setHoveredCommit(commit);
    };

    if (hoveredCommit) {
      showHover();
      return;
    }

    hoverTimerRef.current = window.setTimeout(() => {
      showHover();
    }, 450);
  }

  function scheduleCloseHover() {
    setHoveredDotHash(null);
    window.clearTimeout(hoverTimerRef.current);
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setHoveredCommit(undefined);
    }, 160);
  }

  function keepHoverOpen() {
    window.clearTimeout(closeTimerRef.current);
  }

  function selectFileViewMode(mode: GraphFileViewMode) {
    setFileViewMode(mode);
    setViewMenuOpen(false);
  }

  function closeRefsMenu() {
    setRefsMenuOpen(false);
    setRefsMenuFilter(null);
  }

  function toggleRefsMenu() {
    setSearchOpen(false);
    setViewMenuOpen(false);
    setRefsMenuOpen((value) => {
      const nextOpen = !value;
      setRefsMenuFilter(nextOpen ? cloneHistoryFilter(historyFilter) : null);
      return nextOpen;
    });
  }

  function selectHistoryFilterMode(mode: Exclude<GitHistoryFilter["mode"], "custom">) {
    const nextFilter: GitHistoryFilter = { mode };
    setRefsQuery("");
    setRefsMenuFilter(nextFilter);
    onHistoryFilterChange(nextFilter);
    closeRefsMenu();
  }

  function toggleHistoryRef(ref: GitHistoryRef) {
    const activeFilter = refsMenuFilter ?? historyFilter;
    const currentRefIds = activeFilter.mode === "custom" ? activeFilter.refIds ?? [] : [];
    const nextRefIds = currentRefIds.includes(ref.id) ? currentRefIds.filter((id) => id !== ref.id) : [...currentRefIds, ref.id];
    const nextFilter: GitHistoryFilter = nextRefIds.length === 0 ? { mode: "auto" } : { mode: "custom", refIds: nextRefIds };
    setRefsMenuFilter(nextFilter);
    onHistoryFilterChange(nextFilter);
  }

  function toggleViewMenu() {
    const rect = viewMenuButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setViewMenuPosition({
        top: rect.bottom + 4,
        left: rect.left - 1
      });
    }

    setSearchOpen(false);
    setViewMenuOpen((value) => !value);
  }

  function closeCommitContextMenu(restoreFocus = false) {
    setCommitContextMenu(null);
    setHoveredDotHash(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => commitContextMenuOpenerRef.current?.focus());
    }
  }

  function openCommitContextMenu(event: ReactMouseEvent<HTMLButtonElement>, commit: CommitNode) {
    event.preventDefault();
    event.stopPropagation();
    openCommitContextMenuAt(commit, event.clientX, event.clientY, event.currentTarget);
  }

  function openCommitContextMenuAt(commit: CommitNode, x: number, y: number, opener: HTMLButtonElement) {
    window.clearTimeout(hoverTimerRef.current);
    window.clearTimeout(closeTimerRef.current);
    setHoveredCommit(undefined);
    setHoveredDotHash(commit.hash);
    commitContextMenuOpenerRef.current = opener;

    const headCommits = commits.filter((item) => item.refs.some((ref) => ref.type === "head"));
    const identifiedHead = headCommits.length === 1 ? headCommits[0] : undefined;
    const isHead = identifiedHead?.hash === commit.hash;
    const isLocalOnly = Boolean(project?.status) && isHead && (!project?.status?.upstream || (project.status.ahead ?? 0) > 0);
    setCommitContextMenu({
      commit,
      x: Math.max(8, Math.min(x, window.innerWidth - 246)),
      y: Math.max(8, Math.min(y, window.innerHeight - 330)),
      isHead,
      isLocalOnly,
      canUndoHead: Boolean(identifiedHead) && (!isHead || commit.parents.length > 0)
    });
  }

  function runCommitContextAction(action: CommitGraphAction, commit: CommitNode) {
    closeCommitContextMenu(true);
    onCommitAction(action, commit);
  }

  function handleCommitContextMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommitContextMenu(true);
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not(:disabled)"));
    if (items.length === 0) {
      return;
    }

    event.preventDefault();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex].focus();
  }

  async function handleCommitClick(commit: CommitNode) {
    const nextExpandedHash = expandedHash === commit.hash ? null : commit.hash;

    if (!nextExpandedHash) {
      onSelectCommit("");
      setExpandedHash(null);
      setHoveredDotHash(null);
      return;
    }

    onSelectCommit(commit.hash);
    setHoveredDotHash(commit.hash);

    const hasReadyDetails = Boolean(commitDetailsByHash[commit.hash]) || commit.files.length > 0;
    if (!hasReadyDetails) {
      await ensureCommitDetails(commit);
    } else {
      void ensureCommitDetails(commit);
    }

    setExpandedHash(nextExpandedHash);
  }

  async function ensureCommitDetails(commit: CommitNode): Promise<CommitNode | undefined> {
    const cached = commitDetailsByHash[commit.hash];
    if (cached) {
      return cached;
    }

    if (commit.files.length > 0) {
      setCommitDetailsByHash((current) => (current[commit.hash] ? current : { ...current, [commit.hash]: commit }));
      return commit;
    }

    if (loadingDetailsHash === commit.hash) {
      return undefined;
    }

    if (!project) {
      setCommitDetailsByHash((current) => ({ ...current, [commit.hash]: commit }));
      return commit;
    }

    setLoadingDetailsHash(commit.hash);
    setDetailsErrorByHash((current) => {
      const next = { ...current };
      delete next[commit.hash];
      return next;
    });

    try {
      const details = await apiClient.getCommitDetails(project, commit.hash);
      setCommitDetailsByHash((current) => ({ ...current, [commit.hash]: details }));
      return details;
    } catch (error) {
      setDetailsErrorByHash((current) => ({
        ...current,
        [commit.hash]: error instanceof Error ? error.message : "无法读取提交变更。"
      }));
      return undefined;
    } finally {
      setLoadingDetailsHash((current) => (current === commit.hash ? null : current));
    }
  }

  async function loadBlame() {
    const filePath = advancedDraft.path?.trim();
    if (!project || !filePath) {
      setBlameError("请先填写仓库内文件路径。");
      return;
    }
    setBlameLoading(true);
    setBlameError("");
    try {
      setBlameLines(await apiClient.getBlame(project, filePath));
    } catch (error) {
      setBlameLines([]);
      setBlameError(error instanceof Error ? error.message : "无法读取文件 Blame。");
    } finally {
      setBlameLoading(false);
    }
  }

  return (
    <section className={`graph-sidebar graph-panel ${panelOpen ? "" : "panel-collapsed"}`}>
      <div className="graph-section-title">
        <PathTooltip content={panelOpen ? "收起图表" : "展开图表"} className="graph-title-tooltip">
          <button type="button" className="graph-title-label" aria-label={panelOpen ? "收起图表" : "展开图表"} onClick={onTogglePanel}>
            <span className="graph-title-toggle" aria-hidden="true">
              {panelOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
            <span className="graph-title-text">图表</span>
            <span className="graph-count">{commits.length}</span>
          </button>
        </PathTooltip>
        {panelOpen ? (
          <div className="graph-toolbar" aria-label="图表操作">
            <PathTooltip content="选择图表引用" className="graph-toolbar-tooltip graph-ref-filter-tooltip">
              <button
                ref={refsButtonRef}
                type="button"
                className={`graph-ref-filter-button ${refsMenuOpen ? "active" : ""}`}
                aria-label="选择图表引用"
                aria-haspopup="menu"
                aria-expanded={refsMenuOpen}
                onClick={toggleRefsMenu}
              >
                <GitBranch size={16} />
                <span>{historyFilterLabel}</span>
              </button>
            </PathTooltip>
            {primaryGraphOperations.map((operation) => {
              const Icon = operation.icon;
              return (
                <PathTooltip content={operation.title} className={`graph-toolbar-tooltip graph-operation-shortcut graph-operation-${operation.id}`} key={operation.id}>
                  <button
                    type="button"
                    className="icon-button compact-icon"
                    aria-label={operation.title}
                    onClick={() => onOperation(operation.label)}
                    disabled={gitOperationLocked}
                  >
                    <Icon size={GRAPH_TOOLBAR_ICON_SIZE} />
                  </button>
                </PathTooltip>
              );
            })}
            <PathTooltip content="高级历史筛选与 Blame" className="graph-toolbar-tooltip graph-advanced-shortcut">
              <button
                type="button"
                className={`icon-button compact-icon ${advancedOpen || advancedActive ? "active" : ""}`}
                aria-label="高级历史筛选与 Blame"
                onClick={() => setAdvancedOpen(true)}
              >
                <SlidersHorizontal size={GRAPH_TOOLBAR_ICON_SIZE} />
              </button>
            </PathTooltip>
            {secondaryGraphOperations.map((operation) => {
              const Icon = operation.icon;
              return (
                <PathTooltip content={operation.title} className={`graph-toolbar-tooltip graph-operation-shortcut graph-operation-${operation.id}`} key={operation.id}>
                  <button
                    type="button"
                    className="icon-button compact-icon"
                    aria-label={operation.title}
                    onClick={() => onOperation(operation.label)}
                    disabled={gitOperationLocked}
                  >
                    <Icon size={GRAPH_TOOLBAR_ICON_SIZE} />
                  </button>
                </PathTooltip>
              );
            })}
            <PathTooltip content="搜索提交" className="graph-toolbar-tooltip graph-search-shortcut">
              <button
                ref={searchButtonRef}
                type="button"
                className={`icon-button compact-icon ${searchOpen || commitQuery ? "active" : ""}`}
                aria-label="搜索提交"
                onClick={() => {
                  setViewMenuOpen(false);
                  setSearchOpen((value) => !value);
                }}
              >
                <Search size={GRAPH_TOOLBAR_ICON_SIZE} />
              </button>
            </PathTooltip>
            <PathTooltip content="更多图表操作" className="graph-toolbar-tooltip">
              <button
                ref={viewMenuButtonRef}
                type="button"
                className={`icon-button compact-icon ${viewMenuOpen ? "active" : ""}`}
                aria-label="更多图表操作"
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}
                onClick={toggleViewMenu}
              >
                <MoreHorizontal size={GRAPH_TOOLBAR_ICON_SIZE} />
              </button>
            </PathTooltip>
            {refsMenuOpen && typeof document !== "undefined"
              ? createPortal(
                  <GraphHistoryRefsMenu
                    refs={historyRefs}
                    filter={refsMenuFilter ?? historyFilter}
                    query={refsQuery}
                    onQueryChange={setRefsQuery}
                    onSelectMode={selectHistoryFilterMode}
                    onToggleRef={toggleHistoryRef}
                    onClose={closeRefsMenu}
                    menuRef={refsMenuRef}
                  />,
                  document.querySelector(".app-shell") ?? document.body
                )
              : null}
            {viewMenuOpen && viewMenuPosition && typeof document !== "undefined"
              ? createPortal(
                  <div className="floating-menu graph-view-menu graph-view-menu-portal" role="menu" style={viewMenuPosition} ref={viewMenuRef}>
                    {visibleGraphOperations.map((operation) => {
                      const Icon = operation.icon;
                      return (
                        <button
                          type="button"
                          role="menuitem"
                          className="graph-view-menu-operation"
                          disabled={gitOperationLocked}
                          key={`menu-${operation.id}`}
                          onClick={() => {
                            setViewMenuOpen(false);
                            onOperation(operation.label);
                          }}
                        >
                          <span className="graph-view-menu-check" aria-hidden="true"><Icon size={14} /></span>
                          {operation.menuLabel}
                        </button>
                      );
                    })}
                    <div className="menu-separator" role="separator" />
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={fileViewMode === "list"}
                      className={fileViewMode === "list" ? "active" : ""}
                      onClick={() => selectFileViewMode("list")}
                    >
                      <span className="graph-view-menu-check" aria-hidden="true">
                        {fileViewMode === "list" ? <Check size={14} /> : null}
                      </span>
                      以列表形式查看
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={fileViewMode === "tree"}
                      className={fileViewMode === "tree" ? "active" : ""}
                      onClick={() => selectFileViewMode("tree")}
                    >
                      <span className="graph-view-menu-check" aria-hidden="true">
                        {fileViewMode === "tree" ? <Check size={14} /> : null}
                      </span>
                      以树形式查看
                    </button>
                  </div>,
                  document.querySelector(".app-shell") ?? document.body
                )
              : null}
          </div>
        ) : null}
      </div>

      {panelOpen ? (
        <>
          {searchOpen ? (
            <div className="graph-search-row" ref={searchRowRef}>
              <label className="history-search graph-search">
                <Search size={14} />
                <input
                  ref={searchInputRef}
                  value={commitQuery}
                  onChange={(event) => setCommitQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setSearchOpen(false);
                    }
                  }}
                  placeholder="搜索提交"
                />
              </label>
            </div>
          ) : null}

          <div className="graph-commit-list" role="list" aria-label="提交图" ref={graphListRef} onScroll={handleGraphListScroll}>
            {filteredCommits.length === 0 && loading ? (
              <div className="graph-loading-state" role="status" aria-live="polite" aria-label="正在加载提交图">
                <span aria-hidden="true" />
              </div>
            ) : null}
            {filteredCommits.length === 0 && !loading ? <div className="empty-state graph-empty">当前仓库没有可显示的提交。</div> : null}
            {operationProject ? (
              <GraphOperationRow
                project={operationProject}
                onContinueMerge={onContinueMerge}
                onAbortMerge={onAbortMerge}
                busy={operationBusy}
              />
            ) : null}
            {syncProject ? <GraphSyncRow project={syncProject} /> : null}
            {virtualGraphEnabled && graphVirtualRange.topPadding > 0 ? <div className="graph-virtual-spacer" style={{ height: graphVirtualRange.topPadding }} aria-hidden="true" /> : null}
            {visibleCommits.map((commit, visibleIndex) => {
              const index = virtualGraphEnabled ? graphVirtualRange.startIndex + visibleIndex : visibleIndex;
              const graphLayout = graphLayouts.get(commit.hash) ?? fallbackGraphLayout(commit, rowTones.get(commit.hash) ?? "local");
              const tone = graphLayout.nodeTone;

              return (
                <GraphCommitRow
                  key={commit.hash}
                  commit={commit}
                  graphContext={graphContext}
                  remoteProviders={remoteProviders}
                  graphLayout={graphLayout}
                  tone={tone}
                  selected={commit.hash === selectedHash || commit.hash === hoveredDotHash || commit.hash === expandedHash || commit.hash === commitContextMenu?.commit.hash}
                  expanded={commit.hash === expandedHash}
                  details={commitDetailsByHash[commit.hash]}
                  loadingDetails={loadingDetailsHash === commit.hash}
                  detailsError={detailsErrorByHash[commit.hash]}
                  fileViewMode={fileViewMode}
                  repositoryPath={project?.path}
                  selectedFilePath={selectedCommitFileHash === commit.hash ? selectedCommitFilePath : undefined}
                  isFirst={index === 0}
                  isLast={index === filteredCommits.length - 1}
                  onSelect={() => void handleCommitClick(commit)}
                  onContextMenu={(event) => openCommitContextMenu(event, commit)}
                  onContextMenuKey={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openCommitContextMenuAt(commit, rect.left + 20, rect.top + rect.height / 2, event.currentTarget);
                  }}
                  onRetryDetails={() => void ensureCommitDetails(commit)}
                  onSelectFile={(file) => onSelectCommitFile(commit, file)}
                  onPinFile={(file) => onPinCommitFile(commit, file)}
                  onHoverStart={(row) => scheduleHover(commit, row)}
                  onHoverEnd={scheduleCloseHover}
                />
              );
            })}
            {virtualGraphEnabled && graphVirtualRange.bottomPadding > 0 ? <div className="graph-virtual-spacer" style={{ height: graphVirtualRange.bottomPadding }} aria-hidden="true" /> : null}
            {!loading && !loadingMore ? (
              hasMore ? (
                <button type="button" className="graph-load-more" onClick={onLoadMore}>
                  <RefreshCw size={14} />
                  加载更多提交
                </button>
              ) : commits.length > 0 ? <div className="graph-history-end">已加载到当前筛选范围末尾</div> : null
            ) : null}
          </div>
        </>
      ) : null}
      {hoveredCommit && typeof document !== "undefined"
        ? createPortal(
            <CommitHoverCard commit={hoveredCommit} graphContext={graphContext} x={hoverPosition.x} y={hoverPosition.y} onMouseEnter={keepHoverOpen} onMouseLeave={scheduleCloseHover} />,
            document.querySelector(".app-shell") ?? document.body
          )
        : null}
      {commitContextMenu && typeof document !== "undefined"
        ? createPortal(
            <div
              className="floating-menu graph-commit-menu"
              role="menu"
              style={{ left: commitContextMenu.x, top: commitContextMenu.y }}
              ref={commitContextMenuRef}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={handleCommitContextMenuKeyDown}
            >
              <button type="button" role="menuitem" onClick={() => runCommitContextAction("copyHash", commitContextMenu.commit)}>
                <Copy size={14} />
                复制提交 hash
              </button>
              <button type="button" role="menuitem" onClick={() => runCommitContextAction("copyMessage", commitContextMenu.commit)}>
                <GitCommitHorizontal size={14} />
                复制提交信息
              </button>
              <div className="menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={!commitContextMenu.isHead || !commitContextMenu.isLocalOnly}
                onClick={() => runCommitContextAction("amendMessage", commitContextMenu.commit)}
              >
                <MessageSquareText size={14} />
                修改此提交信息
              </button>
              <button type="button" role="menuitem" onClick={() => runCommitContextAction("revert", commitContextMenu.commit)}>
                <RotateCcw size={14} />
                还原此提交
              </button>
              <button type="button" role="menuitem" onClick={() => runCommitContextAction("cherryPick", commitContextMenu.commit)}>
                <GitCommitHorizontal size={14} />
                Cherry-pick 此提交
              </button>
              <button type="button" role="menuitem" onClick={() => runCommitContextAction("createBranch", commitContextMenu.commit)}>
                <GitBranchPlus size={14} />
                从此提交创建分支
              </button>
              <div className="menu-separator" role="separator" />
              <button type="button" role="menuitem" disabled={!commitContextMenu.canUndoHead} onClick={() => runCommitContextAction("resetSoft", commitContextMenu.commit)}>
                <Undo2 size={14} />
                {commitContextMenu.isHead ? "撤销此提交，保留更改" : "重置到此提交，保留更改"}
              </button>
              <button type="button" role="menuitem" disabled={!commitContextMenu.canUndoHead} onClick={() => runCommitContextAction("resetMixed", commitContextMenu.commit)}>
                <Undo2 size={14} />
                {commitContextMenu.isHead ? "撤销此提交，取消暂存" : "重置到此提交，取消暂存"}
              </button>
              <button type="button" role="menuitem" className="danger" disabled={!commitContextMenu.canUndoHead} onClick={() => runCommitContextAction("resetHard", commitContextMenu.commit)}>
                <AlertTriangle size={14} />
                {commitContextMenu.isHead ? "撤销此提交，丢弃更改" : "重置到此提交，丢弃更改"}
              </button>
            </div>,
            document.querySelector(".app-shell") ?? document.body
          )
        : null}
      {advancedOpen && typeof document !== "undefined"
        ? createPortal(
            <div className="graph-advanced-backdrop" role="presentation">
              <section ref={advancedDialogRef} className="graph-advanced-dialog" role="dialog" aria-modal="true" aria-labelledby="graph-advanced-title">
                <header>
                  <span><SlidersHorizontal size={18} /><strong id="graph-advanced-title">历史筛选与文件追溯</strong></span>
                  <button type="button" className="icon-button compact-icon" aria-label="关闭" onClick={() => setAdvancedOpen(false)}><X size={17} /></button>
                </header>
                <form className="graph-advanced-form" onSubmit={(event) => {
                  event.preventDefault();
                  onAdvancedQueryChange(normalizeAdvancedQuery(advancedDraft));
                  setAdvancedOpen(false);
                }}>
                  <label><span>提交内容</span><input value={advancedDraft.search ?? ""} onChange={(event) => setAdvancedDraft((current) => ({ ...current, search: event.target.value }))} placeholder="提交标题或正文" /></label>
                  <label><span>作者</span><input value={advancedDraft.author ?? ""} onChange={(event) => setAdvancedDraft((current) => ({ ...current, author: event.target.value }))} placeholder="姓名或邮箱" /></label>
                  <label><span>开始日期</span><input type="date" value={advancedDraft.after ?? ""} onChange={(event) => setAdvancedDraft((current) => ({ ...current, after: event.target.value }))} /></label>
                  <label><span>结束日期</span><input type="date" value={advancedDraft.before ?? ""} onChange={(event) => setAdvancedDraft((current) => ({ ...current, before: event.target.value }))} /></label>
                  <label className="wide"><span>仓库内文件路径</span><input value={advancedDraft.path ?? ""} onChange={(event) => { setAdvancedDraft((current) => ({ ...current, path: event.target.value })); setBlameLines([]); setBlameError(""); }} placeholder="src/components/App.tsx" /></label>
                  <div className="graph-advanced-actions wide">
                    <button type="button" className="secondary" onClick={() => { setAdvancedDraft({}); setBlameLines([]); setBlameError(""); onAdvancedQueryChange({}); }}>清除筛选</button>
                    <button type="button" className="secondary" disabled={!advancedDraft.path?.trim() || blameLoading} onClick={() => void loadBlame()}>{blameLoading ? "正在读取" : "查看 Blame"}</button>
                    <button type="submit" className="primary">应用筛选</button>
                  </div>
                </form>
                {blameError ? <div className="graph-blame-error">{blameError}</div> : null}
                {blameLines.length > 0 ? (
                  <div className="graph-blame-panel" role="table" aria-label="文件 Blame">
                    <div className="graph-blame-header" role="row"><span>行</span><span>提交</span><span>作者</span><span>时间</span><span>内容</span></div>
                    {blameLines.map((line) => (
                      <div className="graph-blame-row" role="row" key={`${line.hash}-${line.lineNumber}`}>
                        <span>{line.lineNumber}</span><code>{line.shortHash}</code><PathTooltip content={line.authorEmail} className="graph-blame-author-tooltip"><span>{line.authorName}</span></PathTooltip><time>{formatBlameDate(line.authorDate)}</time><code>{line.content || " "}</code>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>,
            document.querySelector(".app-shell") ?? document.body
          )
        : null}
    </section>
  );
}

function GraphHistoryRefsMenu({
  refs,
  filter,
  query,
  onQueryChange,
  onSelectMode,
  onToggleRef,
  onClose,
  menuRef
}: {
  refs: GitHistoryRef[];
  filter: GitHistoryFilter;
  query: string;
  onQueryChange: (query: string) => void;
  onSelectMode: (mode: Exclude<GitHistoryFilter["mode"], "custom">) => void;
  onToggleRef: (ref: GitHistoryRef) => void;
  onClose: () => void;
  menuRef: RefObject<HTMLDivElement>;
}) {
  const selectedRefIds = new Set(filter.mode === "custom" ? filter.refIds ?? [] : []);
  const selectedCount = filter.mode === "all" || filter.mode === "auto" ? 1 : selectedRefIds.size;
  const filteredRefs = filterHistoryRefs(refs, query);
  const groups = groupHistoryRefs(filteredRefs);

  return (
    <div className="branch-dialog-backdrop graph-refs-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="branch-dialog graph-refs-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="选择图表引用"
        ref={menuRef}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="branch-dialog-header">
          <span className="branch-dialog-title">
            <GitBranch size={15} />
            选择图表引用
            <small>已选 {selectedCount} 项</small>
          </span>
          <PathTooltip content="关闭引用选择" className="graph-toolbar-tooltip">
            <button type="button" className="icon-button compact-icon" aria-label="关闭引用选择" onClick={onClose}>
              <X size={14} />
            </button>
          </PathTooltip>
        </header>

        <div className="branch-switch-panel graph-refs-switch-panel">
          <label className="branch-search graph-refs-search">
            <Search size={14} />
            <input value={query} autoFocus onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索分支或标签" />
          </label>
          <div className="branch-list graph-refs-list" role="list">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={filter.mode === "auto"}
              className={`branch-list-item graph-ref-mode-item ${filter.mode === "auto" ? "current" : ""}`}
              onClick={() => onSelectMode("auto")}
            >
              <span className="graph-ref-main">
                <span className="graph-ref-list-check" aria-hidden="true">
                  {filter.mode === "auto" ? <Check size={14} /> : <GitBranch size={14} />}
                </span>
                <strong>自动</strong>
              </span>
              <small>当前历史记录项引用</small>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={filter.mode === "all"}
              className={`branch-list-item graph-ref-mode-item ${filter.mode === "all" ? "current" : ""}`}
              onClick={() => onSelectMode("all")}
            >
              <span className="graph-ref-main">
                <span className="graph-ref-list-check" aria-hidden="true">
                  {filter.mode === "all" ? <Check size={14} /> : <GitBranch size={14} />}
                </span>
                <strong>全部</strong>
              </span>
              <small>所有历史记录项引用</small>
            </button>
            {groups.map((group) => (
              <div className="graph-refs-group" key={group.category}>
                <div className="graph-refs-group-title">{historyRefCategoryLabel(group.category)}</div>
                {group.refs.map((ref) => {
                  const selected = selectedRefIds.has(ref.id);
                  const Icon = ref.type === "remoteBranch" ? Cloud : ref.type === "tag" ? Tag : GitBranch;
                  const toneClass = ref.type === "remoteBranch" ? "remote" : ref.type === "tag" ? "tag" : "local";
                  return (
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={selected}
                      className={`branch-list-item graph-ref-list-item ${toneClass} ${selected ? "current" : ""}`}
                      key={ref.id}
                      onClick={() => onToggleRef(ref)}
                    >
                      <span className="graph-ref-main">
                        <span className="graph-ref-list-check" aria-hidden="true">
                          {selected ? <Check size={14} /> : <Icon size={14} />}
                        </span>
                        <strong>{ref.name}</strong>
                      </span>
                      <small>{historyRefDescription(ref)}</small>
                    </button>
                  );
                })}
              </div>
            ))}
            {filteredRefs.length === 0 ? <div className="empty-inline graph-refs-empty">没有匹配的引用。</div> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function GraphCommitRow({
  commit,
  graphContext,
  remoteProviders,
  graphLayout,
  tone,
  selected,
  expanded,
  details,
  loadingDetails,
  detailsError,
  fileViewMode,
  repositoryPath,
  selectedFilePath,
  isFirst,
  isLast,
  onSelect,
  onContextMenu,
  onContextMenuKey,
  onRetryDetails,
  onSelectFile,
  onPinFile,
  onHoverStart,
  onHoverEnd
}: {
  commit: CommitNode;
  graphContext: GraphBranchContext;
  remoteProviders: Record<string, RemoteHostingProvider>;
  graphLayout: GraphRowLayout;
  tone: GraphTone;
  selected: boolean;
  expanded: boolean;
  details?: CommitNode;
  loadingDetails: boolean;
  detailsError?: string;
  fileViewMode: GraphFileViewMode;
  repositoryPath?: string;
  selectedFilePath?: string;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onContextMenuKey: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onRetryDetails: () => void;
  onSelectFile: (file: ChangedFile) => void;
  onPinFile: (file: ChangedFile) => void;
  onHoverStart: (row: HTMLElement) => void;
  onHoverEnd: () => void;
}) {
  const visibleRefs = visibleRefsForCommit(commit, graphContext);
  const localRefs = visibleRefs.filter((ref) => ref.type !== "remoteBranch" && ref.type !== "tag");
  const remoteRefs = visibleRefs.filter((ref) => ref.type === "remoteBranch");
  const tagRefs = visibleRefs.filter((ref) => ref.type === "tag");
  const primaryRefs = localRefs.length > 0 ? localRefs.slice(0, 1) : tagRefs.slice(0, 1);
  const overflowRefs = localRefs.length > 0 ? [...localRefs.slice(1), ...tagRefs] : tagRefs.slice(1);
  const rowStyle = {
    "--graph-row-gutter": `${graphFileGutter(graphLayout.expansionLines)}px`
  } as CSSProperties;

  return (
    <div role="listitem" className={`graph-commit-entry graph-tone-${tone} ${expanded ? "expanded" : ""} ${isLast ? "last" : ""}`}>
      <button
        type="button"
        className={`graph-commit-row graph-tone-${tone} ${selected ? "active" : ""}`}
        style={rowStyle}
        aria-expanded={expanded}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10"
        onClick={onSelect}
        onContextMenu={onContextMenu}
        onKeyDown={(event) => {
          if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
            event.preventDefault();
            event.stopPropagation();
            onContextMenuKey(event);
          }
        }}
        onMouseEnter={(event) => onHoverStart(event.currentTarget)}
        onMouseLeave={onHoverEnd}
        onFocus={(event) => onHoverStart(event.currentTarget)}
        onBlur={onHoverEnd}
      >
        <CompactGraphCell layout={graphLayout} isFirst={isFirst} />
        <span className="graph-commit-main">
          <span className="graph-commit-text">
            <span className="graph-commit-subject">{commit.subject}</span>
            {commit.authorName ? <span className="graph-commit-author">{commit.authorName}</span> : null}
          </span>
          {visibleRefs.length > 0 ? (
            <span className="graph-ref-row">
              {primaryRefs.map((ref) => (
                <span className={refChipClassName(ref, graphContext)} key={`${commit.hash}-${ref.type}-${ref.name}`}>
                  {ref.type === "localBranch" ? (
                    <GitBranch size={10} />
                  ) : ref.type === "tag" ? (
                    <Tag size={10} />
                  ) : (
                    <GitCommitHorizontal size={10} />
                  )}
                  <span className="ref-chip-label">{ref.name}</span>
                </span>
              ))}
              {remoteRefs.length > 0 ? <CompactRemoteRefs refs={remoteRefs} graphContext={graphContext} remoteProviders={remoteProviders} /> : null}
              {overflowRefs.length > 0 ? <CompactAdditionalRefs refs={overflowRefs} /> : null}
            </span>
          ) : null}
        </span>
      </button>
      {expanded ? (
        <GraphCommitExpansion
          commit={details ?? commit}
          graphLayout={graphLayout}
          loading={loadingDetails}
          error={detailsError}
          onRetry={onRetryDetails}
          viewMode={fileViewMode}
          repositoryPath={repositoryPath}
          selectedFilePath={selectedFilePath}
          onSelectFile={onSelectFile}
          onPinFile={onPinFile}
        />
      ) : null}
    </div>
  );
}

function GraphCommitExpansion({
  commit,
  graphLayout,
  loading,
  error,
  onRetry,
  viewMode,
  repositoryPath,
  selectedFilePath,
  onSelectFile,
  onPinFile
}: {
  commit: CommitNode;
  graphLayout: GraphRowLayout;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  viewMode: GraphFileViewMode;
  repositoryPath?: string;
  selectedFilePath?: string;
  onSelectFile: (file: ChangedFile) => void;
  onPinFile: (file: ChangedFile) => void;
}) {
  const expansionLines = graphLayout.expansionLines;
  const fileGutter = graphFileGutter(expansionLines);
  const expansionStyle = {
    "--graph-expansion-x": `${graphLayout.nodeX}px`,
    "--graph-expansion-color": graphToneColor(graphLayout.nodeTone),
    "--graph-file-gutter": `${fileGutter}px`
  } as CSSProperties;

  if (loading) {
    return (
      <div className="graph-commit-expansion graph-commit-expansion-loading" style={expansionStyle} role="status" aria-live="polite" aria-label="正在读取变更文件">
        <GraphExpansionLines lines={expansionLines} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="graph-commit-expansion graph-commit-expansion-state error" style={expansionStyle} role="alert">
        <GraphExpansionLines lines={expansionLines} />
        <span>{error}</span>
        <button type="button" onClick={onRetry}><RefreshCw size={13} />重新读取</button>
      </div>
    );
  }

  if (commit.files.length === 0) {
    return (
      <div className="graph-commit-expansion graph-commit-expansion-state" style={expansionStyle}>
        <GraphExpansionLines lines={expansionLines} />
        没有可显示的变更文件。
      </div>
    );
  }

  if (viewMode === "tree") {
    return (
      <div className="graph-commit-expansion" style={expansionStyle} aria-label="提交变更文件">
        <GraphExpansionLines lines={expansionLines} />
        <GraphCommitFileTree
          files={commit.files}
          repositoryPath={repositoryPath}
          selectedFilePath={selectedFilePath}
          onSelectFile={onSelectFile}
          onPinFile={onPinFile}
        />
      </div>
    );
  }

  return (
    <div className="graph-commit-expansion" style={expansionStyle} aria-label="提交变更文件">
      <GraphExpansionLines lines={expansionLines} />
      {commit.files.map((file) => (
        <GraphCommitFileRow
          file={file}
          repositoryPath={repositoryPath}
          selected={selectedFilePath === file.path}
          showDirectory
          key={`${commit.hash}-${file.path}-${file.status}`}
          onSelect={() => onSelectFile(file)}
          onPin={() => onPinFile(file)}
        />
      ))}
    </div>
  );
}

function GraphExpansionLines({ lines }: { lines: GraphExpansionLine[] }) {
  return (
    <div className="graph-commit-expansion-lines" aria-hidden="true">
      {lines.map((line) => (
        <span
          className="graph-commit-expansion-line"
          style={
            {
              "--graph-expansion-line-x": `${line.x}px`,
              "--graph-expansion-line-color": graphToneColor(line.tone)
            } as CSSProperties
          }
          key={`${line.x}-${line.tone}`}
        />
      ))}
    </div>
  );
}

function graphFileGutter(lines: GraphExpansionLine[]): number {
  const maxLineX = lines.reduce((max, line) => Math.max(max, line.x), 0);
  return Math.max(graphFileBaseGutter, maxLineX + graphFileLanePadding);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type GraphFileTreeEntry =
  | {
      type: "directory";
      name: string;
      path: string;
      children: GraphFileTreeEntry[];
    }
  | {
      type: "file";
      name: string;
      file: ChangedFile;
    };

type MutableGraphFileDirectory = {
  name: string;
  path: string;
  directories: Map<string, MutableGraphFileDirectory>;
  files: ChangedFile[];
};

function GraphCommitFileTree({
  files,
  repositoryPath,
  selectedFilePath,
  onSelectFile,
  onPinFile
}: {
  files: ChangedFile[];
  repositoryPath?: string;
  selectedFilePath?: string;
  onSelectFile: (file: ChangedFile) => void;
  onPinFile: (file: ChangedFile) => void;
}) {
  const entries = useMemo(() => buildGraphFileTree(files), [files]);

  return (
    <div className="graph-commit-file-tree">
      {entries.map((entry) => (
        <GraphCommitFileTreeEntry
          entry={entry}
          level={0}
          repositoryPath={repositoryPath}
          selectedFilePath={selectedFilePath}
          onSelectFile={onSelectFile}
          onPinFile={onPinFile}
          key={entry.type === "directory" ? `dir-${entry.path}` : `file-${entry.file.path}-${entry.file.status}`}
        />
      ))}
    </div>
  );
}

function GraphCommitFileTreeEntry({
  entry,
  level,
  repositoryPath,
  selectedFilePath,
  onSelectFile,
  onPinFile
}: {
  entry: GraphFileTreeEntry;
  level: number;
  repositoryPath?: string;
  selectedFilePath?: string;
  onSelectFile: (file: ChangedFile) => void;
  onPinFile: (file: ChangedFile) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (entry.type === "file") {
    return (
      <GraphCommitFileRow
        file={entry.file}
        repositoryPath={repositoryPath}
        selected={selectedFilePath === entry.file.path}
        showDirectory={false}
        level={level}
        onSelect={() => onSelectFile(entry.file)}
        onPin={() => onPinFile(entry.file)}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        className="graph-commit-folder-row"
        style={graphFileIndentStyle(level)}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span aria-hidden="true" />
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span className="graph-commit-folder-name">{entry.name}</span>
      </button>
      {collapsed
        ? null
        : entry.children.map((child) => (
            <GraphCommitFileTreeEntry
              entry={child}
              level={level + 1}
              repositoryPath={repositoryPath}
              selectedFilePath={selectedFilePath}
              onSelectFile={onSelectFile}
              onPinFile={onPinFile}
              key={child.type === "directory" ? `dir-${child.path}` : `file-${child.file.path}-${child.file.status}`}
            />
          ))}
    </>
  );
}

function GraphCommitFileRow({
  file,
  repositoryPath,
  selected,
  level = 0,
  showDirectory = true,
  onSelect,
  onPin
}: {
  file: ChangedFile;
  repositoryPath?: string;
  selected: boolean;
  level?: number;
  showDirectory?: boolean;
  onSelect: () => void;
  onPin: () => void;
}) {
  const clickTimerRef = useRef<number | undefined>();
  const fullPath = absoluteFilePath(repositoryPath, file.path);
  const icon = fileIconInfo(file.path);

  useEffect(
    () => () => {
      window.clearTimeout(clickTimerRef.current);
    },
    []
  );

  function scheduleSelect() {
    window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      onSelect();
    }, 260);
  }

  function pinImmediately() {
    window.clearTimeout(clickTimerRef.current);
    onPin();
  }

  return (
    <button
      type="button"
      className={`graph-commit-file-row ${selected ? "active" : ""}`}
      style={graphFileIndentStyle(level)}
      onClick={scheduleSelect}
      onDoubleClick={(event) => {
        event.preventDefault();
        pinImmediately();
      }}
    >
      <span className={`scm-file-icon ${icon.className}`}>{icon.label}</span>
      <span className="graph-commit-file-main">
        <PathTooltip path={fullPath} className="graph-commit-file-name">
          {file.path.split(/[\\/]/).filter(Boolean).at(-1) ?? file.path}
        </PathTooltip>
        {showDirectory ? <span className="graph-commit-file-dir">{directoryName(file.path)}</span> : null}
      </span>
      <span className={`graph-commit-file-status ${file.status}`}>{statusCode(file.status)}</span>
    </button>
  );
}

function buildGraphFileTree(files: ChangedFile[]): GraphFileTreeEntry[] {
  const root: MutableGraphFileDirectory = createGraphFileDirectory("", "");

  for (const file of files) {
    const parts = file.path.split(/[\\/]/).filter(Boolean);
    let directory = root;

    for (const part of parts.slice(0, -1)) {
      const nextPath = directory.path ? `${directory.path}/${part}` : part;
      const existing = directory.directories.get(part);
      if (existing) {
        directory = existing;
        continue;
      }

      const nextDirectory = createGraphFileDirectory(part, nextPath);
      directory.directories.set(part, nextDirectory);
      directory = nextDirectory;
    }

    directory.files.push(file);
  }

  return graphFileDirectoryEntries(root);
}

function createGraphFileDirectory(name: string, path: string): MutableGraphFileDirectory {
  return {
    name,
    path,
    directories: new Map(),
    files: []
  };
}

function graphFileDirectoryEntries(directory: MutableGraphFileDirectory): GraphFileTreeEntry[] {
  const directories: GraphFileTreeEntry[] = Array.from(directory.directories.values()).map((child) => ({
    type: "directory",
    name: child.name,
    path: child.path,
    children: graphFileDirectoryEntries(child)
  }));
  const files: GraphFileTreeEntry[] = directory.files.map((file) => ({
    type: "file",
    name: file.path.split(/[\\/]/).filter(Boolean).at(-1) ?? file.path,
    file
  }));

  return [...directories, ...files].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
}

function graphFileIndentStyle(level: number): CSSProperties {
  return { "--graph-file-indent": `${level * 16}px` } as CSSProperties;
}

function statusCode(status: ChangedFile["status"]): string {
  const labels: Record<ChangedFile["status"], string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    copied: "C",
    untracked: "U",
    ignored: "I",
    conflicted: "!"
  };

  return labels[status];
}

function directoryName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : "";
}

function buildGraphBranchContext(project: GitProject | undefined, historyRefs: GitHistoryRef[], historyFilter: GitHistoryFilter): GraphBranchContext {
  const currentBranch = project?.status?.currentBranch ?? undefined;
  const upstream = project?.status?.upstream;
  const visibleRefIds = new Set<string>();
  const currentRef = historyRefs.find((ref) => ref.current) ?? (currentBranch ? { id: `refs/heads/${currentBranch}` } : undefined);
  const upstreamRef = historyRefs.find((ref) => ref.upstream) ?? (upstream ? { id: `refs/remotes/${upstream}` } : undefined);

  if (historyFilter.mode === "custom") {
    for (const refId of historyFilter.refIds ?? []) {
      visibleRefIds.add(refId);
    }
  } else if (historyFilter.mode === "auto") {
    if (currentRef) {
      visibleRefIds.add(currentRef.id);
    }
    if (upstreamRef) {
      visibleRefIds.add(upstreamRef.id);
    }
  }

  return {
    currentBranch,
    upstream,
    visibleRefIds,
    showAllRefs: historyFilter.mode === "all"
  };
}

function visibleRefsForCommit(commit: CommitNode, graphContext: GraphBranchContext): CommitRef[] {
  return commit.refs
    .filter((ref) => isVisibleGraphRef(ref, graphContext))
    .sort((left, right) => graphRefPriority(left, graphContext) - graphRefPriority(right, graphContext) || left.name.localeCompare(right.name));
}

function isVisibleGraphRef(ref: CommitRef, graphContext: GraphBranchContext): boolean {
  if (ref.name.endsWith("/HEAD")) {
    return false;
  }

  if (ref.type === "head") {
    return !graphContext.currentBranch;
  }

  if (graphContext.showAllRefs) {
    return true;
  }

  return graphContext.visibleRefIds.has(commitRefId(ref)) || isCurrentBranchRef(ref, graphContext) || isUpstreamBranchRef(ref, graphContext);
}

function isCurrentBranchRef(ref: CommitRef, graphContext: GraphBranchContext): boolean {
  return ref.type === "localBranch" && Boolean(graphContext.currentBranch) && ref.name === graphContext.currentBranch;
}

function isUpstreamBranchRef(ref: CommitRef, graphContext: GraphBranchContext): boolean {
  return ref.type === "remoteBranch" && Boolean(graphContext.upstream) && ref.name === graphContext.upstream;
}

function graphRefPriority(ref: CommitRef, graphContext: GraphBranchContext): number {
  if (isCurrentBranchRef(ref, graphContext)) {
    return 0;
  }

  if (isUpstreamBranchRef(ref, graphContext)) {
    return 1;
  }

  if (graphContext.visibleRefIds.has(commitRefId(ref))) {
    return 2;
  }

  if (ref.type === "tag") {
    return 4;
  }

  return 3;
}

function refChipClassName(ref: CommitRef, graphContext: GraphBranchContext): string {
  return `ref-chip ${ref.type} ${graphContext.visibleRefIds.has(commitRefId(ref)) ? "selectedRef" : ""}`;
}

function commitRefId(ref: CommitRef): string {
  switch (ref.type) {
    case "localBranch":
      return `refs/heads/${ref.name}`;
    case "remoteBranch":
      return `refs/remotes/${ref.name}`;
    case "tag":
      return `refs/tags/${ref.name}`;
    case "head":
      return "HEAD";
  }
}

function graphHistoryFilterLabel(filter: GitHistoryFilter, refs: GitHistoryRef[]): string {
  if (filter.mode === "all") {
    return "全部";
  }

  if (filter.mode === "auto") {
    return "自动";
  }

  const refIds = filter.refIds ?? [];
  if (refIds.length === 1) {
    return refs.find((ref) => ref.id === refIds[0])?.name ?? "1 项";
  }

  return `${refIds.length} 项`;
}

function CompactRemoteRefs({
  refs,
  graphContext,
  remoteProviders
}: {
  refs: CommitRef[];
  graphContext: GraphBranchContext;
  remoteProviders: Record<string, RemoteHostingProvider>;
}) {
  const providers = new Set(refs.map((ref) => remoteRefProvider(ref.name, remoteProviders)).filter((provider): provider is RemoteHostingProvider => Boolean(provider)));
  const selected = refs.some((ref) => graphContext.visibleRefIds.has(commitRefId(ref)));
  const tooltipContent = `远程分支：${refs.map((ref) => ref.name).join(" · ")}`;

  return (
    <PathTooltip content={tooltipContent} className="graph-ref-tooltip" placement="control">
      <span
        className={`ref-chip remoteBranch remote-ref-summary ${selected ? "selectedRef" : ""}`}
        aria-label={tooltipContent}
      >
        <Cloud size={11} />
        {providers.size > 0 ? (
          <span className="remote-provider-icons" aria-hidden="true">
            {providers.has("gitee") ? <span className="remote-provider-gitee">G</span> : null}
            {providers.has("github") ? <Github size={10} /> : null}
          </span>
        ) : null}
      </span>
    </PathTooltip>
  );
}

function CompactAdditionalRefs({ refs }: { refs: CommitRef[] }) {
  const branchNames = refs.filter((ref) => ref.type !== "tag").map((ref) => ref.name);
  const tagNames = refs.filter((ref) => ref.type === "tag").map((ref) => ref.name);
  const tooltipParts = [
    branchNames.length > 0 ? `其他分支：${branchNames.join(" · ")}` : "",
    tagNames.length > 0 ? `标签：${tagNames.join(" · ")}` : ""
  ].filter(Boolean);

  return (
    <PathTooltip content={tooltipParts.join("；")} className="graph-ref-tooltip" placement="control">
      <span className="ref-chip ref-overflow-summary" aria-label={tooltipParts.join("；")}>
        +{refs.length}
      </span>
    </PathTooltip>
  );
}

function remoteRefProvider(refName: string, remoteProviders: Record<string, RemoteHostingProvider>): RemoteHostingProvider | undefined {
  const remoteName = refName.split("/", 1)[0]?.toLowerCase() ?? "";
  if (remoteProviders[remoteName]) {
    return remoteProviders[remoteName];
  }
  if (remoteName.includes("github")) {
    return "github";
  }
  if (remoteName.includes("gitee")) {
    return "gitee";
  }
  return undefined;
}

function remoteHostingProvider(urls: string[]): RemoteHostingProvider | undefined {
  if (urls.some((url) => url.toLowerCase().includes("github.com"))) {
    return "github";
  }
  if (urls.some((url) => url.toLowerCase().includes("gitee.com"))) {
    return "gitee";
  }
  return undefined;
}

function hasAdvancedQuery(query: Pick<GitHistoryQuery, "search" | "author" | "after" | "before" | "path">): boolean {
  return Boolean(query.search?.trim() || query.author?.trim() || query.after?.trim() || query.before?.trim() || query.path?.trim());
}

function normalizeAdvancedQuery(
  query: Pick<GitHistoryQuery, "search" | "author" | "after" | "before" | "path">
): Pick<GitHistoryQuery, "search" | "author" | "after" | "before" | "path"> {
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [key, value?.trim() || undefined]).filter(([, value]) => Boolean(value))
  );
}

function formatBlameDate(value: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("zh-CN");
}

function cloneHistoryFilter(filter: GitHistoryFilter): GitHistoryFilter {
  return filter.mode === "custom" ? { mode: "custom", refIds: [...(filter.refIds ?? [])] } : { mode: filter.mode };
}

function filterHistoryRefs(refs: GitHistoryRef[], query: string): GitHistoryRef[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return refs;
  }

  return refs.filter((ref) => `${ref.name} ${ref.id} ${ref.category}`.toLowerCase().includes(keyword));
}

function groupHistoryRefs(refs: GitHistoryRef[]): Array<{ category: GitHistoryRef["category"]; refs: GitHistoryRef[] }> {
  const categoryOrder: GitHistoryRef["category"][] = ["branches", "remote branches", "tags"];
  return categoryOrder
    .map((category) => ({
      category,
      refs: refs.filter((ref) => ref.category === category)
    }))
    .filter((group) => group.refs.length > 0);
}

function historyRefCategoryLabel(category: GitHistoryRef["category"]): string {
  switch (category) {
    case "branches":
      return "分支";
    case "remote branches":
      return "远程分支";
    case "tags":
      return "标签";
  }
}

function historyRefDescription(ref: GitHistoryRef): string {
  const revision = ref.revision ? ref.revision.slice(0, 7) : "";
  if (ref.current) {
    return "当前分支";
  }

  if (ref.upstream) {
    return revision ? `${revision} 处的远程分支` : "处的远程分支";
  }

  if (ref.type === "remoteBranch") {
    return revision ? `${revision} 处的远程分支` : "远程分支";
  }

  if (ref.type === "tag") {
    return revision ? `${revision} 处的标签` : "标签";
  }

  return revision;
}

function GraphOperationRow({
  project,
  onContinueMerge,
  onAbortMerge,
  busy
}: {
  project: GitProject;
  onContinueMerge: () => void;
  onAbortMerge: () => void;
  busy: boolean;
}) {
  const state = project.status?.operationState;
  const hasConflicts = Boolean(project.status?.hasConflicts);
  const branch = project.status?.currentBranch ?? "分离 HEAD";
  const copy = graphOperationCopy(project, state, hasConflicts);
  const showMergeActions = state === "merge";

  return (
    <div className={`graph-operation-row ${showMergeActions ? "with-actions" : ""} ${hasConflicts ? "conflict" : state ?? "status"}`}>
      <span className="graph-operation-icon">{hasConflicts ? <AlertTriangle size={13} /> : <GitCommitHorizontal size={13} />}</span>
      <span className="graph-operation-label">{copy.label}</span>
      <span className="graph-operation-detail">{copy.detail ?? branch}</span>
      {showMergeActions ? (
        <span className="graph-operation-actions">
          <button type="button" className="graph-operation-action" onClick={onContinueMerge} disabled={busy}>
            {busy ? "处理中" : "继续"}
          </button>
          <button type="button" className="graph-operation-action danger" onClick={onAbortMerge} disabled={busy}>
            终止
          </button>
        </span>
      ) : null}
    </div>
  );
}

function graphOperationCopy(project: GitProject, state: GitOperationState | undefined, hasConflicts: boolean): { label: string; detail?: string } {
  if (!state) {
    return {
      label: hasConflicts ? "存在冲突" : "Git 操作进行中",
      detail: hasConflicts ? "先处理冲突文件" : undefined
    };
  }

  const conflictSuffix = hasConflicts ? "，解决冲突后继续" : "";
  switch (state) {
    case "merge": {
      const route = project.status?.mergeSourceBranch && project.status.mergeTargetBranch
        ? `${project.status.mergeSourceBranch} → ${project.status.mergeTargetBranch}`
        : "合并操作进行中";
      return { label: "正在合并", detail: `${route}${conflictSuffix}` };
    }
    case "rebase":
      return { label: "正在变基", detail: `变基操作进行中${conflictSuffix}` };
    case "cherry-pick":
      return { label: "正在 Cherry-pick", detail: `摘取提交进行中${conflictSuffix}` };
    case "revert":
      return { label: "正在还原", detail: `还原提交进行中${conflictSuffix}` };
    case "bisect":
      return { label: "正在二分定位", detail: "Git bisect 操作进行中" };
  }
}

function GraphSyncRow({ project }: { project: GitProject }) {
  const branch = project.status?.currentBranch ?? "当前分支";
  const ahead = project.status?.ahead ?? 0;
  const behind = project.status?.behind ?? 0;
  const label =
    ahead > 0 && behind > 0
      ? `待推送 ${ahead} / 待拉取 ${behind}`
      : ahead > 0
        ? `待推送 ${ahead} 个提交`
        : `待拉取 ${behind} 个提交`;

  return (
    <div className="graph-sync-row">
      <span className={ahead > 0 && behind > 0 ? "sync-ring mixed" : ahead > 0 ? "sync-ring outgoing" : "sync-ring incoming"} />
      <span>{label}</span>
      <span>{branch}</span>
    </div>
  );
}

function CommitHoverCard({
  commit,
  graphContext,
  x,
  y,
  onMouseEnter,
  onMouseLeave
}: {
  commit: CommitNode;
  graphContext: GraphBranchContext;
  x: number;
  y: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const bodyText = commit.body?.trim();
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState<{ width: number; height: number }>();
  const style = commitHoverCardStyle(x, y, cardSize);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }

    const measureCard = () => {
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return;
      }

      setCardSize((current) => (
        current && Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1
          ? current
          : { width: rect.width, height: rect.height }
      ));
    };

    measureCard();
    const resizeObserver = new ResizeObserver(measureCard);
    resizeObserver.observe(card);
    window.addEventListener("resize", measureCard);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureCard);
    };
  }, [bodyText, commit.hash]);

  return (
    <div className="commit-hover-card" style={style} ref={cardRef} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="commit-hover-author">
        <strong>{commit.authorName}</strong>
        <span>{commit.authorDate}</span>
      </div>
      <div className="commit-hover-subject">{commit.subject}</div>
      {bodyText ? <div className="commit-hover-body">{bodyText}</div> : null}
      <div className="commit-hover-footer">
        {visibleRefsForCommit(commit, graphContext)
          .slice(0, 4)
          .map((ref) => (
          <span className={refChipClassName(ref, graphContext)} key={`${commit.hash}-${ref.type}-${ref.name}`}>
            {ref.type === "remoteBranch" ? (
              <Cloud size={10} />
            ) : ref.type === "localBranch" ? (
              <GitBranch size={10} />
            ) : ref.type === "tag" ? (
              <Tag size={10} />
            ) : (
              <GitCommitHorizontal size={10} />
            )}
            <span className="ref-chip-label">{ref.name}</span>
          </span>
        ))}
        <code>{commit.shortHash}</code>
      </div>
    </div>
  );
}

function commitHoverCardStyle(x: number, targetY: number, cardSize?: { width: number; height: number }): CSSProperties {
  if (typeof window === "undefined") {
    return { left: x, top: targetY };
  }

  const measuredWidth = cardSize?.width ?? Math.min(COMMIT_HOVER_CARD_WIDTH, window.innerWidth - COMMIT_HOVER_VIEWPORT_GAP * 2);
  const left = Math.max(COMMIT_HOVER_VIEWPORT_GAP, Math.min(x, window.innerWidth - measuredWidth - COMMIT_HOVER_VIEWPORT_GAP));
  const measuredHeight = cardSize?.height ?? 0;
  const preferredTop = targetY - COMMIT_HOVER_TOP_OFFSET;
  const maxTop = measuredHeight > 0 ? window.innerHeight - measuredHeight - COMMIT_HOVER_VIEWPORT_GAP : window.innerHeight - COMMIT_HOVER_VIEWPORT_GAP;
  const top = Math.max(COMMIT_HOVER_VIEWPORT_GAP, Math.min(preferredTop, maxTop));
  const arrowInset = 12;
  const arrowTop = Math.max(arrowInset, Math.min(targetY - top - COMMIT_HOVER_ARROW_SIZE / 2, Math.max(arrowInset, measuredHeight - arrowInset)));

  return {
    left,
    top,
    "--commit-hover-arrow-top": `${arrowTop}px`
  } as CSSProperties;
}

function buildGraphTones(commits: CommitNode[], graphContext: GraphBranchContext): Map<string, GraphTone> {
  const tones = new Map<string, GraphTone>();
  let activeTone: GraphTone = "plain";

  for (const commit of commits) {
    const tone: GraphTone = refTone(commit, graphContext) ?? activeTone;
    tones.set(commit.hash, tone);
    if (tone !== "plain") {
      activeTone = tone;
    }
  }

  return tones;
}

function buildGraphLayouts(commits: CommitNode[], rowTones: Map<string, GraphTone>, graphContext: GraphBranchContext): Map<string, GraphRowLayout> {
  const layouts = new Map<string, GraphRowLayout>();
  const visibleHashes = new Set(commits.map((commit) => commit.hash));
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  let outputLanesFromPreviousRow: GraphLaneNode[] = [];
  let branchToneIndex = 0;

  commits.forEach((commit) => {
    const parents = visibleParentHashes(commit.parents, visibleHashes);
    const inputLanes = outputLanesFromPreviousRow.map((lane) => ({ ...lane }));
    const inputIndex = inputLanes.findIndex((lane) => lane.id === commit.hash);
    const nodeIndex = inputIndex >= 0 ? inputIndex : inputLanes.length;
    const directTone = refTone(commit, graphContext);
    const inheritedTone = normalizedGraphTone(rowTones.get(commit.hash));
    const outputLanes: GraphLaneNode[] = [];
    let firstParentAdded = false;

    if (parents.length > 0) {
      for (const lane of inputLanes) {
        if (lane.id === commit.hash) {
          if (!firstParentAdded) {
            outputLanes.push({ id: parents[0].hash, tone: normalizedGraphTone(directTone ?? lane.tone) });
            firstParentAdded = true;
          }
          continue;
        }

        outputLanes.push({ ...lane });
      }
    } else {
      for (const lane of inputLanes) {
        if (lane.id !== commit.hash) {
          outputLanes.push({ ...lane });
        }
      }
    }

    for (let parentIndex = firstParentAdded ? 1 : 0; parentIndex < parents.length; parentIndex += 1) {
      const parentHash = parents[parentIndex].hash;
      const parentCommit = commitsByHash.get(parentHash);
      const parentTone =
        parentIndex === 0
          ? directTone ?? rowTones.get(commit.hash)
          : parentCommit
            ? refTone(parentCommit, graphContext)
            : undefined;

      outputLanes.push({
        id: parentHash,
        tone: normalizedGraphTone(parentTone ?? graphBranchLaneTone(branchToneIndex))
      });

      if (!parentTone) {
        branchToneIndex += 1;
      }
    }

    const nodeTone = outputLanes[nodeIndex]?.tone ?? inputLanes[nodeIndex]?.tone ?? directTone ?? inheritedTone;

    const segments: GraphSegment[] = [];
    const expansionLines = new Map<number, GraphExpansionLine>();
    let outputLaneIndex = 0;

    for (let index = 0; index < inputLanes.length; index += 1) {
      const inputLane = inputLanes[index];
      const inputX = graphLaneX(index);

      if (inputLane.id === commit.hash) {
        if (index !== nodeIndex) {
          segments.push({
            type: "curve",
            tone: inputLane.tone,
            x1: inputX,
            y1: 0,
            x2: graphLaneX(nodeIndex),
            y2: graphNodeCenterY,
            connectToNode: true
          });
        } else {
          outputLaneIndex += 1;
        }
        continue;
      }

      while (outputLaneIndex < outputLanes.length && outputLanes[outputLaneIndex].id === commit.hash) {
        outputLaneIndex += 1;
      }

      if (outputLaneIndex < outputLanes.length && inputLane.id === outputLanes[outputLaneIndex].id) {
        const outputX = graphLaneX(outputLaneIndex);
        if (index === outputLaneIndex) {
          segments.push({ type: "line", tone: inputLane.tone, x: inputX, y1: 0, y2: graphRowHeight });
        } else {
          segments.push({
            type: "curve",
            tone: inputLane.tone,
            x1: inputX,
            y1: 0,
            x2: outputX,
            y2: graphRowHeight
          });
        }
        expansionLines.set(outputLaneIndex, { x: outputX, tone: inputLane.tone });
        outputLaneIndex += 1;
      }
    }

    const nodeX = graphLaneX(nodeIndex);
    if (inputIndex >= 0) {
      segments.push({ type: "line", tone: inputLanes[inputIndex].tone, x: nodeX, y1: 0, y2: graphNodeCenterY });
    }

    if (parents.length > 0) {
      const outputTone = outputLanes[nodeIndex]?.tone ?? nodeTone;
      segments.push({ type: "line", tone: outputTone, x: nodeX, y1: graphNodeCenterY, y2: graphRowHeight });
      expansionLines.set(nodeIndex, { x: nodeX, tone: outputTone });

      for (let parentIndex = 1; parentIndex < parents.length; parentIndex += 1) {
        const parentOutputIndex = findLastGraphLaneIndex(outputLanes, parents[parentIndex].hash);
        if (parentOutputIndex < 0 || parentOutputIndex === nodeIndex) {
          continue;
        }

        segments.push({
          type: "curve",
          tone: outputLanes[parentOutputIndex].tone,
          x1: nodeX,
          y1: graphNodeCenterY,
          x2: graphLaneX(parentOutputIndex),
          y2: graphRowHeight,
          merge: true
        });
        expansionLines.set(parentOutputIndex, { x: graphLaneX(parentOutputIndex), tone: outputLanes[parentOutputIndex].tone });
      }
    }

    layouts.set(commit.hash, {
      segments,
      expansionLines: Array.from(expansionLines.values()).sort((left, right) => left.x - right.x),
      nodeX,
      nodeTone: normalizedGraphTone(nodeTone),
      merge: commit.parents.length > 1
    });

    outputLanesFromPreviousRow = outputLanes;
  });

  return layouts;
}

function findLastGraphLaneIndex(lanes: GraphLaneNode[], id: string): number {
  for (let index = lanes.length - 1; index >= 0; index -= 1) {
    if (lanes[index].id === id) {
      return index;
    }
  }

  return -1;
}

function fallbackGraphLayout(commit: CommitNode, tone: GraphTone): GraphRowLayout {
  const normalizedTone = normalizedGraphTone(tone);
  const segments: GraphSegment[] = commit.parents.length > 0 ? [{ type: "line", tone: normalizedTone, x: graphLaneX(0), y1: graphNodeCenterY, y2: graphRowHeight }] : [];
  return {
    segments,
    expansionLines: commit.parents.length > 0 ? [{ x: graphLaneX(0), tone: normalizedTone }] : [],
    nodeX: graphLaneX(0),
    nodeTone: normalizedTone,
    merge: commit.parents.length > 1
  };
}

function visibleParentHashes(parents: string[], visibleHashes: Set<string>): VisibleGraphParent[] {
  const result: VisibleGraphParent[] = [];
  parents.forEach((parent, parentIndex) => {
    const visibleParent = visibleParentHash(parent, visibleHashes);
    if (!visibleParent || result.some((item) => item.hash === visibleParent)) {
      return;
    }

    result.push({ hash: visibleParent, parentIndex });
  });

  return result;
}

function visibleParentHash(parent: string, visibleHashes: Set<string>): string | undefined {
  return visibleHashes.has(parent) ? parent : Array.from(visibleHashes).find((hash) => hash.startsWith(parent));
}

function normalizedGraphTone(tone: GraphTone | undefined): GraphTone {
  return tone && tone !== "plain" ? tone : "local";
}

function graphBranchLaneTone(laneIndex: number): GraphTone {
  return graphBranchTones[Math.max(0, laneIndex - 1) % graphBranchTones.length];
}

function graphLaneX(laneIndex: number): number {
  return 8 + Math.min(laneIndex, 2) * 14;
}

function graphToneColor(tone: GraphTone): string {
  switch (tone) {
    case "remote":
      return "#b886ff";
    case "primary":
      return "#f97316";
    case "secondary":
      return "#f0c36b";
    case "branch-rose":
      return "#d63384";
    case "branch-cyan":
      return "#0ea5a8";
    case "branch-violet":
      return "#8b5cf6";
    case "branch-amber":
      return "#f0b429";
    case "branch-green":
      return "#22a06b";
    case "local":
    case "synced":
    case "plain":
    default:
      return "#2f98ff";
  }
}

function CompactGraphCell({ layout, isFirst }: { layout: GraphRowLayout; isFirst: boolean }) {
  return (
    <svg className={`compact-graph-cell graph-tone-${layout.nodeTone} ${isFirst ? "graph-first-node" : ""}`} viewBox={`0 0 44 ${graphRowHeight}`} aria-hidden="true">
      {layout.segments.map((segment, index) =>
        segment.type === "line" ? (
          <line
            x1={segment.x}
            y1={segment.y1}
            x2={segment.x}
            y2={segment.y2}
            className={`graph-line graph-line-${segment.tone}`}
            key={`line-${index}-${segment.x}-${segment.y1}-${segment.y2}`}
          />
        ) : (
          <path
            d={graphCurvePath(segment)}
            className={`graph-line graph-line-${segment.tone}`}
            key={`curve-${index}-${segment.x1}-${segment.x2}`}
          />
        )
      )}
      {layout.merge ? (
        <>
          <circle cx={layout.nodeX} cy={graphNodeCenterY} r={graphMergeRingRadius} className={`graph-merge-ring graph-node-${layout.nodeTone}`} />
          <circle cx={layout.nodeX} cy={graphNodeCenterY} r="2.3" className={`graph-merge-dot graph-node-${layout.nodeTone}`} />
        </>
      ) : (
        <circle cx={layout.nodeX} cy={graphNodeCenterY} r={graphNodeRadius} className={`graph-node graph-node-${layout.nodeTone}`} />
      )}
    </svg>
  );
}

function graphCurvePath(segment: Extract<GraphSegment, { type: "curve" }>): string {
  if (segment.connectToNode) {
    const midY = (segment.y1 + segment.y2) / 2;
    const direction = graphCurveDirection(segment.x1, segment.x2);
    const nodeX = segment.x2 + direction * graphMergeRingRadius;
    const nodeControlX = nodeX + direction * graphNodeCurveControl;
    return `M ${segment.x1} ${segment.y1} C ${segment.x1} ${midY} ${nodeControlX} ${segment.y2} ${nodeX} ${segment.y2}`;
  }

  if (!segment.merge) {
    return `M ${segment.x1} ${segment.y1} C ${segment.x1} ${graphNodeCenterY} ${segment.x2} ${graphNodeCenterY} ${segment.x2} ${segment.y2}`;
  }

  const midY = (segment.y1 + segment.y2) / 2;
  const direction = graphCurveDirection(segment.x2, segment.x1);
  const nodeX = segment.x1 + direction * graphMergeRingRadius;
  const nodeControlX = nodeX + direction * graphNodeCurveControl;
  return `M ${nodeX} ${segment.y1} C ${nodeControlX} ${segment.y1} ${segment.x2} ${segment.y2 - graphLaneCurveControl} ${segment.x2} ${segment.y2}`;
}

function graphCurveDirection(targetX: number, originX: number): number {
  return targetX >= originX ? 1 : -1;
}

function refTone(commit: CommitNode, graphContext: GraphBranchContext): GraphTone | undefined {
  const visibleRefs = visibleRefsForCommit(commit, graphContext);
  const hasCurrent = visibleRefs.some((ref) => isCurrentBranchRef(ref, graphContext));
  const hasUpstream = visibleRefs.some((ref) => isUpstreamBranchRef(ref, graphContext));
  const hasSelected = visibleRefs.some((ref) => graphContext.visibleRefIds.has(commitRefId(ref)));

  if (hasCurrent && hasUpstream) {
    return "synced";
  }

  if (hasCurrent) {
    return "local";
  }

  if (hasUpstream) {
    return "remote";
  }

  if (hasSelected) {
    return "primary";
  }

  return undefined;
}
