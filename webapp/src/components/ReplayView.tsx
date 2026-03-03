import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Session } from "../types/session";
import { getSegments } from "../lib/segments";
import { getChangedFiles, getRevisionIndexForEvent } from "../lib/fileEvolution";
import { runAuditPostProcessing } from "../lib/auditPipeline";
import { PlanNodesPanel } from "./PlanNodesPanel";
import { ChangedFilesList } from "./ChangedFilesList";
import { SegmentDetailView } from "./SegmentDetailView";
import { FileEvolutionView } from "./FileEvolutionView";
import { TimelineStrip } from "./TimelineStrip";
import { PlaybackControls } from "./PlaybackControls";
import { FlowView } from "./FlowView";
import { ReviewerHighlights } from "./ReviewerHighlights";
import { ReviewerFocusPanel } from "./ReviewerFocusPanel";
import { ContextPathView } from "./ContextPathView";
import {
  deriveIntentTokenBreakdown,
  generateFollowupArtifacts,
  type FollowupGenerationResult,
  type TokenBreakdownResult,
} from "../lib/localDeterministic";

import "./ReplayView.css";

const BASE_INTERVAL_MS = 2000;

interface ReplayViewProps {
  session: Session;
  onBack: () => void;
}

type FollowupGenerateResponse = FollowupGenerationResult;
type TokenBreakdownResponse = TokenBreakdownResult;

export function ReplayView({ session, onBack }: ReplayViewProps) {
  const segments = getSegments(session);
  const { normalized, reviewer } = useMemo(
    () => runAuditPostProcessing(session.events),
    [session.events]
  );
  const changedFiles = useMemo(() => getChangedFiles(session), [session]);

  const criticalEvents = useMemo(() => {
    const out: Array<{ index: number; severity: "high" | "medium"; reason: string }> = [];
    for (let i = 0; i < session.events.length; i++) {
      const e = session.events[i];
      if (e.kind === "decision") out.push({ index: i, severity: "medium", reason: "Decision point" });
      if (e.kind === "session_end") out.push({ index: i, severity: "medium", reason: "Session outcome" });
      if (e.kind === "assumption" && e.payload.risk === "high") {
        out.push({ index: i, severity: "high", reason: "High-risk assumption" });
      }
      if (e.kind === "verification") {
        const r = e.payload.result;
        if (r === "fail") out.push({ index: i, severity: "high", reason: "Verification failed" });
        else if (r === "unknown") out.push({ index: i, severity: "medium", reason: "Verification unknown" });
      }
      if (e.kind === "file_op") {
        const target =
          (typeof e.payload.target === "string" ? e.payload.target : "") ||
          (typeof e.scope?.file === "string" ? e.scope.file : "");
        const lower = target.toLowerCase();
        if (
          lower.includes("/api/") ||
          lower.includes("/routes/") ||
          lower.includes("/migrations/") ||
          lower.endsWith("package.json")
        ) {
          out.push({ index: i, severity: "high", reason: `High-impact file: ${target}` });
        }
      }
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }, [session.events]);
  const criticalIndices = useMemo(
    () => [...new Set(criticalEvents.map((e) => e.index))],
    [criticalEvents]
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<
    number | null
  >(segments.length > 0 ? 0 : null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedRevisionIndex, setSelectedRevisionIndex] = useState(0);
  const [viewMode, setViewMode] = useState<"timeline" | "pivot">("timeline");
  const [timelineTab, setTimelineTab] = useState<"deliverables" | "context" | "reviewer">("deliverables");
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [followupResult, setFollowupResult] = useState<FollowupGenerateResponse | null>(null);
  const [followupStatus, setFollowupStatus] = useState<string>("");
  const [tokenBreakdown, setTokenBreakdown] = useState<TokenBreakdownResponse | null>(null);
  const [tokenStatus, setTokenStatus] = useState<string>("");
  const [selectedIntentCost, setSelectedIntentCost] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isWorkflowView = viewMode === "pivot";
  const playbackSpeed = speed;

  const eventCount = session.events.length;
  const atEnd = eventCount === 0 || currentIndex >= eventCount - 1;

  const stopPlayback = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Keep selected plan node and detail view in sync with current event (playback or scrub)
  useEffect(() => {
    const segIdx = segments.findIndex((s) =>
      s.eventIndices.includes(currentIndex),
    );
    setSelectedSegmentIndex(segIdx >= 0 ? segIdx : null);
  }, [currentIndex, segments]);

  useEffect(() => {
    if (!isPlaying) return;
    if (atEnd) {
      stopPlayback();
      return;
    }
    const ms = BASE_INTERVAL_MS / playbackSpeed;
    intervalRef.current = setInterval(() => {
      setCurrentIndex((i) => {
        if (i >= eventCount - 1) {
          stopPlayback();
          return i;
        }
        return i + 1;
      });
    }, ms);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, playbackSpeed, atEnd, eventCount, stopPlayback]);

  const handleSeek = useCallback(
    (index: number) => {
      setCurrentIndex(index);
      if (isPlaying) stopPlayback();
      const segIdx = segments.findIndex((s) => s.eventIndices.includes(index));
      if (segIdx >= 0) setSelectedSegmentIndex(segIdx);
    },
    [isPlaying, stopPlayback, segments],
  );

  const handleSelectSegment = useCallback(
    (index: number) => {
      setSelectedSegmentIndex(index);
      setSelectedFilePath(null);
      const seg = segments[index];
      if (seg) setCurrentIndex(seg.planStepIndex);
    },
    [segments],
  );

  const handleSelectFile = useCallback((path: string) => {
    setSelectedFilePath(path);
    setSelectedRevisionIndex(0);
  }, []);

  const handleOpenFileEvolution = useCallback(
    (path: string, eventIndex: number) => {
      setSelectedFilePath(path);
      setSelectedRevisionIndex(
        getRevisionIndexForEvent(session, path, eventIndex),
      );
    },
    [session],
  );

  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => stopPlayback(), [stopPlayback]);

  const handleGenerateFollowup = useCallback(() => {
    setFollowupStatus("Generating rule + skill draft locally...");
    setFollowupResult(null);
    try {
      const data = generateFollowupArtifacts(session.events, {
        focus: "risk",
        mode: "per_intent",
        strictness: "soft",
      });
      setFollowupResult(data);
      setFollowupStatus("Follow-up artifacts generated locally.");
    } catch (error) {
      setFollowupStatus(error instanceof Error ? error.message : "Failed to generate follow-up artifacts.");
    }
  }, [session.events]);

  const copyText = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // ignore clipboard failures in unsupported contexts
    }
  }, []);

  useEffect(() => {
    setTokenStatus("Computing intent token breakdown locally...");
    try {
      const data = deriveIntentTokenBreakdown(session.events);
      setTokenBreakdown(data);
      setSelectedIntentCost(data.intent_breakdown[0]?.intent_id ?? null);
      setTokenStatus("");
    } catch (error) {
      setTokenBreakdown(null);
      setTokenStatus(error instanceof Error ? error.message : "Token breakdown unavailable.");
    }
  }, [session.events]);

  const selectedSegment =
    selectedSegmentIndex != null && segments[selectedSegmentIndex]
      ? segments[selectedSegmentIndex]
      : null;

  return (
    <div
      className={`replay-view ${isWorkflowView ? "replay-view--workflow" : ""}`}
    >
      <header className="replay-header">
        <button
          type="button"
          className="back-btn"
          onClick={onBack}
          aria-label="Load another session"
        >
          ← Back
        </button>
        <h1
          className={`replay-title ${isWorkflowView ? "replay-title--workflow" : ""}`}
        >
          {isWorkflowView ? (
            <>
              <span className="workflow-logo" aria-hidden>
                ◇
              </span>
              Workflow Visualizer
            </>
          ) : (
            session.title
          )}
        </h1>
        <p className="replay-meta">
          {session.id} · {eventCount} events
        </p>
        <div className="replay-view-toggle replay-view-toggle--all">
          <button
            type="button"
            className={viewMode === "timeline" ? "active" : ""}
            onClick={() => setViewMode("timeline")}
          >
            Session
          </button>
          <button
            type="button"
            className={`replay-view-toggle__pivot ${viewMode === "pivot" ? "active" : ""}`}
            onClick={() => setViewMode("pivot")}
            title="Pivot: immersive mission flow"
          >
            Pivot ★
          </button>
        </div>
      </header>
      <div className="replay-layout">
        {viewMode === "timeline" && timelineTab === "deliverables" && (
          <aside className="replay-sidebar">
            <PlanNodesPanel
              session={session}
              selectedSegmentIndex={selectedSegmentIndex}
              onSelectSegment={handleSelectSegment}
            />
            <ChangedFilesList
              session={session}
              selectedPath={selectedFilePath}
              onSelectFile={handleSelectFile}
            />
          </aside>
        )}
        <main className="replay-main">
          {viewMode === "timeline" && (
            <div className="replay-subtabs">
              <button
                type="button"
                className={timelineTab === "deliverables" ? "active" : ""}
                onClick={() => setTimelineTab("deliverables")}
              >
                Deliverables
              </button>
              <button
                type="button"
                className={timelineTab === "context" ? "active" : ""}
                onClick={() => setTimelineTab("context")}
              >
                Context
              </button>
              <button
                type="button"
                className={timelineTab === "reviewer" ? "active" : ""}
                onClick={() => setTimelineTab("reviewer")}
              >
                Reviewer
              </button>
            </div>
          )}
          {viewMode === "pivot" && (
            <FlowView
              session={session}
              currentIndex={currentIndex}
              onSeek={handleSeek}
              isPlaying={isPlaying}
              onPlay={handlePlay}
              onPause={handlePause}
              allowPerspective={true}
            />
          )}
          {viewMode === "timeline" && (
            <>
              {timelineTab === "reviewer" ? (
                <>
                  <ReviewerHighlights normalized={normalized} reviewer={reviewer} />
                  <ReviewerFocusPanel
                    session={session}
                    normalized={normalized}
                    reviewer={reviewer}
                    currentIndex={currentIndex}
                    onSeek={handleSeek}
                    criticalEvents={criticalEvents}
                  />
                </>
              ) : timelineTab === "context" ? (
                <ContextPathView
                  session={session}
                  currentIndex={currentIndex}
                  onSeek={handleSeek}
                />
              ) : selectedFilePath ? (
                <FileEvolutionView
                  session={session}
                  path={selectedFilePath}
                  revisionIndex={selectedRevisionIndex}
                  onRevisionChange={setSelectedRevisionIndex}
                />
              ) : selectedSegment ? (
                <>
                  <section className="reviewer-highlights">
                    <header className="reviewer-highlights__header">
                      <h2>Deliverable Summary</h2>
                      <span>Clean summary first, details on demand.</span>
                    </header>
                    <div className="reviewer-highlights__grid">
                      <article className="reviewer-highlights__card">
                        <h3>Outcome</h3>
                        <p>
                          {reviewer.outcome} · confidence {Math.round(reviewer.confidence_estimate * 100)}%
                        </p>
                        <p>{reviewer.goal}</p>
                      </article>
                      <article className="reviewer-highlights__card">
                        <h3>Changed Scope</h3>
                        <p>{changedFiles.length} files changed</p>
                        <p>{normalized.impacts.length} impact artifact(s)</p>
                      </article>
                      <article className="reviewer-highlights__card">
                        <h3>Quality & Risk</h3>
                        <p>
                          Checks: {reviewer.verification_summary.pass} pass /{" "}
                          {reviewer.verification_summary.fail} fail / {reviewer.verification_summary.unknown} unknown
                        </p>
                        <p>
                          High-risk items:{" "}
                          {
                            reviewer.high_risk_items.filter((item) => item.level === "high")
                              .length
                          }
                        </p>
                      </article>
                    </div>
                  </section>
                  <section className="reviewer-focus">
                    <header className="reviewer-focus__alert">
                      <h2>Intent Cost</h2>
                      <p>Token consumption per intent, split into context-building vs output-producing usage.</p>
                    </header>
                    {tokenStatus ? <p>{tokenStatus}</p> : null}
                    {tokenBreakdown ? (
                      <>
                        <div className="reviewer-focus__card reviewer-focus__card--wide">
                          <p>
                            Total {tokenBreakdown.totals.total_tokens.toLocaleString()} tokens · context{" "}
                            {tokenBreakdown.totals.context_tokens.toLocaleString()} · output{" "}
                            {tokenBreakdown.totals.output_tokens.toLocaleString()} · unknown{" "}
                            {tokenBreakdown.totals.unknown_tokens.toLocaleString()}
                          </p>
                        </div>
                        <div className="reviewer-focus__card reviewer-focus__card--wide">
                          <table className="reviewer-focus__table">
                            <thead>
                              <tr>
                                <th>Intent</th>
                                <th>Total</th>
                                <th>Context</th>
                                <th>Output</th>
                                <th>Unknown</th>
                                <th>Cost</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tokenBreakdown.intent_breakdown.map((row) => {
                                const total = Math.max(1, row.total_tokens);
                                const contextPct = Math.round((row.context_tokens / total) * 100);
                                const outputPct = Math.round((row.output_tokens / total) * 100);
                                const unknownPct = Math.max(0, 100 - contextPct - outputPct);
                                return (
                                  <tr
                                    key={row.intent_id}
                                    className={selectedIntentCost === row.intent_id ? "is-selected" : ""}
                                    onClick={() => setSelectedIntentCost(row.intent_id)}
                                  >
                                    <td>{row.intent_title}</td>
                                    <td>{row.total_tokens.toLocaleString()}</td>
                                    <td>
                                      {row.context_tokens.toLocaleString()}
                                      <div className="token-bar">
                                        <span className="token-bar__context" style={{ width: `${contextPct}%` }} />
                                        <span className="token-bar__output" style={{ width: `${outputPct}%` }} />
                                        <span className="token-bar__unknown" style={{ width: `${unknownPct}%` }} />
                                      </div>
                                    </td>
                                    <td>{row.output_tokens.toLocaleString()}</td>
                                    <td>{row.unknown_tokens.toLocaleString()}</td>
                                    <td>{row.estimated_cost_usd != null ? `$${row.estimated_cost_usd}` : "-"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {selectedIntentCost ? (
                          <div className="reviewer-focus__card reviewer-focus__card--wide">
                            <h3>Token Drill-down</h3>
                            {tokenBreakdown.intent_breakdown
                              .filter((row) => row.intent_id === selectedIntentCost)
                              .map((row) => (
                                <ul key={row.intent_id}>
                                  {row.supporting_events.slice(0, 12).map((item) => (
                                    <li key={item.checkpoint_event_id}>
                                      <button type="button" onClick={() => handleSeek(Math.max(0, row.event_window.start_seq - 1))}>
                                        {item.checkpoint_event_id}
                                      </button>{" "}
                                      · total {item.total_tokens} · context {item.context_tokens} · output{" "}
                                      {item.output_tokens} · unknown {item.unknown_tokens}
                                    </li>
                                  ))}
                                </ul>
                              ))}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </section>
                  <SegmentDetailView
                    session={session}
                    segment={selectedSegment}
                    segmentIndex={selectedSegmentIndex ?? 0}
                    onOpenFileEvolution={handleOpenFileEvolution}
                  />
                  <section className="reviewer-focus">
                    <header className="reviewer-focus__alert">
                      <h2>User-Triggered Workflow Standardization</h2>
                      <p>Generate a rule + skill draft only when you want to standardize similar future tasks.</p>
                    </header>
                    <button type="button" className="browse-btn" onClick={() => void handleGenerateFollowup()}>
                      Generate Follow-up Rule/Skill
                    </button>
                    {followupStatus ? <p>{followupStatus}</p> : null}
                    {followupResult ? (
                      <>
                        <p>
                          Intents: {followupResult.summary.intent_count} · high-risk intents:{" "}
                          {followupResult.summary.high_risk_intents} · high waste intents:{" "}
                          {followupResult.summary.high_efficiency_waste_intents}
                        </p>
                        <div className="reviewer-focus__grid reviewer-focus__grid--2">
                          {followupResult.artifacts.map((artifact) => (
                            <article className="reviewer-focus__card" key={artifact.intent_id}>
                              <h3>{artifact.intent_title}</h3>
                              <p>
                                template <code>{artifact.rule_template_id}</code> · confidence {artifact.confidence}
                              </p>
                              <p>
                                risk {artifact.features.risk_score} · waste {artifact.features.efficiency_waste_score}
                                {" "}· stability {artifact.features.stability_score}
                              </p>
                              <ul>
                                {artifact.value_claims.risk_mitigation.map((item, index) => (
                                  <li key={`risk-${artifact.intent_id}-${index}`}>{item}</li>
                                ))}
                                {artifact.value_claims.efficiency_improvement.map((item, index) => (
                                  <li key={`eff-${artifact.intent_id}-${index}`}>{item}</li>
                                ))}
                                {artifact.value_claims.quality_standardization.map((item, index) => (
                                  <li key={`qual-${artifact.intent_id}-${index}`}>{item}</li>
                                ))}
                              </ul>
                              <details>
                                <summary>Evidence refs ({artifact.evidence_refs.length})</summary>
                                <ul>
                                  {artifact.evidence_refs.slice(0, 10).map((item) => (
                                    <li key={`${artifact.intent_id}-${item.event_id}`}>
                                      {item.event_id} · {item.reason}
                                    </li>
                                  ))}
                                </ul>
                              </details>
                              <div className="reviewer-focus__actions">
                                <button
                                  type="button"
                                  onClick={() => void copyText(JSON.stringify(artifact.rule_spec, null, 2))}
                                >
                                  Copy Rule JSON
                                </button>
                                <button type="button" onClick={() => void copyText(artifact.skill_draft)}>
                                  Copy SKILL.md
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </section>
                </>
              ) : (
                <div className="replay-placeholder">
                  <p>Select a changed file or plan step to open deliverable details.</p>
                  {segments.length === 0 && (
                    <p className="replay-placeholder-note">
                      This session has no explicit intent boundaries. The UI can still
                      render lifecycle using fallback grouping.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <footer className="replay-footer">
        {viewMode === "timeline" ? (
          <>
            <TimelineStrip
              eventCount={eventCount}
              currentIndex={currentIndex}
              onSeek={handleSeek}
              criticalIndices={criticalIndices}
            />
            <PlaybackControls
              isPlaying={isPlaying}
              speed={speed}
              onPlay={handlePlay}
              onPause={handlePause}
              onSpeedChange={setSpeed}
              disabled={eventCount === 0}
            />
          </>
        ) : null}
      </footer>
    </div>
  );
}
