import { useCallback, useEffect, useRef, useState } from "react";
import { validateSession } from "../lib/validateSession";
import type { Session } from "../types/session";

import "./LoadSession.css";

interface LoadSessionProps {
  onLoad: (session: Session) => void;
  onError: (message: string) => void;
}

interface LocalSessionSummary {
  key: string;
  session_id: string;
  goal?: string;
  started_at?: string;
  ended_at?: string;
  outcome?: "completed" | "partial" | "failed" | "aborted" | "unknown";
  event_count: number;
  updated_at: string;
}

interface McpImportResponse {
  import_set_id: string;
  sessions?: LocalSessionSummary[];
  rejected_files?: Array<{ name: string; error: string }>;
  guidance?: string;
}

const API_BASE =
  (import.meta.env.VITE_AUDIT_API_BASE as string | undefined)?.trim() ?? "";

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

function getSessionRef(session: LocalSessionSummary): string {
  return (session.session_id || session.key || "").trim();
}

async function readJsonLike(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return { error: `Non-JSON response (${response.status}).` };
  }
}

export function LoadSession({ onLoad, onError }: LoadSessionProps) {
  const mcpInputRef = useRef<HTMLInputElement>(null);
  const rawInputRef = useRef<HTMLInputElement>(null);
  const [isLoadingLocal, setIsLoadingLocal] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localSessions, setLocalSessions] = useState<LocalSessionSummary[]>([]);
  const [importSetId, setImportSetId] = useState<string | null>(null);
  const [importedSessions, setImportedSessions] = useState<
    LocalSessionSummary[]
  >([]);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [rawMergeStatus, setRawMergeStatus] = useState<string | null>(null);
  const [rawTargetSessionId, setRawTargetSessionId] = useState<string>("");
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [pendingMcpFiles, setPendingMcpFiles] = useState<File[]>([]);
  const [selectionExpanded, setSelectionExpanded] = useState(false);

  const openSessionById = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      try {
        const response = await fetch(
          `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: "GET",
          },
        );
        if (!response.ok)
          throw new Error(`Failed to open session (${response.status})`);
        const data = (await response.json()) as unknown;
        const result = validateSession(data);
        if (!result.success) {
          throw new Error(
            result.errors
              .map((e) => `${e.instancePath}: ${e.message ?? e.keyword}`)
              .join("\n"),
          );
        }
        onLoad(result.data);
      } catch (err) {
        onError(
          err instanceof Error
            ? err.message
            : "Failed to open imported session.",
        );
      }
    },
    [onError, onLoad],
  );

  const fetchLocalSessions = useCallback(async () => {
    setIsLoadingLocal(true);
    setLocalError(null);
    try {
      const response = await fetch(`${API_BASE}/api/sessions`, {
        method: "GET",
      });
      if (!response.ok)
        throw new Error(`Session API returned ${response.status}`);
      const data = (await response.json()) as {
        sessions?: LocalSessionSummary[];
      };
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      setLocalSessions(sessions);
    } catch (err) {
      setLocalSessions([]);
      setLocalError(
        err instanceof Error ? err.message : "Failed to load local sessions.",
      );
    } finally {
      setIsLoadingLocal(false);
    }
  }, []);

  useEffect(() => {
    void fetchLocalSessions();
  }, [fetchLocalSessions]);

  const loadLocalSession = useCallback(
    async (sessionKey: string) => {
      try {
        const response = await fetch(
          `${API_BASE}/api/sessions/${encodeURIComponent(sessionKey)}`,
          {
            method: "GET",
          },
        );
        if (!response.ok)
          throw new Error(`Failed to load session (${response.status})`);
        const data = (await response.json()) as unknown;
        const result = validateSession(data);
        if (result.success) {
          onLoad(result.data);
          return;
        }
        onError(
          result.errors
            .map((e) => `${e.instancePath}: ${e.message ?? e.keyword}`)
            .join("\n"),
        );
      } catch (err) {
        onError(
          err instanceof Error ? err.message : "Failed to load local session.",
        );
      }
    },
    [onError, onLoad],
  );

  const handleImportMcpFiles = useCallback(
    async (
      files: FileList | File[] | null,
      options?: { allowLocalLoadFallback?: boolean },
    ): Promise<string | null> => {
      const fileArray = !files
        ? []
        : Array.isArray(files)
          ? files
          : Array.from(files);
      if (fileArray.length === 0) return null;
      const allowLocalLoadFallback = options?.allowLocalLoadFallback ?? true;
      try {
        setImportStatus("Importing canonical MCP logs...");
        const payloadFiles = await Promise.all(
          fileArray.map(async (file) => ({
            name: file.name,
            content: await readFileAsText(file),
          })),
        );
        const response = await fetch(`${API_BASE}/api/import/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ files: payloadFiles }),
        });
        const data = (await readJsonLike(response)) as Partial<McpImportResponse> & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(
            data.error ??
              `MCP import failed (${response.status}). Ensure dashboard API is running and reachable.`,
          );
        if (!data.import_set_id) {
          throw new Error("MCP import response missing `import_set_id`.");
        }
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        setImportSetId(data.import_set_id);
        setImportedSessions(sessions);
        const defaultSessionRef = sessions[0] ? getSessionRef(sessions[0]) : "";
        setRawTargetSessionId(defaultSessionRef);
        const rejected = Array.isArray(data.rejected_files)
          ? data.rejected_files.length
          : 0;
        setImportStatus(
          `Imported ${sessions.length} MCP session(s).${rejected > 0 ? ` Rejected ${rejected} invalid file(s).` : ""}`,
        );
        setPendingMcpFiles([]);
        setSelectionExpanded(false);
        await fetchLocalSessions();
        return defaultSessionRef || null;
      } catch (err) {
        // Fallback: allow direct local canonical load when dashboard API is stale/unavailable.
        try {
          const first = fileArray[0];
          if (!first) throw err;
          if (!allowLocalLoadFallback) throw err;
          const text = await readFileAsText(first);
          const localResult = validateSession(text);
          if (!localResult.success) {
            throw new Error(
              localResult.errors
                .map((e) => `${e.instancePath}: ${e.message ?? e.keyword}`)
                .join("\n"),
            );
          }
          onLoad(localResult.data);
          setImportStatus(
            "Loaded canonical MCP session locally (API import unavailable). Restart dashboard server to persist import sets.",
          );
          setPendingMcpFiles([]);
          setSelectionExpanded(false);
          return localResult.data.id;
        } catch {
          const message =
            err instanceof Error
              ? err.message
              : "Failed to import MCP sessions.";
          setImportStatus(message);
          onError(message);
          return null;
        }
      }
    },
    [fetchLocalSessions, onError, onLoad],
  );

  const addPendingMcpFiles = useCallback((files: File[] | FileList | null) => {
    const list = !files ? [] : Array.isArray(files) ? files : Array.from(files);
    if (list.length === 0) return;
    setPendingMcpFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      const added = list.filter((f) => !names.has(f.name));
      return prev.concat(added);
    });
    setSelectionExpanded(true);
  }, []);

  const removePendingMcpFile = useCallback((index: number) => {
    setPendingMcpFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const importPendingMcpFiles = useCallback(() => {
    if (pendingMcpFiles.length === 0) return;
    void handleImportMcpFiles(pendingMcpFiles, { allowLocalLoadFallback: true });
  }, [pendingMcpFiles, handleImportMcpFiles]);

  const handleMergeRawLog = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (!importSetId || !rawTargetSessionId) {
        onError(
          "Import canonical MCP sessions first, then select a target session for raw merge.",
        );
        return;
      }
      try {
        setRawMergeStatus("Merging raw log...");
        const raw = await readFileAsText(files[0]);
        const response = await fetch(`${API_BASE}/api/import/raw-merge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            import_set_id: importSetId,
            target_session_id: rawTargetSessionId,
            raw,
            adapter: "auto",
            dedupe: true,
          }),
        });
        const data = (await readJsonLike(response)) as {
          error?: string;
          inserted?: number;
          skipped_duplicates?: number;
        };
        if (!response.ok)
          throw new Error(
            data.error ?? `Raw merge failed (${response.status})`,
          );
        setRawMergeStatus(
          `Merged raw log. Inserted ${data.inserted ?? 0} event(s), skipped ${data.skipped_duplicates ?? 0} duplicate(s).`,
        );
        await fetchLocalSessions();
        await openSessionById(rawTargetSessionId);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to merge raw log.";
        setRawMergeStatus(message);
        onError(message);
      }
    },
    [
      fetchLocalSessions,
      importSetId,
      onError,
      openSessionById,
      rawTargetSessionId,
    ],
  );

  const heroSubtitle =
    "Follow the guided steps below to initialize your animation workflow. AgentLens processes your MCP logs into visual timelines.";
  const step1Instruction =
    "Recommended: import only relevant or consecutive sessions from the same conversation/thread.";
  const step2Instruction =
    "Raw merge is available only after MCP import and only merges into an imported target session.";
  const canMergeRaw = Boolean(importSetId && rawTargetSessionId);
  const canSelectRawLogs = canMergeRaw || pendingMcpFiles.length > 0;
  const canLaunchSession = Boolean(rawTargetSessionId || pendingMcpFiles.length > 0);

  return (
    <div className="load-session">
      <div className="load-session__stars" aria-hidden />
      <div
        className="load-session__nebula load-session__nebula--one"
        aria-hidden
      />
      <div
        className="load-session__nebula load-session__nebula--two"
        aria-hidden
      />
      <div className="load-session__workflow-bg-pulse" aria-hidden />

      {/* Header */}
      <header className="load-session__header">
        <div className="load-session__brand">
          <div className="load-session__logo" aria-hidden>
            <span className="load-session__logo-outer" />
            <span className="load-session__logo-inner" />
          </div>
          <span className="load-session__brand-name">AgentLens</span>
        </div>
        <div className="load-session__workflow-status">
          <span className="load-session__workflow-label">
            AGENTLENS FUSION CONSOLE
          </span>
        </div>
      </header>

      {/* Hero */}
      <div className="load-session__hero">
        <h1 className="load-session__hero-title">
          Import{" "}
          <span className="load-session__hero-title-accent">Your Session</span>
        </h1>
        <p className="load-session__hero-subtitle">{heroSubtitle}</p>
      </div>

      {/* Horizontal workflow: import (left) → flow → Open Session (right) */}
      <div className="load-session__workflow">
        <div className="load-session__workflow-left">
          {/* Step 1: Session Logs */}
          <section
            className="load-session__step load-session__step--inline"
            role="region"
            aria-label="Session Logs"
          >
            <div className="load-session__step-badge load-session__step-badge--active">
              1
            </div>
            <div className="load-session__step-content">
              <h2 className="load-session__step-title">Session Logs</h2>
              <div
                className={`load-session__dropzone load-session__dropzone--primary ${pendingMcpFiles.length === 0 ? "load-session__dropzone--browse" : ""}`}
                onClick={
                  pendingMcpFiles.length === 0
                    ? () => mcpInputRef.current?.click()
                    : undefined
                }
                onKeyDown={
                  pendingMcpFiles.length === 0
                    ? (e) => e.key === "Enter" && mcpInputRef.current?.click()
                    : undefined
                }
                role={pendingMcpFiles.length === 0 ? "button" : undefined}
                tabIndex={pendingMcpFiles.length === 0 ? 0 : undefined}
                aria-label={
                  pendingMcpFiles.length === 0
                    ? "Import canonical MCP files"
                    : undefined
                }
              >
                {pendingMcpFiles.length === 0 ? (
                  <>
                    <div
                      className="load-session__drop-icon load-session__drop-icon--doc"
                      aria-hidden
                    >
                      <svg
                        width="32"
                        height="32"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                        <polyline points="10 9 9 9 8 9" />
                      </svg>
                    </div>
                    <div className="load-session__drop-title">
                      Import Canonical MCP Files
                    </div>
                    <p className="load-session__drop-desc">{step1Instruction}</p>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        mcpInputRef.current?.click();
                      }}
                      className="load-session__browse-btn"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      Browse Files
                    </button>
                    <p className="load-session__drop-formats">
                      Supported formats: .json, .log, .mcp
                    </p>
                  </>
                ) : (
                  <>
                    <div className="load-session__drop-title">
                      Import Canonical MCP Files
                    </div>
                    <div className="load-session__selection-summary">
                      <span className="load-session__selection-count">
                        {pendingMcpFiles.length} file{pendingMcpFiles.length !== 1 ? "s" : ""} selected
                      </span>
                      <button
                        type="button"
                        className="load-session__selection-change"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectionExpanded((v) => !v);
                        }}
                      >
                        {selectionExpanded ? "Collapse" : "Change"}
                      </button>
                    </div>
                    {selectionExpanded && (
                      <div className="load-session__selection-list">
                        <ul className="load-session__selection-ul">
                          {pendingMcpFiles.map((file, i) => (
                            <li key={`${file.name}-${i}`} className="load-session__selection-li">
                              <span className="load-session__selection-filename" title={file.name}>
                                {file.name}
                              </span>
                              <button
                                type="button"
                                className="load-session__selection-remove"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removePendingMcpFile(i);
                                }}
                                aria-label={`Remove ${file.name}`}
                              >
                                ×
                              </button>
                            </li>
                          ))}
                        </ul>
                        <div className="load-session__selection-actions">
                          <button
                            type="button"
                            className="load-session__browse-btn load-session__browse-btn--secondary"
                            onClick={(e) => {
                              e.stopPropagation();
                              mcpInputRef.current?.click();
                            }}
                          >
                            Add more
                          </button>
                          <button
                            type="button"
                            className="load-session__browse-btn load-session__import-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              importPendingMcpFiles();
                            }}
                          >
                            Import selected
                          </button>
                        </div>
                      </div>
                    )}
                    <p className="load-session__drop-formats">
                      Supported formats: .json, .log, .mcp
                    </p>
                  </>
                )}
                {importStatus ? (
                  <p className="load-session__drop-status">{importStatus}</p>
                ) : null}
              </div>
            </div>
          </section>

          {/* Step 2: Raw Logs (Optional) – below Step 1 */}
          <section
            className={`load-session__step load-session__step--optional load-session__step--inline ${importSetId ? "load-session__step--enabled" : ""}`}
            role="region"
            aria-label="Raw Logs Optional"
          >
            <div className="load-session__step-badge">2</div>
            <div className="load-session__step-content">
              <h2 className="load-session__step-title">Raw Logs (Optional)</h2>
              <div className="load-session__raw-section">
                <div className="load-session__raw-icon" aria-hidden>
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                    <path d="M14 11h6v6h-6z" />
                  </svg>
                </div>
                <div className="load-session__raw-text">
                  <span className="load-session__raw-label">
                    Merge Supplemental Data
                  </span>
                  <p className="load-session__raw-desc">{step2Instruction}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (canMergeRaw) {
                      rawInputRef.current?.click();
                      return;
                    }
                    if (pendingMcpFiles.length > 0) {
                      void (async () => {
                        const importedRef = await handleImportMcpFiles(pendingMcpFiles, {
                          allowLocalLoadFallback: false,
                        });
                        if (importedRef) {
                          setRawTargetSessionId(importedRef);
                          rawInputRef.current?.click();
                        }
                      })();
                    }
                  }}
                  className="load-session__browse-btn load-session__browse-btn--secondary"
                  disabled={!canSelectRawLogs}
                >
                  Select Raw Logs
                </button>
              </div>
              {importedSessions.length > 0 ? (
                <select
                  className="load-session__target-select"
                  value={rawTargetSessionId}
                  onChange={(event) => setRawTargetSessionId(event.target.value)}
                  aria-label="Select imported target session for merge and launch"
                >
                  {importedSessions.map((session) => {
                    const ref = getSessionRef(session);
                    return (
                      <option key={ref} value={ref}>
                        {session.goal ?? session.session_id ?? session.key}
                      </option>
                    );
                  })}
                </select>
              ) : null}
              {rawMergeStatus ? (
                <p className="load-session__drop-status">{rawMergeStatus}</p>
              ) : null}
            </div>
          </section>
        </div>

        {/* Flow connector */}
        <div className="load-session__workflow-connector" aria-hidden>
          <span className="load-session__workflow-line" />
          <span className="load-session__workflow-arrow" />
        </div>

        {/* Open Session – right side, animated */}
        <div className="load-session__workflow-right">
          <button
            type="button"
            onClick={() => {
              if (rawTargetSessionId) {
                void openSessionById(rawTargetSessionId);
                return;
              }
              if (pendingMcpFiles.length > 0) {
                void (async () => {
                  const importedRef = await handleImportMcpFiles(pendingMcpFiles, {
                    allowLocalLoadFallback: true,
                  });
                  if (importedRef) {
                    await openSessionById(importedRef);
                  }
                })();
              }
            }}
            className={`load-session__open-cta ${canLaunchSession ? "load-session__open-cta--ready" : ""}`}
            disabled={!canLaunchSession}
            title={
              !canLaunchSession
                ? "Select or import session logs first"
                : "Launch session"
            }
          >
            <span className="load-session__open-cta-glow" aria-hidden />
            <span className="load-session__open-cta-text">Launch Session</span>
          </button>
        </div>
      </div>

      {/* Local Sessions */}
      <section
        className="load-session__local"
        role="region"
        aria-label="Local Sessions"
      >
        <div className="load-session__local-head">
          <div className="load-session__local-title-wrap">
            <svg
              className="load-session__local-icon"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <h2 className="load-session__local-heading">Local Sessions</h2>
          </div>
          <button
            type="button"
            onClick={() => void fetchLocalSessions()}
            className="load-session__clear-history"
            disabled={isLoadingLocal}
          >
            Clear History
          </button>
        </div>
        {localError ? (
          <p className="load-session__local-error">
            Local dashboard API unavailable ({localError}).
          </p>
        ) : null}
        {!localError && localSessions.length === 0 ? (
          <p className="load-session__local-empty">
            No session files found in local storage.
          </p>
        ) : null}
        <div className="load-session__local-list">
          {localSessions.slice(0, showAllSessions ? 100 : 6).map((session) => (
            <button
              type="button"
              key={`${session.key}-${session.updated_at}`}
              className="load-session__local-card"
              onClick={() => void loadLocalSession(session.key)}
              title={session.goal ?? session.session_id}
            >
              <span
                className="load-session__local-card-icon"
                aria-hidden
              >{`{}`}</span>
              <span className="load-session__local-card-name">
                {session.goal ?? session.session_id}
              </span>
              <p className="load-session__local-card-desc">
                {session.event_count} events · {session.outcome ?? "unknown"} ·{" "}
                {new Date(session.updated_at).toLocaleString()}
              </p>
              <span
                className="load-session__local-card-chevron"
                aria-hidden
              >{`>`}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="load-session__view-all"
          onClick={() => setShowAllSessions((v) => !v)}
        >
          <span aria-hidden>+</span>{" "}
          {showAllSessions ? "Show fewer" : "View All Sessions"}
        </button>
      </section>

      {/* Footer */}
      <footer className="load-session__footer">
        <span className="load-session__footer-copy">
          ©2024 AgentLens Engine. Built for high-performance animation
          workflows.
        </span>
        <div className="load-session__footer-links">
          <a href="#" className="load-session__footer-link">
            Documentation
          </a>
          <a href="#" className="load-session__footer-link">
            Support
          </a>
          <span className="load-session__footer-version">v2.4.1-stable</span>
        </div>
      </footer>

      <input
        ref={mcpInputRef}
        type="file"
        multiple
        accept=".json,.jsonl,.log,application/json"
        className="file-input"
        onChange={(event) => {
          const list = event.target.files;
          if (list && list.length > 0) {
            const files = Array.from(list);
            addPendingMcpFiles(files);
          }
          event.target.value = "";
        }}
        aria-label="Choose canonical MCP session files"
      />
      <input
        ref={rawInputRef}
        type="file"
        accept=".json,.jsonl,.txt,text/plain,application/json"
        className="file-input"
        onChange={(event) => {
          void handleMergeRawLog(event.target.files);
          event.target.value = "";
        }}
        aria-label="Choose raw log file to merge"
      />
    </div>
  );
}
