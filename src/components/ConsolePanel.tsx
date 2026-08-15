import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ChevronsDown,
  ChevronsUp,
  ClipboardPaste,
  Copy,
  History,
  ListX,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  Terminal as TerminalIcon
} from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { apiClient } from "../api/client";
import { PathTooltip } from "./PathTooltip";
import type { GitProject, TerminalHistoryEntry, TerminalSessionInfo } from "../types/domain";
import {
  canReplayTerminalHistory,
  captureTerminalInput,
  createTerminalCaptureState,
  observeTerminalOutput,
  type TerminalCaptureState
} from "../../electron/terminalHistory";

type ThemeName = "light" | "dark";
type TerminalStatus = "starting" | "running" | "exited" | "error";

const TERMINAL_RESIZE_DEBOUNCE_MS = 140;
const TERMINAL_FONT_FAMILY = '"Cascadia Code", Consolas, "Courier New", monospace';
const TERMINAL_FONT_SIZE = 12;

interface ConsolePanelProps {
  project?: GitProject;
  disabledProjectIds: string[];
  theme: ThemeName;
  visible: boolean;
  maximized: boolean;
  onToggleMaximized: () => void;
  onHide: () => void;
  onConfirmCloseTabs: (count: number) => Promise<boolean>;
  onConfirmClearHistory: (count: number) => Promise<boolean>;
}

interface TerminalTab {
  id: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  project: GitProject;
  title: string;
  customTitle: boolean;
  status: TerminalStatus;
  statusText: string;
  session?: TerminalSessionInfo;
}

interface TerminalRuntime {
  terminal: Terminal;
  fitAddon: FitAddon;
  inputSubscription: { dispose: () => void };
  selectionSubscription: { dispose: () => void };
  host?: HTMLDivElement;
  opened: boolean;
  resizeObserver?: ResizeObserver;
  resizeFrame: number;
  resizeTimer: number;
  lastResizeCols?: number;
  lastResizeRows?: number;
  sessionId?: string;
  launchId: number;
  restarting: boolean;
  trustedPromptMarkers: boolean;
  captureState: TerminalCaptureState;
}

export function ConsolePanel({ project, disabledProjectIds, theme, visible, maximized, onToggleMaximized, onHide, onConfirmCloseTabs, onConfirmClearHistory }: ConsolePanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeHasSelection, setActiveHasSelection] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyByProject, setHistoryByProject] = useState<Record<string, TerminalHistoryEntry[]>>({});
  const [terminalError, setTerminalError] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<TerminalTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const activeByProjectRef = useRef(new Map<string, string>());
  const runtimeByTabRef = useRef(new Map<string, TerminalRuntime>());
  const tabBySessionRef = useRef(new Map<string, string>());
  const terminalSeedRef = useRef(0);
  const themeRef = useRef<ThemeName>(theme);
  const loadedHistoryProjectsRef = useRef(new Set<string>());
  const disabledProjectKey = disabledProjectIds.join("|");

  const projectTabs = useMemo(() => (project ? tabs.filter((tab) => tab.projectId === project.id) : []), [project, tabs]);
  const activeTab = useMemo(() => projectTabs.find((tab) => tab.id === activeTabId) ?? projectTabs[0] ?? null, [activeTabId, projectTabs]);
  const activeHistory = activeTab ? historyByProject[activeTab.projectId] ?? [] : [];
  const filteredHistory = useMemo(() => {
    const normalizedQuery = historyQuery.trim().toLocaleLowerCase();
    return normalizedQuery
      ? activeHistory.filter((entry) => entry.command.toLocaleLowerCase().includes(normalizedQuery))
      : activeHistory;
  }, [activeHistory, historyQuery]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (!disabledProjectKey) {
      return;
    }

    const disabledProjects = new Set(disabledProjectIds);
    const closingTabs = tabsRef.current.filter((tab) => disabledProjects.has(tab.projectId));
    if (closingTabs.length === 0) {
      return;
    }

    const closingTabIds = new Set(closingTabs.map((tab) => tab.id));
    closingTabs.forEach((tab) => disposeTerminalRuntime(tab.id));
    closingTabs.forEach((tab) => activeByProjectRef.current.delete(tab.projectId));
    const remainingTabs = renumberTerminalTabs(tabsRef.current.filter((tab) => !closingTabIds.has(tab.id)));
    tabsRef.current = remainingTabs;
    setTabs(remainingTabs);
    setActiveTabId((current) => current && closingTabIds.has(current) ? null : current);
    setHistoryOpen(false);
    setRenamingTabId(null);
    setRenameDraft("");
  }, [disabledProjectKey]);

  useEffect(() => {
    activeTabIdRef.current = activeTab?.id ?? activeTabId;
    if (activeTab) {
      activeByProjectRef.current.set(activeTab.projectId, activeTab.id);
    }
    setActiveHasSelection(activeTab ? Boolean(runtimeByTabRef.current.get(activeTab.id)?.terminal.hasSelection()) : false);
  }, [activeTab, activeTabId]);

  useEffect(() => {
    const unsubscribeData = apiClient.onTerminalData((event) => {
      const tabId = tabBySessionRef.current.get(event.sessionId);
      if (!tabId) {
        return;
      }

      const runtime = runtimeByTabRef.current.get(tabId);
      if (!runtime) {
        return;
      }
      runtime.captureState = observeTerminalOutput(runtime.captureState, event.data, runtime.trustedPromptMarkers);
      runtime.terminal.write(event.data);
    });
    const unsubscribeExit = apiClient.onTerminalExit((event) => {
      const tabId = tabBySessionRef.current.get(event.sessionId);
      if (!tabId) {
        return;
      }

      tabBySessionRef.current.delete(event.sessionId);
      const runtime = runtimeByTabRef.current.get(tabId);
      if (runtime) {
        runtime.sessionId = undefined;
        runtime.terminal.writeln("");
        runtime.terminal.writeln(`[进程已退出：${event.exitCode ?? event.signal ?? "unknown"}]`);
      }

      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                session: undefined,
                status: "exited",
                statusText: "已退出"
              }
            : tab
        )
      );
    });

    return () => {
      unsubscribeData();
      unsubscribeExit();
      for (const tabId of Array.from(runtimeByTabRef.current.keys())) {
        disposeTerminalRuntime(tabId);
      }
    };
  }, []);

  useEffect(() => {
    themeRef.current = theme;
    window.requestAnimationFrame(() => {
      const host = panelRef.current ?? document.documentElement;
      for (const runtime of runtimeByTabRef.current.values()) {
        runtime.terminal.options.theme = terminalTheme(host, themeRef.current);
        runtime.terminal.options.minimumContrastRatio = terminalContrastRatio(themeRef.current);
        runtime.terminal.refresh(0, Math.max(0, runtime.terminal.rows - 1));
      }
    });
  }, [theme]);

  useEffect(() => {
    if (!project || loadedHistoryProjectsRef.current.has(project.id)) {
      return;
    }
    loadedHistoryProjectsRef.current.add(project.id);
    void apiClient.getTerminalHistory(project.id).then((entries) => {
      setHistoryByProject((current) => ({ ...current, [project.id]: entries }));
    }).catch((error) => {
      loadedHistoryProjectsRef.current.delete(project.id);
      setTerminalError(terminalErrorMessage("命令历史加载失败", error));
    });
  }, [project?.id]);

  useEffect(() => {
    if (!visible || !project || project.remote?.connectionEnabled === false) {
      return;
    }

    const currentTabs = tabsRef.current.filter((tab) => tab.projectId === project.id);
    const rememberedTabId = activeByProjectRef.current.get(project.id);
    const rememberedTab = currentTabs.find((tab) => tab.id === rememberedTabId);
    if (rememberedTab) {
      setActiveTabId(rememberedTab.id);
      return;
    }

    if (currentTabs.length > 0) {
      setActiveTabId(currentTabs[0].id);
      return;
    }

    if (tabsRef.current.length > 0) {
      setActiveTabId(null);
      return;
    }

    createTerminalTab(project);
  }, [project?.id, project?.remote?.connectionEnabled, visible]);

  useEffect(() => {
    if (!visible || !activeTab) {
      return;
    }

    fitAndResizeTab(activeTab.id);
    runtimeByTabRef.current.get(activeTab.id)?.terminal.focus();
  }, [activeTab?.id, visible]);

  useEffect(() => {
    if (!historyOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHistoryOpen(false);
        runtimeByTabRef.current.get(activeTabIdRef.current ?? "")?.terminal.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [historyOpen]);

  function createTerminalTab(targetProject = project) {
    if (!targetProject) {
      return;
    }
    if (targetProject.remote?.connectionEnabled === false) {
      setTerminalError("远程连接已暂停，请先开启连接后再创建终端。");
      return;
    }

    const tabId = `terminal-tab-${Date.now()}-${++terminalSeedRef.current}`;
    const terminal = createTerminal(panelRef.current ?? document.documentElement, themeRef.current);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const inputSubscription = terminal.onData((data) => {
      const runtime = runtimeByTabRef.current.get(tabId);
      if (runtime?.sessionId) {
        const capture = captureTerminalInput(runtime.captureState, data);
        runtime.captureState = capture.state;
        void apiClient.writeTerminal(runtime.sessionId, data).then((written) => {
          if (written && capture.command) {
            void recordTerminalCommand(tabId, capture.command);
          }
          if (!written) {
            setTerminalError("终端输入写入失败，当前会话可能已经结束。");
          }
        }).catch((error) => setTerminalError(terminalErrorMessage("终端输入写入失败", error)));
      }
    });
    const selectionSubscription = terminal.onSelectionChange(() => {
      if (activeTabIdRef.current === tabId) {
        setActiveHasSelection(terminal.hasSelection());
      }
    });

    runtimeByTabRef.current.set(tabId, {
      terminal,
      fitAddon,
      inputSubscription,
      selectionSubscription,
      opened: false,
      resizeFrame: 0,
      resizeTimer: 0,
      launchId: 0,
      restarting: false,
      trustedPromptMarkers: false,
      captureState: createTerminalCaptureState()
    });
    terminal.attachCustomKeyEventHandler((event) => handleTerminalKeyEvent(tabId, event));

    terminal.writeln("正在启动控制台...");

    const nextTab: TerminalTab = {
      id: tabId,
      projectId: targetProject.id,
      projectName: targetProject.name,
      projectPath: targetProject.path,
      project: targetProject,
      title: "终端",
      customTitle: false,
      status: "starting",
      statusText: "启动中"
    };

    setTabs((current) => renumberTerminalTabs([...current, nextTab]));
    setActiveTabId(tabId);
    activeByProjectRef.current.set(targetProject.id, tabId);

    void launchTerminalSession(tabId, targetProject);
  }

  async function launchTerminalSession(tabId: string, targetProject: GitProject) {
    const initialRuntime = runtimeByTabRef.current.get(tabId);
    if (!initialRuntime) {
      return;
    }

    const launchId = initialRuntime.launchId + 1;
    initialRuntime.launchId = launchId;
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              session: undefined,
              status: "starting",
              statusText: "启动中"
            }
          : tab
      )
    );

    try {
      const session = await apiClient.startTerminal(targetProject);
      const runtime = runtimeByTabRef.current.get(tabId);
      if (!runtime || runtime.launchId !== launchId) {
        await apiClient.disposeTerminal(session.sessionId);
        return;
      }

      runtime.sessionId = session.sessionId;
      runtime.trustedPromptMarkers = session.trustedPromptMarkers;
      runtime.captureState = createTerminalCaptureState();
      tabBySessionRef.current.set(session.sessionId, tabId);
      setTabs((current) =>
        renumberTerminalTabs(
          current.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  session,
                  status: "running",
                  statusText: session.shell
                }
              : tab
          )
        )
      );
      fitAndResizeTab(tabId, { immediateBackendResize: true });
      if (activeTabIdRef.current === tabId && visible) {
        runtime.terminal.focus();
      }
    } catch (error) {
      const runtime = runtimeByTabRef.current.get(tabId);
      if (!runtime || runtime.launchId !== launchId) {
        setTerminalError(terminalErrorMessage("终端会话清理失败", error));
        return;
      }
      runtime.terminal.writeln(`启动控制台失败：${error instanceof Error ? error.message : "未知错误"}`);
      setTabs((current) =>
        renumberTerminalTabs(
          current.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  status: "error",
                  statusText: "启动失败"
                }
              : tab
          )
        )
      );
    }
  }

  function attachTerminalHost(tabId: string, node: HTMLDivElement | null) {
    if (!node) {
      return;
    }

    const runtime = runtimeByTabRef.current.get(tabId);
    if (!runtime || runtime.host === node) {
      return;
    }

    runtime.host = node;
    if (!runtime.opened) {
      runtime.terminal.open(node);
      runtime.opened = true;
    }

    runtime.resizeObserver?.disconnect();
    runtime.resizeObserver = new ResizeObserver(() => fitAndResizeTab(tabId));
    runtime.resizeObserver.observe(node);
    fitAndResizeTab(tabId);
  }

  function fitAndResizeTab(tabId: string, options: { immediateBackendResize?: boolean } = {}) {
    const runtime = runtimeByTabRef.current.get(tabId);
    if (!runtime?.host || !isVisible(runtime.host)) {
      return;
    }

    window.cancelAnimationFrame(runtime.resizeFrame);
    runtime.resizeFrame = window.requestAnimationFrame(() => {
      if (!runtime.host || !isVisible(runtime.host)) {
        return;
      }

      try {
        runtime.fitAddon.fit();
        scheduleBackendResize(tabId, Boolean(options.immediateBackendResize));
      } catch {
        // Hidden terminals can report zero dimensions during layout transitions.
      }
    });
  }

  function scheduleBackendResize(tabId: string, immediate: boolean) {
    const runtime = runtimeByTabRef.current.get(tabId);
    if (!runtime?.sessionId) {
      return;
    }

    const cols = runtime.terminal.cols;
    const rows = runtime.terminal.rows;
    if (runtime.lastResizeCols === cols && runtime.lastResizeRows === rows) {
      return;
    }

    window.clearTimeout(runtime.resizeTimer);

    const commitResize = () => {
      const latestRuntime = runtimeByTabRef.current.get(tabId);
      if (!latestRuntime?.sessionId) {
        return;
      }

      const nextCols = latestRuntime.terminal.cols;
      const nextRows = latestRuntime.terminal.rows;
      if (latestRuntime.lastResizeCols === nextCols && latestRuntime.lastResizeRows === nextRows) {
        return;
      }

      latestRuntime.lastResizeCols = nextCols;
      latestRuntime.lastResizeRows = nextRows;
      void apiClient.resizeTerminal(latestRuntime.sessionId, nextCols, nextRows)
        .then((resized) => {
          if (!resized) setTerminalError("终端尺寸同步失败，当前会话可能已经结束。");
        })
        .catch((error) => setTerminalError(terminalErrorMessage("终端尺寸同步失败", error)));
    };

    if (immediate) {
      commitResize();
      return;
    }

    runtime.resizeTimer = window.setTimeout(commitResize, TERMINAL_RESIZE_DEBOUNCE_MS);
  }

  function handleSelectTab(tab: TerminalTab) {
    setActiveTabId(tab.id);
    activeByProjectRef.current.set(tab.projectId, tab.id);
  }

  function beginRenameTerminal(tab: TerminalTab) {
    handleSelectTab(tab);
    setRenameDraft(tab.title);
    setRenamingTabId(tab.id);
  }

  function finishRenameTerminal(tabId: string, value: string) {
    const title = value.trim();
    if (title) {
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                title,
                customTitle: true
              }
            : tab
        )
      );
    }
    setRenamingTabId(null);
    setRenameDraft("");
    window.requestAnimationFrame(() => runtimeByTabRef.current.get(tabId)?.terminal.focus());
  }

  function cancelRenameTerminal(tabId: string) {
    setRenamingTabId(null);
    setRenameDraft("");
    window.requestAnimationFrame(() => runtimeByTabRef.current.get(tabId)?.terminal.focus());
  }

  async function restartTerminal(tabId = activeTab?.id) {
    if (!tabId) {
      return;
    }

    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    const runtime = runtimeByTabRef.current.get(tabId);
    if (!tab || !runtime || tab.status === "starting" || runtime.restarting) {
      return;
    }

    runtime.restarting = true;
    const previousSessionId = runtime.sessionId;
    runtime.sessionId = undefined;
    runtime.captureState = createTerminalCaptureState();
    runtime.lastResizeCols = undefined;
    runtime.lastResizeRows = undefined;
    try {
      if (previousSessionId) {
        tabBySessionRef.current.delete(previousSessionId);
        await apiClient.disposeTerminal(previousSessionId);
      }

      runtime.terminal.writeln("");
      runtime.terminal.writeln("[正在重启终端...]");
      await launchTerminalSession(tabId, tab.project);
    } catch (error) {
      setTerminalError(terminalErrorMessage("终端重启失败", error));
    } finally {
      const latestRuntime = runtimeByTabRef.current.get(tabId);
      if (latestRuntime) {
        latestRuntime.restarting = false;
      }
    }
  }

  async function recordTerminalCommand(tabId: string, command: string) {
    if (!command.trim()) {
      return;
    }
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    try {
      const entries = await apiClient.appendTerminalHistory(tab.projectId, command);
      setHistoryByProject((current) => ({ ...current, [tab.projectId]: entries }));
    } catch (error) {
      setTerminalError(terminalErrorMessage("命令历史保存失败", error));
    }
  }

  async function runHistoryCommand(entry: TerminalHistoryEntry) {
    if (!activeTab) {
      return;
    }

    const runtime = runtimeByTabRef.current.get(activeTab.id);
    if (!runtime?.sessionId) {
      setTerminalError("历史命令无法执行：当前终端会话已经结束。");
      return;
    }
    if (!canReplayTerminalHistory(runtime.captureState)) {
      setTerminalError("历史命令无法执行：尚未识别到可信的 Shell 提示符，请等待当前命令结束后重试。");
      return;
    }

    runtime.captureState = { ...runtime.captureState, buffer: "", reliable: true, commandBoundaryConfirmed: false };
    try {
      const written = await apiClient.writeTerminal(runtime.sessionId, `${entry.command}\r`);
      if (!written) {
        setTerminalError("历史命令写入失败，当前会话可能已经结束。");
        return;
      }
    } catch (error) {
      setTerminalError(terminalErrorMessage("历史命令写入失败", error));
      return;
    }
    await recordTerminalCommand(activeTab.id, entry.command);
    setHistoryOpen(false);
    runtime.terminal.focus();
  }

  function handleCloseTab(tabId: string) {
    const closingTab = tabsRef.current.find((tab) => tab.id === tabId);
    if (!closingTab) {
      return;
    }

    const remainingProjectTabs = tabsRef.current.filter((tab) => tab.projectId === closingTab.projectId && tab.id !== tabId);
    const closingIndex = tabsRef.current.findIndex((tab) => tab.id === tabId);
    const nextActiveTab =
      remainingProjectTabs.find((tab) => tabsRef.current.indexOf(tab) > closingIndex) ??
      remainingProjectTabs[remainingProjectTabs.length - 1] ??
      null;

    disposeTerminalRuntime(tabId);
    setTabs((current) => renumberTerminalTabs(current.filter((tab) => tab.id !== tabId)));
    if (renamingTabId === tabId) {
      setRenamingTabId(null);
      setRenameDraft("");
    }

    if (nextActiveTab) {
      activeByProjectRef.current.set(closingTab.projectId, nextActiveTab.id);
    } else {
      activeByProjectRef.current.delete(closingTab.projectId);
    }

    if (activeTabIdRef.current === tabId) {
      setActiveTabId(nextActiveTab?.id ?? null);
    }
  }

  function clearActiveTerminal() {
    if (!activeTab) {
      return;
    }

    const runtime = runtimeByTabRef.current.get(activeTab.id);
    runtime?.terminal.clear();
    runtime?.terminal.focus();
  }

  async function clearActiveHistory() {
    if (!activeTab || activeHistory.length === 0) return;
    const confirmed = await onConfirmClearHistory(activeHistory.length);
    if (!confirmed) return;
    try {
      const cleared = await apiClient.clearTerminalHistory(activeTab.projectId);
      if (!cleared) {
        setTerminalError("命令历史清空失败：本机存储中未找到该项目的历史记录。");
        return;
      }
      setHistoryByProject((current) => ({ ...current, [activeTab.projectId]: [] }));
      setHistoryQuery("");
    } catch (error) {
      setTerminalError(terminalErrorMessage("命令历史清空失败", error));
    }
  }

  function handleTerminalKeyEvent(tabId: string, event: KeyboardEvent): boolean {
    if (event.type !== "keydown") {
      return true;
    }

    const runtime = runtimeByTabRef.current.get(tabId);
    if (!runtime) {
      return true;
    }

    const key = event.key.toLowerCase();
    const copyShortcut =
      (event.metaKey && key === "c") ||
      (event.ctrlKey && event.shiftKey && key === "c") ||
      (event.ctrlKey && !event.shiftKey && event.key === "Insert") ||
      (event.ctrlKey && !event.shiftKey && key === "c" && runtime.terminal.hasSelection());
    const pasteShortcut =
      (event.metaKey && key === "v") ||
      (event.ctrlKey && event.shiftKey && key === "v") ||
      (!event.ctrlKey && !event.metaKey && event.shiftKey && event.key === "Insert");

    if (copyShortcut) {
      event.preventDefault();
      event.stopPropagation();
      if (runtime.terminal.hasSelection()) {
        void copyTerminalSelection(tabId);
      }
      return false;
    }

    if (pasteShortcut) {
      event.preventDefault();
      event.stopPropagation();
      void pasteIntoTerminal(tabId);
      return false;
    }

    return true;
  }

  async function copyTerminalSelection(tabId = activeTab?.id) {
    if (!tabId) {
      return;
    }

    const runtime = runtimeByTabRef.current.get(tabId);
    const selection = runtime?.terminal.getSelection() ?? "";
    if (!runtime || !selection) {
      return;
    }

    runtime.terminal.focus();
    if (window.gitUI) {
      await window.gitUI.runAppCommand("edit:copy");
    } else {
      await navigator.clipboard.writeText(selection);
    }
    runtime.terminal.focus();
  }

  async function pasteIntoTerminal(tabId = activeTab?.id) {
    if (!tabId) {
      return;
    }

    const runtime = runtimeByTabRef.current.get(tabId);
    if (!runtime?.sessionId) {
      return;
    }

    runtime.terminal.focus();
    if (window.gitUI) {
      await window.gitUI.runAppCommand("edit:paste");
    } else {
      const text = await navigator.clipboard.readText();
      if (text) {
        runtime.terminal.paste(text);
      }
    }
    runtime.terminal.focus();
  }

  async function handleCloseAllTabs() {
    const closingTabs = tabsRef.current;
    if (closingTabs.length === 0) {
      return;
    }

    const confirmed = await onConfirmCloseTabs(closingTabs.length);
    if (!confirmed) {
      return;
    }

    for (const tab of closingTabs) {
      const tabId = tab.id;
      disposeTerminalRuntime(tabId);
    }

    activeByProjectRef.current.clear();
    setTabs([]);
    setActiveTabId(null);
    setHistoryOpen(false);
    setRenamingTabId(null);
    setRenameDraft("");
  }

  function disposeTerminalRuntime(tabId: string) {
    const runtime = runtimeByTabRef.current.get(tabId);
    if (!runtime) {
      return;
    }

    window.cancelAnimationFrame(runtime.resizeFrame);
    window.clearTimeout(runtime.resizeTimer);
    runtime.resizeObserver?.disconnect();
    runtime.inputSubscription.dispose();
    runtime.selectionSubscription.dispose();
    if (runtime.sessionId) {
      tabBySessionRef.current.delete(runtime.sessionId);
      void apiClient.disposeTerminal(runtime.sessionId)
        .then((disposed) => {
          if (!disposed) setTerminalError("终端会话关闭失败：会话已经不存在。");
        })
        .catch((error) => setTerminalError(terminalErrorMessage("终端会话关闭失败", error)));
    }

    runtime.terminal.dispose();
    runtimeByTabRef.current.delete(tabId);
  }

  function handleConsoleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, tab: TerminalTab) {
    const currentIndex = projectTabs.findIndex((item) => item.id === tab.id);
    if (currentIndex < 0) {
      return;
    }

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % projectTabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + projectTabs.length) % projectTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = projectTabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = projectTabs[nextIndex];
    handleSelectTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(consoleTabId(nextTab.id))?.focus());
  }

  return (
    <section className={`console-panel ${visible ? "" : "hidden"}`} aria-label="控制台" ref={panelRef}>
      <div className="console-title">
        <TerminalIcon size={15} />
        <span className="console-title-label">控制台</span>
        <div className="console-tab-strip" role="tablist" aria-label="终端标签">
          {projectTabs.map((tab) => (
            <div className={`console-tab ${tab.id === activeTab?.id ? "active" : ""}`} role="presentation" key={tab.id}>
              {renamingTabId === tab.id ? (
                <input
                  className="console-tab-rename"
                  aria-label="终端标签名称"
                  value={renameDraft}
                  maxLength={40}
                  autoFocus
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={(event) => finishRenameTerminal(tab.id, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      finishRenameTerminal(tab.id, event.currentTarget.value);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRenameTerminal(tab.id);
                    }
                  }}
                />
              ) : (
                <PathTooltip content={`${tab.projectPath} · ${tab.statusText}`} className="console-tab-tooltip">
                  <button
                    type="button"
                    className="console-tab-main"
                    id={consoleTabId(tab.id)}
                    role="tab"
                    tabIndex={tab.id === activeTab?.id ? 0 : -1}
                    aria-selected={tab.id === activeTab?.id}
                    aria-controls={consoleTabPanelId(tab.id)}
                    aria-label={`${tab.title}：${tab.projectPath}`}
                    onClick={() => handleSelectTab(tab)}
                    onDoubleClick={() => beginRenameTerminal(tab)}
                    onKeyDown={(event) => handleConsoleTabKeyDown(event, tab)}
                  >
                    <span>{tab.title}</span>
                  </button>
                </PathTooltip>
              )}
              <PathTooltip content="关闭终端" className="console-icon-tooltip">
                <button type="button" className="console-tab-close" aria-label="关闭终端" onClick={() => handleCloseTab(tab.id)}>
                  <X size={12} />
                </button>
              </PathTooltip>
            </div>
          ))}
          <PathTooltip content="新建终端" className="console-icon-tooltip">
            <button type="button" className="console-tab-add" aria-label="新建终端" onClick={() => createTerminalTab(project)} disabled={!project || project.remote?.connectionEnabled === false}>
              <Plus size={14} />
            </button>
          </PathTooltip>
        </div>
        <div className="console-title-actions" aria-label="终端操作">
          <PathTooltip content={maximized ? "恢复控制台高度" : "控制台拉伸到顶部"} className="console-icon-tooltip">
            <button
              type="button"
              className="icon-button console-close"
              aria-label={maximized ? "恢复控制台高度" : "控制台拉伸到顶部"}
              onClick={onToggleMaximized}
              disabled={!visible}
            >
              {maximized ? <ChevronsDown size={14} /> : <ChevronsUp size={14} />}
            </button>
          </PathTooltip>
          <PathTooltip content="重命名当前终端" className="console-icon-tooltip">
            <button
              type="button"
              className="icon-button console-close"
              aria-label="重命名当前终端"
              onClick={() => activeTab && beginRenameTerminal(activeTab)}
              disabled={!activeTab}
            >
              <PencilLine size={14} />
            </button>
          </PathTooltip>
          <PathTooltip content="重启当前终端" className="console-icon-tooltip">
            <button
              type="button"
              className="icon-button console-close"
              aria-label="重启当前终端"
              onClick={() => void restartTerminal()}
              disabled={!activeTab || activeTab.status === "starting"}
            >
              <RefreshCw size={14} />
            </button>
          </PathTooltip>
          <PathTooltip content="命令历史" className="console-icon-tooltip">
            <button
              type="button"
              className={`icon-button console-close ${historyOpen ? "active" : ""}`}
              aria-label="命令历史"
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen((current) => !current)}
              disabled={!activeTab}
            >
              <History size={14} />
            </button>
          </PathTooltip>
          <PathTooltip content="复制所选内容 (Ctrl+Shift+C / Ctrl+C)" className="console-icon-tooltip">
            <button
              type="button"
              className="icon-button console-close"
              aria-label="复制所选内容"
              onClick={() => void copyTerminalSelection()}
              disabled={!activeTab || !activeHasSelection}
            >
              <Copy size={14} />
            </button>
          </PathTooltip>
          <PathTooltip content="粘贴 (Ctrl+Shift+V / Shift+Insert)" className="console-icon-tooltip">
            <button
              type="button"
              className="icon-button console-close"
              aria-label="粘贴到终端"
              onClick={() => void pasteIntoTerminal()}
              disabled={!activeTab?.session}
            >
              <ClipboardPaste size={14} />
            </button>
          </PathTooltip>
          <PathTooltip content="清空当前终端" className="console-icon-tooltip">
            <button type="button" className="icon-button console-close" aria-label="清空当前终端" onClick={clearActiveTerminal} disabled={!activeTab}>
              <Trash2 size={14} />
            </button>
          </PathTooltip>
          <PathTooltip content="关闭全部终端" className="console-icon-tooltip">
            <button
              type="button"
              className="icon-button console-close danger-icon"
              aria-label="关闭全部终端"
              onClick={() => void handleCloseAllTabs()}
              disabled={tabs.length === 0}
            >
              <ListX size={14} />
            </button>
          </PathTooltip>
          <PathTooltip content="隐藏控制台" className="console-icon-tooltip">
            <button type="button" className="icon-button console-close" aria-label="隐藏控制台" onClick={onHide}>
              <X size={15} />
            </button>
          </PathTooltip>
        </div>
      </div>
      {terminalError ? <div className="console-operation-error" role="alert"><span>{terminalError}</span><button type="button" aria-label="关闭终端错误" onClick={() => setTerminalError("")}><X size={13} /></button></div> : null}
      <div className="console-terminal-stack">
        {tabs.map((tab) => (
          <div
            className={`console-terminal ${visible && tab.id === activeTab?.id ? "active" : ""}`}
            key={tab.id}
            id={consoleTabPanelId(tab.id)}
            role="tabpanel"
            aria-labelledby={consoleTabId(tab.id)}
            hidden={!visible || tab.id !== activeTab?.id}
            ref={(node) => attachTerminalHost(tab.id, node)}
          />
        ))}
        {visible && project && projectTabs.length === 0 ? (
          <div className="console-empty-state">
            <p>{project.remote?.connectionEnabled === false ? "远程连接已暂停。" : "当前项目没有打开的终端。"}</p>
            {project.remote?.connectionEnabled !== false ? (
              <button type="button" className="text-button" onClick={() => createTerminalTab(project)}>
                新建终端
              </button>
            ) : null}
          </div>
        ) : null}
        {visible && !project ? <div className="console-empty-state">选择一个项目后使用控制台。</div> : null}
        {historyOpen && activeTab ? (
          <aside className="console-history-panel" aria-label="命令历史">
            <header className="console-history-header">
              <div>
                <strong>命令历史</strong>
                <span>{activeHistory.length}</span>
              </div>
              <div>
                <PathTooltip content="清空命令历史" className="console-icon-tooltip">
                  <button
                    type="button"
                    className="icon-button console-history-close"
                    aria-label="清空命令历史"
                    disabled={activeHistory.length === 0}
                    onClick={() => void clearActiveHistory()}
                  >
                    <Trash2 size={14} />
                  </button>
                </PathTooltip>
                <button
                  type="button"
                  className="icon-button console-history-close"
                  aria-label="关闭命令历史"
                  onClick={() => {
                    setHistoryOpen(false);
                    runtimeByTabRef.current.get(activeTab.id)?.terminal.focus();
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            </header>
            <label className="console-history-search">
              <Search size={14} />
              <input
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder="搜索命令"
                aria-label="搜索命令历史"
                autoFocus
              />
            </label>
            <div className="console-history-list">
              {filteredHistory.map((entry) => (
                <button type="button" className="console-history-entry" key={entry.id} onClick={() => void runHistoryCommand(entry)}>
                  <span className="console-history-command">{entry.command}</span>
                  <span className="console-history-meta">
                    <time dateTime={entry.executedAt}>{formatTerminalHistoryTime(entry.executedAt)}</time>
                    <Play size={13} />
                  </span>
                </button>
              ))}
              {filteredHistory.length === 0 ? (
                <div className="console-history-empty">{activeHistory.length === 0 ? "暂无命令" : "没有匹配的命令"}</div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function createTerminal(host: HTMLElement, theme: ThemeName): Terminal {
  return new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: true,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: 1.25,
    minimumContrastRatio: terminalContrastRatio(theme),
    scrollback: 2500,
    theme: terminalTheme(host, theme)
  });
}

function terminalTheme(host: HTMLElement, theme: ThemeName) {
  const style = getComputedStyle(host);
  const isDark = theme === "dark";
  return {
    background: cssVar(style, "--sunken", isDark ? "#0d1116" : "#f8fafc"),
    foreground: cssVar(style, "--text", isDark ? "#e7edf2" : "#1b2530"),
    cursor: cssVar(style, "--accent", isDark ? "#51c2a9" : "#148f7a"),
    cursorAccent: cssVar(style, "--sunken", isDark ? "#0d1116" : "#f8fafc"),
    selectionBackground: isDark ? "rgba(143, 183, 255, 0.30)" : "rgba(36, 95, 189, 0.20)",
    selectionForeground: cssVar(style, "--text-strong", isDark ? "#f3f7fa" : "#0f1720"),
    selectionInactiveBackground: isDark ? "rgba(143, 183, 255, 0.16)" : "rgba(36, 95, 189, 0.12)",
    black: isDark ? "#15191f" : "#eef2f6",
    red: isDark ? "#ef6b73" : "#b42335",
    green: isDark ? "#7bd88f" : "#137333",
    yellow: isDark ? "#f0c36b" : "#8a5a00",
    blue: isDark ? "#8fb7ff" : "#1557b0",
    magenta: isDark ? "#c084fc" : "#6d28d9",
    cyan: isDark ? "#51c2a9" : "#08756f",
    white: isDark ? "#dfe7ef" : "#ffffff",
    brightBlack: isDark ? "#6b7582" : "#6b7280",
    brightRed: isDark ? "#ff8a94" : "#d12f45",
    brightGreen: isDark ? "#9af2ad" : "#18884a",
    brightYellow: isDark ? "#ffd27a" : "#a16207",
    brightBlue: isDark ? "#adc9ff" : "#2563eb",
    brightMagenta: isDark ? "#d8b4fe" : "#8b5cf6",
    brightCyan: isDark ? "#78decb" : "#0f8f86",
    brightWhite: isDark ? "#f8fafc" : "#111827"
  };
}

function terminalContrastRatio(theme: ThemeName): number {
  return theme === "light" ? 7 : 4.5;
}

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 && element.clientWidth > 0 && element.clientHeight > 0;
}

function formatTerminalHistoryTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function terminalErrorMessage(label: string, error: unknown): string {
  return `${label}：${error instanceof Error ? error.message : String(error)}`;
}

function consoleTabId(tabId: string): string {
  return `console-tab-${tabId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function consoleTabPanelId(tabId: string): string {
  return `console-tab-panel-${tabId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function renumberTerminalTabs(tabs: TerminalTab[]): TerminalTab[] {
  const projectCounts = new Map<string, number>();
  return tabs.map((tab) => {
    const nextNumber = (projectCounts.get(tab.projectId) ?? 0) + 1;
    projectCounts.set(tab.projectId, nextNumber);
    if (tab.customTitle) {
      return tab;
    }
    const nextTitle = `终端 ${nextNumber}`;
    return tab.title === nextTitle ? tab : { ...tab, title: nextTitle };
  });
}
