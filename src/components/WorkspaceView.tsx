import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, FileX2, GitMerge, GitPullRequest, Plus, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { PathTooltip } from "./PathTooltip";
import type { ChangedFile, CommitInput, GitProject, GitResetMode, WorktreeState } from "../types/domain";
import { fileIconInfo } from "../utils/fileIcon";
import { absoluteFilePath } from "../utils/filePath";

interface WorkspaceViewProps {
  project?: GitProject;
  worktree: WorktreeState;
  onStageFile: (file: ChangedFile) => void;
  onStageAll: () => void;
  onUnstageFile: (file: ChangedFile) => void;
  onUnstageAll: () => void;
  onDiscardFile: (file: ChangedFile) => void;
  onDiscardAll: () => void;
  onIgnoreFile: (file: ChangedFile) => void | Promise<void>;
  onRefreshWorktree: () => void;
  onSelectFile: (file: ChangedFile) => void;
  onPinFile: (file: ChangedFile) => void;
  selectedFilePath?: string;
  selectedFileStaged?: boolean;
  onCommit: (input: CommitInput) => Promise<boolean>;
  onAmendLastMessage: () => void;
  onUndoLastCommit: (mode: Exclude<GitResetMode, "hard">) => void;
  onSyncChanges: () => Promise<void>;
  onMergeRemote: () => Promise<void>;
  hasCommits: boolean;
  focusRequest: number;
  messageDraftRequest?: CommitMessageDraftRequest;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

interface CommitMessageDraftRequest {
  id: number;
  projectId: string;
  value: string;
}

interface ScmFileContextMenuState {
  file: ChangedFile;
  x: number;
  y: number;
}

const COMMIT_MESSAGE_MIN_HEIGHT = 34;
const COMMIT_MESSAGE_MAX_HEIGHT = 260;
const COMMIT_ACTION_REVEAL_GAP = 8;
const SCM_FILE_CONTEXT_MENU_VIEWPORT_GAP = 8;

export function WorkspaceView({
  project,
  worktree,
  onStageFile,
  onStageAll,
  onUnstageFile,
  onUnstageAll,
  onDiscardFile,
  onDiscardAll,
  onIgnoreFile,
  onRefreshWorktree,
  onSelectFile,
  onPinFile,
  selectedFilePath,
  selectedFileStaged,
  onCommit,
  onAmendLastMessage,
  onUndoLastCommit,
  onSyncChanges,
  onMergeRemote,
  hasCommits,
  focusRequest,
  messageDraftRequest,
  panelOpen,
  onTogglePanel
}: WorkspaceViewProps) {
  const panelBodyId = useId();
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [commitMenuPosition, setCommitMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [changesOpen, setChangesOpen] = useState(true);
  const [conflictsOpen, setConflictsOpen] = useState(true);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [fileContextMenu, setFileContextMenu] = useState<ScmFileContextMenuState | null>(null);
  const commitActionsRef = useRef<HTMLDivElement>(null);
  const commitMenuButtonRef = useRef<HTMLButtonElement>(null);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const fileContextMenuRef = useRef<HTMLDivElement>(null);
  const fileContextMenuOpenerRef = useRef<HTMLElement | null>(null);
  const handledMessageDraftRequestIdRef = useRef<number>();
  const projectId = project?.id;
  const message = projectId ? messageDrafts[projectId] ?? "" : "";
  const updateMessageDraft = useCallback((value: string) => {
    if (!projectId) {
      return;
    }

    setMessageDrafts((current) => {
      if (value) {
        return current[projectId] === value ? current : { ...current, [projectId]: value };
      }

      if (!Object.prototype.hasOwnProperty.call(current, projectId)) {
        return current;
      }

      const next = { ...current };
      delete next[projectId];
      return next;
    });
  }, [projectId]);
  const stagedCount = worktree.stagedFiles.length;
  const unstagedCount = worktree.unstagedFiles.length;
  const changeCount = unstagedCount + stagedCount;
  const conflictFiles = worktree.unstagedFiles.filter((file) => file.status === "conflicted");
  const regularUnstagedFiles = worktree.unstagedFiles.filter((file) => file.status !== "conflicted");
  const hasConflicts = Boolean(project?.status?.hasConflicts) || conflictFiles.length > 0;
  const willAutoStage = !hasConflicts && stagedCount === 0 && unstagedCount > 0;
  const outgoingCount = project?.status?.ahead ?? 0;
  const incomingCount = project?.status?.behind ?? 0;
  const canMergeRemote = changeCount === 0 && outgoingCount > 0 && incomingCount > 0;
  const canSyncOutgoing = changeCount === 0 && outgoingCount > 0 && incomingCount === 0;
  const commitDisabled = hasConflicts || (changeCount === 0 && !canSyncOutgoing && !canMergeRemote);
  const commitTitle = hasConflicts
    ? "请先解决所有冲突文件"
    : canMergeRemote
      ? `将 ${project?.status?.upstream ?? "远程分支"} 的 ${incomingCount} 个新提交合并到当前分支，本地提交不会被改写。`
    : canSyncOutgoing
    ? `同步 ${outgoingCount} 个本地提交到远程。`
    : willAutoStage
      ? `${unstagedCount} 个文件未暂存，提交时会自动暂存并提交。`
      : "提交已暂存的更改";
  const primaryActionLabel = canMergeRemote ? `合并远程更改 ${incomingCount} 个` : canSyncOutgoing ? `同步更改 ${outgoingCount} 个` : "提交";

  useEffect(() => {
    if (focusRequest > 0) {
      messageInputRef.current?.focus();
    }
  }, [focusRequest]);

  useEffect(() => {
    if (!messageDraftRequest || handledMessageDraftRequestIdRef.current === messageDraftRequest.id) {
      return;
    }

    handledMessageDraftRequestIdRef.current = messageDraftRequest.id;
    if (messageDraftRequest.projectId !== projectId) {
      return;
    }

    updateMessageDraft(messageDraftRequest.value);
    const frameId = window.requestAnimationFrame(() => {
      messageInputRef.current?.focus();
      messageInputRef.current?.setSelectionRange(messageDraftRequest.value.length, messageDraftRequest.value.length);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [messageDraftRequest, projectId, updateMessageDraft]);

  useLayoutEffect(() => {
    const input = messageInputRef.current;
    if (!input) {
      return;
    }

    input.style.height = `${COMMIT_MESSAGE_MIN_HEIGHT}px`;
    const nextHeight = Math.min(COMMIT_MESSAGE_MAX_HEIGHT, Math.max(COMMIT_MESSAGE_MIN_HEIGHT, input.scrollHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > COMMIT_MESSAGE_MAX_HEIGHT ? "auto" : "hidden";

    if (document.activeElement !== input) {
      return;
    }

    const scrollContainer = input.closest<HTMLElement>(".scm-panel-body");
    const commitActions = commitActionsRef.current;
    if (!scrollContainer || !commitActions) {
      return;
    }

    const containerBottom = scrollContainer.getBoundingClientRect().bottom;
    const actionsBottom = commitActions.getBoundingClientRect().bottom;
    const hiddenDistance = actionsBottom + COMMIT_ACTION_REVEAL_GAP - containerBottom;
    if (hiddenDistance > 0) {
      scrollContainer.scrollTop += hiddenDistance;
    }
  }, [message, panelOpen]);

  useEffect(() => {
    if (!commitMenuOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      commitMenuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not(:disabled)")?.focus();
    });

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!commitActionsRef.current?.contains(target) && !commitMenuRef.current?.contains(target)) {
        setCommitMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCommitMenuOpen(false);
        window.requestAnimationFrame(() => commitMenuButtonRef.current?.focus());
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [commitMenuOpen]);

  useEffect(() => {
    setFileContextMenu(null);
  }, [projectId]);

  useEffect(() => {
    if (!fileContextMenu) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const firstItem = fileContextMenuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not(:disabled)");
      (firstItem ?? fileContextMenuRef.current)?.focus();
    });
    const closeOnPointerDown = () => closeFileContextMenu();
    const closeOnWindowChange = () => closeFileContextMenu();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeFileContextMenu(true);
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnWindowChange);
    window.addEventListener("resize", closeOnWindowChange);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnWindowChange);
      window.removeEventListener("resize", closeOnWindowChange);
    };
  }, [fileContextMenu]);

  useLayoutEffect(() => {
    const menu = fileContextMenuRef.current;
    if (!fileContextMenu || !menu) {
      return;
    }

    const rect = menu.getBoundingClientRect();
    const nextX = Math.max(
      SCM_FILE_CONTEXT_MENU_VIEWPORT_GAP,
      Math.min(fileContextMenu.x, window.innerWidth - rect.width - SCM_FILE_CONTEXT_MENU_VIEWPORT_GAP)
    );
    const nextY = Math.max(
      SCM_FILE_CONTEXT_MENU_VIEWPORT_GAP,
      Math.min(fileContextMenu.y, window.innerHeight - rect.height - SCM_FILE_CONTEXT_MENU_VIEWPORT_GAP)
    );
    if (Math.abs(nextX - fileContextMenu.x) > 0.5 || Math.abs(nextY - fileContextMenu.y) > 0.5) {
      setFileContextMenu((current) => current ? { ...current, x: nextX, y: nextY } : current);
    }
  }, [fileContextMenu]);

  function toggleCommitMenu() {
    const rect = commitMenuButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setCommitMenuPosition({
        top: rect.bottom + 4,
        left: rect.left - 1
      });
    }
    setCommitMenuOpen((value) => !value);
  }

  function handleCommitMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setCommitMenuOpen(false);
      window.requestAnimationFrame(() => commitMenuButtonRef.current?.focus());
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

  function closeFileContextMenu(restoreFocus = false) {
    setFileContextMenu(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => fileContextMenuOpenerRef.current?.focus());
    }
  }

  function openFileContextMenu(file: ChangedFile, x: number, y: number, opener: HTMLElement) {
    fileContextMenuOpenerRef.current = opener;
    setFileContextMenu({ file, x, y });
  }

  function handleFileContextMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFileContextMenu(true);
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

  async function submitCommit(options: Partial<CommitInput> & { syncAfterCommit?: boolean } = {}) {
    if (commitBusy) {
      return;
    }

    const { syncAfterCommit, ...commitOptions } = options;

    if (canMergeRemote && !commitOptions.amend && !commitOptions.pushAfterCommit && !syncAfterCommit) {
      setCommitBusy(true);
      try {
        await onMergeRemote();
        setCommitMenuOpen(false);
      } finally {
        setCommitBusy(false);
      }
      return;
    }

    if (canSyncOutgoing && !commitOptions.amend && !commitOptions.pushAfterCommit && !syncAfterCommit) {
      setCommitBusy(true);
      try {
        await onSyncChanges();
        setCommitMenuOpen(false);
      } finally {
        setCommitBusy(false);
      }
      return;
    }

    const commitMessage = splitCommitMessage(message);
    setCommitBusy(true);
    try {
      const committed = await onCommit({
        ...commitMessage,
        ...commitOptions
      });
      if (committed) {
        updateMessageDraft("");
        if (syncAfterCommit) {
          await onSyncChanges();
        }
      }
      setCommitMenuOpen(false);
    } finally {
      setCommitBusy(false);
    }
  }

  return (
    <section className={`scm-view ${panelOpen ? "" : "panel-collapsed"}`}>
      <button type="button" className="scm-panel-toggle" aria-expanded={panelOpen} aria-controls={panelBodyId} onClick={onTogglePanel}>
        {panelOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span>更改</span>
        <span className="scm-count">{changeCount}</span>
      </button>

      {panelOpen ? (
        <div className="scm-panel-body" id={panelBodyId}>
          <form
            className="scm-commit-box"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCommit();
            }}
          >
            <textarea
              ref={messageInputRef}
              value={message}
              onChange={(event) => updateMessageDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.ctrlKey && event.key === "Enter") {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={`消息(Ctrl+Enter) 在"${project?.status?.currentBranch ?? "当前分支"}"提交`}
              rows={1}
            />
            <div className="scm-commit-control" ref={commitActionsRef}>
              <div className={`scm-commit-actions ${canSyncOutgoing || canMergeRemote ? "sync-mode" : ""}`}>
                <PathTooltip content={commitTitle} className="scm-commit-button-tooltip">
                  <button type="submit" className="scm-commit-button" aria-label={commitTitle} disabled={commitDisabled || commitBusy}>
                    {canMergeRemote ? <GitPullRequest size={17} /> : canSyncOutgoing ? <RefreshCw size={17} /> : <Check size={17} />}
                    {primaryActionLabel}
                  </button>
                </PathTooltip>
                {!canSyncOutgoing && !canMergeRemote ? (
                  <PathTooltip content="提交选项" className="scm-commit-menu-tooltip">
                    <button type="button" className="scm-commit-menu" aria-label="提交选项" aria-haspopup="menu" aria-expanded={commitMenuOpen} onClick={toggleCommitMenu} ref={commitMenuButtonRef}>
                      <ChevronDown size={17} />
                    </button>
                  </PathTooltip>
                ) : null}
              </div>
              {!canSyncOutgoing && !canMergeRemote && commitMenuOpen && commitMenuPosition && typeof document !== "undefined"
                ? createPortal(
                    <div className="floating-menu commit-menu commit-menu-portal" role="menu" style={commitMenuPosition} ref={commitMenuRef} onKeyDown={handleCommitMenuKeyDown}>
                      <button type="button" role="menuitem" disabled={commitDisabled || commitBusy} onClick={() => void submitCommit()}>
                        提交
                      </button>
                      <button type="button" role="menuitem" disabled={commitBusy || !hasCommits} onClick={() => void submitCommit({ amend: true })}>
                        提交(修改)
                      </button>
                      <button type="button" role="menuitem" disabled={commitDisabled || commitBusy} onClick={() => void submitCommit({ pushAfterCommit: true })}>
                        提交和推送
                      </button>
                      <button type="button" role="menuitem" disabled={commitDisabled || commitBusy} onClick={() => void submitCommit({ syncAfterCommit: true })}>
                        提交和同步
                      </button>
                      <div className="menu-separator" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        disabled={commitBusy || !hasCommits}
                        onClick={() => {
                          setCommitMenuOpen(false);
                          onAmendLastMessage();
                        }}
                      >
                        修改上次提交信息
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={commitBusy || !hasCommits}
                        onClick={() => {
                          setCommitMenuOpen(false);
                          onUndoLastCommit("soft");
                        }}
                      >
                        撤销上次提交，保留更改
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={commitBusy || !hasCommits}
                        onClick={() => {
                          setCommitMenuOpen(false);
                          onUndoLastCommit("mixed");
                        }}
                      >
                        撤销上次提交，取消暂存
                      </button>
                    </div>,
                    document.querySelector(".app-shell") ?? document.body
                  )
                : null}
            </div>
          </form>

          {worktree.stagedFiles.length > 0 ? (
            <ScmSection
              title="暂存的更改"
              count={worktree.stagedFiles.length}
              emptyText="没有已暂存改动。"
              actions={[
                {
                  title: "取消暂存所有更改",
                  icon: <Undo2 size={16} />,
                  onAction: onUnstageAll
                }
              ]}
              open={stagedOpen}
              onToggle={() => setStagedOpen((value) => !value)}
            >
              {worktree.stagedFiles.map((file) => (
                <ScmFileRow
                  file={file}
                  selected={file.path === selectedFilePath && selectedFileStaged === true}
                  key={`staged-${file.path}-${file.status}`}
                  primaryActionTitle="取消暂存"
                  primaryActionIcon={<Undo2 size={15} />}
                  onPrimaryAction={() => onUnstageFile(file)}
                  onSelect={() => onSelectFile(file)}
                  onPin={() => onPinFile(file)}
                  contextMenuOpen={sameWorktreeFile(fileContextMenu?.file, file)}
                  onOpenContextMenu={(x, y, opener) => openFileContextMenu(file, x, y, opener)}
                  repositoryPath={project?.path}
                />
              ))}
            </ScmSection>
          ) : null}

          {conflictFiles.length > 0 ? (
            <ScmSection
              title="冲突"
              count={conflictFiles.length}
              emptyText="没有冲突文件。"
              actions={[
                {
                  title: "刷新冲突状态",
                  icon: <RefreshCw size={15} />,
                  onAction: onRefreshWorktree
                }
              ]}
              open={conflictsOpen}
              onToggle={() => setConflictsOpen((value) => !value)}
            >
              {conflictFiles.map((file) => (
                <ScmFileRow
                  file={file}
                  selected={file.path === selectedFilePath && selectedFileStaged === false}
                  key={`conflict-${file.path}`}
                  primaryActionTitle="打开冲突解决器"
                  primaryActionIcon={<GitMerge size={15} />}
                  onPrimaryAction={() => onSelectFile(file)}
                  onSelect={() => onSelectFile(file)}
                  onPin={() => onPinFile(file)}
                  contextMenuOpen={sameWorktreeFile(fileContextMenu?.file, file)}
                  onOpenContextMenu={(x, y, opener) => openFileContextMenu(file, x, y, opener)}
                  repositoryPath={project?.path}
                />
              ))}
            </ScmSection>
          ) : null}

          {regularUnstagedFiles.length > 0 ? (
            <ScmSection
              title="更改"
              count={regularUnstagedFiles.length}
              emptyText="没有未暂存改动。"
              actions={[
                {
                  title: "取消所有更改",
                  icon: <Trash2 size={15} />,
                  onAction: onDiscardAll,
                  danger: true,
                  disabled: hasConflicts
                },
                {
                  title: "暂存所有更改",
                  icon: <Plus size={16} />,
                  onAction: onStageAll,
                  disabled: hasConflicts
                }
              ]}
              open={changesOpen}
              onToggle={() => setChangesOpen((value) => !value)}
            >
              {regularUnstagedFiles.map((file) => (
                <ScmFileRow
                  file={file}
                  selected={file.path === selectedFilePath && selectedFileStaged === false}
                  key={`unstaged-${file.path}-${file.status}`}
                  primaryActionTitle="暂存更改"
                  primaryActionIcon={<Plus size={15} />}
                  onPrimaryAction={() => onStageFile(file)}
                  onDiscard={() => onDiscardFile(file)}
                  onSelect={() => onSelectFile(file)}
                  onPin={() => onPinFile(file)}
                  contextMenuOpen={sameWorktreeFile(fileContextMenu?.file, file)}
                  onOpenContextMenu={(x, y, opener) => openFileContextMenu(file, x, y, opener)}
                  repositoryPath={project?.path}
                />
              ))}
            </ScmSection>
          ) : null}
        </div>
      ) : <span id={panelBodyId} hidden />}
      {fileContextMenu && typeof document !== "undefined"
        ? createPortal(
            <div
              className="floating-menu scm-file-context-menu"
              role="menu"
              aria-label={`${fileContextMenu.file.path} 文件操作`}
              tabIndex={-1}
              style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
              ref={fileContextMenuRef}
              onPointerDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={handleFileContextMenuKeyDown}
            >
              <div className="scm-file-context-heading" role="presentation">
                <strong>{fileContextMenu.file.path.split(/[\\/]/).filter(Boolean).at(-1) ?? fileContextMenu.file.path}</strong>
                <small>{fileContextMenu.file.path}</small>
              </div>
              <div className="menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={!canAddFileToGitIgnore(fileContextMenu.file)}
                title={canAddFileToGitIgnore(fileContextMenu.file) ? undefined : "只有未跟踪文件可以直接加入忽略规则"}
                onClick={() => {
                  const file = fileContextMenu.file;
                  closeFileContextMenu();
                  void onIgnoreFile(file);
                }}
              >
                <FileX2 size={15} aria-hidden="true" />
                <span>添加到 .gitignore</span>
              </button>
              {!canAddFileToGitIgnore(fileContextMenu.file) ? (
                <small className="scm-file-context-hint">已跟踪文件需先停止跟踪，才能由忽略规则生效。</small>
              ) : null}
            </div>,
            document.querySelector(".app-shell") ?? document.body
          )
        : null}
    </section>
  );
}

function splitCommitMessage(message: string): Pick<CommitInput, "subject" | "body"> {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const subjectIndex = lines.findIndex((line) => line.trim().length > 0);
  if (subjectIndex < 0) {
    return { subject: "" };
  }

  const subject = lines[subjectIndex].trim();
  const body = lines.slice(subjectIndex + 1).join("\n").trim();
  return body ? { subject, body } : { subject };
}

function ScmSection({
  title,
  count,
  emptyText,
  actions,
  open,
  onToggle,
  children
}: {
  title: string;
  count: number;
  emptyText: string;
  actions: Array<{ title: string; icon: React.ReactNode; onAction: () => void; danger?: boolean; disabled?: boolean }>;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const contentId = useId();
  return (
    <section className="scm-section">
      <div className="scm-section-header">
        <button type="button" className="scm-section-toggle" aria-expanded={open} aria-controls={contentId} onClick={onToggle}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span>{title}</span>
          <span className="scm-count">{count}</span>
        </button>
        <div className="scm-section-actions">
          {actions.map((action) => (
            <PathTooltip content={action.title} className="scm-section-action-tooltip" key={action.title}>
              <button
                type="button"
                className={`icon-button compact-icon ${action.danger ? "danger-icon" : ""}`}
                aria-label={action.title}
                onClick={(event) => {
                  event.stopPropagation();
                  action.onAction();
                }}
                disabled={count === 0 || action.disabled}
              >
                {action.icon}
              </button>
            </PathTooltip>
          ))}
        </div>
      </div>
      {open ? count === 0 ? <div className="empty-inline scm-empty" id={contentId}>{emptyText}</div> : <div className="scm-file-list" id={contentId}>{children}</div> : <span id={contentId} hidden />}
    </section>
  );
}

function ScmFileRow({
  file,
  selected,
  primaryActionTitle,
  primaryActionIcon,
  onPrimaryAction,
  onDiscard,
  onSelect,
  onPin,
  contextMenuOpen,
  onOpenContextMenu,
  repositoryPath
}: {
  file: ChangedFile;
  selected: boolean;
  primaryActionTitle: string;
  primaryActionIcon: React.ReactNode;
  onPrimaryAction: () => void;
  onDiscard?: () => void;
  onSelect: () => void;
  onPin: () => void;
  contextMenuOpen: boolean;
  onOpenContextMenu: (x: number, y: number, opener: HTMLElement) => void;
  repositoryPath?: string;
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
    <div
      className={`scm-file-row ${selected ? "active" : ""}`}
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      aria-expanded={contextMenuOpen}
      aria-keyshortcuts="Shift+F10"
      onClick={scheduleSelect}
      onDoubleClick={(event) => {
        event.preventDefault();
        pinImmediately();
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenContextMenu(rect.left + 18, rect.top + 18, event.currentTarget);
          return;
        }

        if (event.ctrlKey && event.key === "Enter") {
          pinImmediately();
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          onSelect();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenContextMenu(event.clientX, event.clientY, event.currentTarget);
      }}
    >
      <span className={`scm-file-icon ${icon.className}`}>{icon.label}</span>
      <span className="scm-file-main">
        <PathTooltip path={fullPath} className="scm-file-name">
          {file.path.split(/[\\/]/).filter(Boolean).at(-1) ?? file.path}
        </PathTooltip>
        <span className="scm-file-dir">{directoryName(file.path)}</span>
      </span>
      <span className="scm-file-trailing">
        <span className="scm-row-actions">
          <PathTooltip content={primaryActionTitle} className="scm-row-action-tooltip">
            <button
              type="button"
              className="icon-button compact-icon"
              aria-label={primaryActionTitle}
              onClick={(event) => {
                event.stopPropagation();
                onPrimaryAction();
              }}
            >
              {primaryActionIcon}
            </button>
          </PathTooltip>
          {onDiscard ? (
            <PathTooltip content="放弃更改" className="scm-row-action-tooltip">
              <button
                type="button"
                className="icon-button compact-icon danger-icon"
                aria-label="放弃更改"
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard();
                }}
              >
                <Undo2 size={15} />
              </button>
            </PathTooltip>
          ) : null}
        </span>
        <span className={`scm-file-status ${file.status}`}>{statusCode(file.status)}</span>
      </span>
    </div>
  );
}

function canAddFileToGitIgnore(file: ChangedFile): boolean {
  return file.status === "untracked" && file.path.replace(/\\/g, "/").replace(/^\.\//, "") !== ".gitignore";
}

function sameWorktreeFile(left: ChangedFile | undefined, right: ChangedFile): boolean {
  return Boolean(left && left.path === right.path && left.staged === right.staged);
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
