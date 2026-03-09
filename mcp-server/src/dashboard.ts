import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CanonicalEvent } from "./event-envelope.js";
import { EVENT_SCHEMA_VERSION } from "./event-envelope.js";
import {
  getDashboardHost,
  getDashboardPort,
  getDashboardWebappDir,
  getSessionsDir,
  isDashboardEnabled,
} from "./config.js";
import { exportSessionJson } from "./store.js";
import { handleGatewayAct, handleGatewayBeginRun, handleGatewayEndRun } from "./tools.js";
import { ingestRawContent } from "./ingest.js";
import {
  deriveIntentTokenBreakdown,
  generateFollowupArtifacts,
  type FollowupFocus,
  type FollowupMode,
  type FollowupStrictness,
} from "./local-analysis.js";
import { deriveSubagentGraph } from "./subagent-analysis.js";

interface SessionFileSummary {
  key: string;
  file: string;
  absolute_path: string;
  session_id: string;
  started_at?: string;
  ended_at?: string;
  goal?: string;
  outcome?: "completed" | "partial" | "failed" | "aborted" | "unknown";
  event_count: number;
  size_bytes: number;
  updated_at: string;
}

interface SessionPayload {
  session_id: string;
  goal?: string;
  user_prompt?: string;
  started_at?: string;
  ended_at?: string;
  events: CanonicalEvent[];
}

interface ImportedFileInput {
  name?: string;
  content: string;
}

interface ImportSet {
  import_set_id: string;
  created_at: string;
  session_ids: string[];
}

const importSets = new Map<string, ImportSet>();

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseToolResult(result: unknown): { ok: boolean; payload: unknown; error?: string } {
  if (!result || typeof result !== "object") {
    return { ok: false, payload: null, error: "Invalid tool response." };
  }
  const tool = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = tool.content?.[0]?.text;
  if (tool.isError) {
    return { ok: false, payload: null, error: text ?? "Tool failed." };
  }
  if (!text) return { ok: true, payload: {} };
  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    return { ok: true, payload: { message: text } };
  }
}

function isCanonicalEvent(raw: unknown): raw is CanonicalEvent {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as Partial<CanonicalEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.session_id === "string" &&
    typeof event.seq === "number" &&
    typeof event.ts === "string" &&
    typeof event.kind === "string" &&
    !!event.actor &&
    typeof event.actor.type === "string" &&
    !!event.payload &&
    typeof event.payload === "object" &&
    typeof event.schema_version === "number"
  );
}

function parseSessionContent(content: string): SessionPayload {
  const text = content.trim();
  if (!text) throw new Error("Empty session file.");

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const events = parsed.filter(isCanonicalEvent);
        if (events.length !== parsed.length) throw new Error("Invalid event in JSON array.");
        return toSessionPayload(events);
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Partial<SessionPayload>;
        if (Array.isArray(obj.events) && obj.events.every(isCanonicalEvent)) {
          return {
            session_id: obj.session_id ?? obj.events[0]?.session_id ?? "unknown",
            goal: typeof obj.goal === "string" ? obj.goal : undefined,
            user_prompt: typeof obj.user_prompt === "string" ? obj.user_prompt : undefined,
            started_at: typeof obj.started_at === "string" ? obj.started_at : undefined,
            ended_at: typeof obj.ended_at === "string" ? obj.ended_at : undefined,
            events: [...obj.events].sort((a, b) => (a.seq === b.seq ? a.ts.localeCompare(b.ts) : a.seq - b.seq)),
          };
        }
      }
    } catch {
      // Fall back to JSONL parsing below.
    }
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const events = lines.map((line, idx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL line ${idx + 1}`);
    }
    if (!isCanonicalEvent(parsed)) {
      throw new Error(`Invalid canonical event at JSONL line ${idx + 1}`);
    }
    return parsed;
  });
  return toSessionPayload(events);
}

function isCanonicalSessionContent(content: string): boolean {
  try {
    parseSessionContent(content);
    return true;
  } catch {
    return false;
  }
}

function toSessionPayload(events: CanonicalEvent[]): SessionPayload {
  const sorted = [...events].sort((a, b) => (a.seq === b.seq ? a.ts.localeCompare(b.ts) : a.seq - b.seq));
  const start = sorted.find((event) => event.kind === "session_start");
  const end = [...sorted].reverse().find((event) => event.kind === "session_end");
  const startPayload = (start?.payload ?? {}) as Record<string, unknown>;
  return {
    session_id: sorted[0]?.session_id ?? "unknown",
    goal: typeof startPayload.goal === "string" ? startPayload.goal : undefined,
    user_prompt: typeof startPayload.user_prompt === "string" ? startPayload.user_prompt : undefined,
    started_at: start?.ts ?? sorted[0]?.ts,
    ended_at: end?.ts,
    events: sorted,
  };
}

function readSessionFile(absolutePath: string): SessionPayload {
  const raw = readFileSync(absolutePath, "utf-8");
  return parseSessionContent(raw);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function writeCanonicalSession(payload: SessionPayload): string {
  const outDir = resolve(getSessionsDir());
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const safeSessionId = sanitizeFileName(payload.session_id || `sess_import_${Date.now()}`);
  const path = join(outDir, `${safeSessionId}.jsonl`);
  const body = payload.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  writeFileSync(path, body, "utf-8");
  return path;
}

function summarizeSessionPayload(payload: SessionPayload): Omit<SessionFileSummary, "size_bytes" | "updated_at"> {
  return {
    key: `${sanitizeFileName(payload.session_id)}.jsonl`,
    file: `${sanitizeFileName(payload.session_id)}.jsonl`,
    absolute_path: join(resolve(getSessionsDir()), `${sanitizeFileName(payload.session_id)}.jsonl`),
    session_id: payload.session_id,
    started_at: payload.started_at,
    ended_at: payload.ended_at,
    goal: payload.goal,
    outcome: deriveOutcome(payload.events),
    event_count: payload.events.length,
  };
}

/** Merge multiple session payloads into one: combined events sorted by ts, single session_id, re-sequenced. */
function mergeSessionPayloads(payloads: SessionPayload[]): SessionPayload {
  if (payloads.length === 0) throw new Error("No payloads to merge.");
  if (payloads.length === 1) return payloads[0];

  const mergedSessionId = `merged_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const expectedTotal = payloads.reduce((sum, p) => sum + p.events.length, 0);
  const allEvents: CanonicalEvent[] = [];

  for (const payload of payloads) {
    for (const e of payload.events) {
      allEvents.push({
        id: e.id,
        session_id: mergedSessionId,
        seq: e.seq,
        ts: e.ts,
        kind: e.kind,
        actor: { ...e.actor },
        scope: e.scope ? { ...e.scope } : undefined,
        payload: typeof e.payload === "object" && e.payload !== null ? { ...e.payload } : e.payload,
        derived: e.derived,
        confidence: e.confidence,
        visibility: e.visibility,
        schema_version: e.schema_version ?? EVENT_SCHEMA_VERSION,
      });
    }
  }

  if (allEvents.length !== expectedTotal) {
    throw new Error(
      `Merge event count mismatch: collected ${allEvents.length}, expected ${expectedTotal} from ${payloads.length} payload(s).`,
    );
  }

  allEvents.sort((a, b) => {
    const tsCmp = a.ts.localeCompare(b.ts);
    if (tsCmp !== 0) return tsCmp;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });

  let seq = 0;
  const mergedEvents: CanonicalEvent[] = allEvents.map((e) => {
    seq += 1;
    return {
      ...e,
      id: `${mergedSessionId}:${seq}:${randomUUID().slice(0, 8)}`,
      seq,
      schema_version: e.schema_version ?? EVENT_SCHEMA_VERSION,
    };
  });

  const first = payloads[0];
  const last = payloads[payloads.length - 1];
  const firstStart = mergedEvents.find((e) => e.kind === "session_start");
  const lastEnd = [...mergedEvents].reverse().find((e) => e.kind === "session_end");
  const startPayload = (firstStart?.payload ?? {}) as Record<string, unknown>;

  return {
    session_id: mergedSessionId,
    goal: typeof startPayload.goal === "string" ? startPayload.goal : first.goal ?? "Merged session",
    user_prompt: first.user_prompt,
    started_at: firstStart?.ts ?? first.started_at ?? mergedEvents[0]?.ts,
    ended_at: lastEnd?.ts ?? last.ended_at,
    events: mergedEvents,
  };
}

function buildFollowupFromEvents(events: CanonicalEvent[], focus: string): {
  insufficient_evidence: boolean;
  confidence: number;
  value_claims: {
    risk_mitigation: string[];
    efficiency_improvement: string[];
    quality_standardization: string[];
  };
  evidence_refs: Array<{ event_id: string; file?: string; reason: string }>;
  rule_spec: Record<string, unknown>;
  skill_draft: string;
} {
  const risks = events.filter((event) => event.kind === "risk_signal");
  const fails = events.filter(
    (event) => event.kind === "verification" && event.payload?.result === "fail"
  );
  const hotspots = events.filter((event) => event.kind === "hotspot");
  const repeatedFileOps = events.filter((event) => event.kind === "file_op");
  const evidence_refs: Array<{ event_id: string; file?: string; reason: string }> = [];

  for (const event of [...risks, ...fails, ...hotspots].slice(0, 6)) {
    const file = typeof event.scope?.file === "string" ? event.scope.file : undefined;
    evidence_refs.push({
      event_id: event.id,
      file,
      reason: `Signal from ${event.kind}`,
    });
  }

  const risk_mitigation: string[] = [];
  const efficiency_improvement: string[] = [];
  const quality_standardization: string[] = [];

  if (risks.length > 0) {
    risk_mitigation.push("Adds mandatory risk checks before accepting high-risk changes.");
  }
  if (fails.length > 0) {
    risk_mitigation.push("Requires verification pass gates for changed high-impact files.");
    quality_standardization.push("Standardizes failure handling workflow after failed checks.");
  }
  if (hotspots.length > 0 || repeatedFileOps.length > 8) {
    efficiency_improvement.push("Reduces rework by enforcing early validation and smaller scoped edits.");
  }
  if (quality_standardization.length === 0 && (risks.length > 0 || hotspots.length > 0)) {
    quality_standardization.push("Defines a repeatable execution sequence for similar tasks.");
  }

  const hasEvidence =
    evidence_refs.length > 0 ||
    risks.length > 0 ||
    fails.length > 0 ||
    hotspots.length > 0 ||
    repeatedFileOps.length > 0;

  const insufficient_evidence = !hasEvidence;
  const confidence = insufficient_evidence
    ? 0.25
    : Math.min(0.92, 0.45 + risks.length * 0.08 + fails.length * 0.1 + hotspots.length * 0.06);

  const rule_spec: Record<string, unknown> = {
    version: 1,
    focus,
    problem_addressed:
      focus === "verification_gap"
        ? "Repeated or unresolved verification gaps in similar tasks."
        : focus === "hotspot"
        ? "High-churn hotspots and regression-prone edit areas."
        : "Recurring risk and quality issues in agent workflow.",
    value_statement: [
      ...risk_mitigation.slice(0, 1),
      ...efficiency_improvement.slice(0, 1),
      ...quality_standardization.slice(0, 1),
    ],
    expected_outcome: {
      risk_reduction: risks.length > 0 || fails.length > 0,
      reduced_rework: hotspots.length > 0 || repeatedFileOps.length > 8,
      consistent_quality: true,
    },
    when_to_apply: "Use when similar task shape appears (same repo/module/risk pattern).",
    when_not_to_apply: "Skip for exploratory spikes without production-quality expectations.",
    checks: [
      "Run scoped verification after each high-impact file change.",
      "Require final pass/fail evidence before completion.",
      "Capture assumptions and validate unresolved high-risk assumptions.",
    ],
    evidence_refs,
  };

  const skill_draft = [
    "# Skill: Standardized Task Guardrails",
    "",
    "## Purpose",
    "Apply a repeatable workflow that mitigates known risks and reduces rework for similar tasks.",
    "",
    "## Value",
    risk_mitigation[0] ?? "Mitigates common risk patterns from prior sessions.",
    efficiency_improvement[0] ?? "Improves efficiency by reducing late-stage rework.",
    quality_standardization[0] ?? "Standardizes quality checks for consistent outcomes.",
    "",
    "## When to use",
    "- Similar files/modules and risk profile as referenced evidence.",
    "",
    "## When not to use",
    "- One-off exploration where strict quality gates are intentionally deferred.",
    "",
    "## Workflow",
    "1. Capture intent and impact scope.",
    "2. Apply small edits and run scoped checks immediately.",
    "3. Resolve failed checks before continuing.",
    "4. Summarize risks, mitigations, and final verification evidence.",
    "",
    "## Evidence anchors",
    ...evidence_refs.map((item) => `- ${item.event_id}${item.file ? ` (${item.file})` : ""}: ${item.reason}`),
    "",
  ].join("\n");

  return {
    insufficient_evidence,
    confidence: Number(confidence.toFixed(2)),
    value_claims: {
      risk_mitigation,
      efficiency_improvement,
      quality_standardization,
    },
    evidence_refs,
    rule_spec,
    skill_draft,
  };
}

function deriveOutcome(events: CanonicalEvent[]): SessionFileSummary["outcome"] {
  const end = [...events].reverse().find((event) => event.kind === "session_end");
  const payload = (end?.payload ?? {}) as Record<string, unknown>;
  const outcome = payload.outcome;
  return outcome === "completed" || outcome === "partial" || outcome === "failed" || outcome === "aborted"
    ? outcome
    : "unknown";
}

function listSessionFiles(): SessionFileSummary[] {
  const sessionsDir = resolve(getSessionsDir());
  if (!existsSync(sessionsDir)) return [];

  const files = readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl") || file.endsWith(".json"));
  const summaries: SessionFileSummary[] = [];

  for (const file of files) {
    const absolutePath = join(sessionsDir, file);
    const stats = statSync(absolutePath);
    if (!stats.isFile()) continue;

    try {
      const payload = readSessionFile(absolutePath);
      summaries.push({
        key: file,
        file,
        absolute_path: absolutePath,
        session_id: payload.session_id,
        started_at: payload.started_at,
        ended_at: payload.ended_at,
        goal: payload.goal,
        outcome: deriveOutcome(payload.events),
        event_count: payload.events.length,
        size_bytes: stats.size,
        updated_at: stats.mtime.toISOString(),
      });
    } catch {
      // Skip malformed files from API listing to keep dashboard stable.
    }
  }

  summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return summaries;
}

function contentType(pathname: string): string {
  const ext = extname(pathname).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function serveMissingWebapp(res: ServerResponse): void {
  res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
  res.end(
    [
      "<!doctype html>",
      "<html><body style='font-family:sans-serif;background:#020617;color:#e2e8f0;padding:24px'>",
      "<h1>AL Dashboard Not Built</h1>",
      "<p>Build the web app first:</p>",
      "<pre>cd /path/to/AL/webapp && npm run build</pre>",
      "</body></html>",
    ].join("")
  );
}

function safeJoin(root: string, requestPath: string): string | null {
  const normalizedPath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const joined = resolve(root, `.${normalizedPath}`);
  if (joined !== root && !joined.startsWith(`${root}/`)) return null;
  return joined;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;

  if (pathname === "/api/health") {
    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    json(res, 200, {
      ok: true,
      local_only: true,
      sessions_dir: resolve(getSessionsDir()),
      ts: new Date().toISOString(),
    });
    return true;
  }

  if (pathname === "/api/sessions") {
    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    json(res, 200, { sessions: listSessionFiles() });
    return true;
  }

  if (pathname === "/api/gateway/begin") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const parsed = parseToolResult(await handleGatewayBeginRun(body as never));
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      json(res, 200, parsed.payload);
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/gateway/act") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const parsed = parseToolResult(await handleGatewayAct(body as never));
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      json(res, 200, parsed.payload);
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/gateway/end") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const parsed = parseToolResult(await handleGatewayEndRun(body as never));
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      json(res, 200, parsed.payload);
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/ingest") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const raw = typeof body.raw === "string" ? body.raw : "";
      if (!raw.trim()) {
        json(res, 400, { error: "Missing `raw` content." });
        return true;
      }
      const result = ingestRawContent(raw, {
        adapter: typeof body.adapter === "string" ? body.adapter : "auto",
        merge_session_id:
          typeof body.merge_session_id === "string" && body.merge_session_id.trim() !== ""
            ? body.merge_session_id
            : undefined,
        dedupe: body.dedupe === false ? false : true,
      });
      json(res, 200, result);
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/import/mcp") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const filesRaw = Array.isArray(body.files) ? body.files : [];
      if (filesRaw.length === 0) {
        json(res, 400, { error: "Missing `files` array. Provide one or more MCP canonical session logs." });
        return true;
      }

      const acceptedPayloads: SessionPayload[] = [];
      const rejected_files: Array<{ name: string; error: string }> = [];

      for (const item of filesRaw) {
        const file = item as ImportedFileInput;
        const name = typeof file.name === "string" && file.name.trim() !== "" ? file.name : "unnamed";
        if (typeof file.content !== "string" || file.content.trim() === "") {
          rejected_files.push({ name, error: "File content is empty." });
          continue;
        }
        try {
          const payload = parseSessionContent(file.content);
          acceptedPayloads.push(payload);
        } catch (error) {
          rejected_files.push({
            name,
            error:
              error instanceof Error
                ? `Not a canonical MCP session log: ${error.message}`
                : "Not a canonical MCP session log.",
          });
        }
      }

      if (acceptedPayloads.length === 0) {
        json(res, 400, {
          error: "No canonical MCP session logs were accepted.",
          rejected_files,
        });
        return true;
      }

      const mergedPayload =
        acceptedPayloads.length === 1
          ? acceptedPayloads[0]
          : mergeSessionPayloads(acceptedPayloads);

      writeCanonicalSession(mergedPayload);
      const summary = summarizeSessionPayload(mergedPayload);
      const accepted: SessionFileSummary[] = [
        {
          ...summary,
          size_bytes: mergedPayload.events.reduce(
            (acc, e) => acc + Buffer.byteLength(JSON.stringify(e), "utf-8"),
            0,
          ),
          updated_at: new Date().toISOString(),
        },
      ];

      const import_set_id = `iset_${Date.now()}_${randomUUID().slice(0, 8)}`;
      importSets.set(import_set_id, {
        import_set_id,
        created_at: new Date().toISOString(),
        session_ids: [mergedPayload.session_id],
      });

      const multipleRejected = filesRaw.length > 1 && rejected_files.length > 0;
      json(res, 200, {
        import_set_id,
        sessions: accepted,
        rejected_files,
        accepted_file_count: acceptedPayloads.length,
        total_event_count: mergedPayload.events.length,
        guidance: multipleRejected
          ? `${acceptedPayloads.length} of ${filesRaw.length} files were valid. Fix or remove rejected files to merge all session logs.`
          : acceptedPayloads.length > 1
            ? "Multiple session logs were merged into one. Raw logs will merge into this combined session."
            : "Import only relevant or consecutive sessions from the same thread/conversation to avoid noisy insights.",
      });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/import/raw-merge") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const importSetId = typeof body.import_set_id === "string" ? body.import_set_id : "";
      const targetSessionId = typeof body.target_session_id === "string" ? body.target_session_id : "";
      const raw = typeof body.raw === "string" ? body.raw : "";
      if (!importSetId || !targetSessionId) {
        json(res, 400, { error: "Missing `import_set_id` or `target_session_id`." });
        return true;
      }
      if (!raw.trim()) {
        json(res, 400, { error: "Missing raw log content." });
        return true;
      }
      const importSet = importSets.get(importSetId);
      if (!importSet) {
        json(res, 404, { error: "Import set not found. Start by importing MCP logs first." });
        return true;
      }
      if (!importSet.session_ids.includes(targetSessionId)) {
        json(res, 400, { error: "target_session_id is not part of the selected import set." });
        return true;
      }
      if (isCanonicalSessionContent(raw)) {
        json(res, 400, {
          error: "Raw merge accepts only raw Codex/Cursor logs. Use /api/import/mcp for canonical session logs.",
        });
        return true;
      }

      const result = ingestRawContent(raw, {
        adapter: typeof body.adapter === "string" ? body.adapter : "auto",
        merge_session_id: targetSessionId,
        dedupe: body.dedupe === false ? false : true,
      });
      json(res, 200, {
        ...result,
        guidance: "Raw logs were merged into your imported MCP baseline session.",
      });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/followup/generate") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const scope = typeof body.scope === "string" ? body.scope : "session";
      const focus: FollowupFocus =
        body.focus === "risk" ||
        body.focus === "verification_gap" ||
        body.focus === "hotspot" ||
        body.focus === "rework_pattern" ||
        body.focus === "efficiency"
          ? body.focus
          : "risk";
      const mode: FollowupMode = body.mode === "session" ? "session" : "per_intent";
      const strictness: FollowupStrictness =
        body.strictness === "advisory" || body.strictness === "hard" ? body.strictness : "soft";
      const importSetId = typeof body.import_set_id === "string" ? body.import_set_id : "";
      const sessionId = typeof body.session_id === "string" ? body.session_id : "";
      const summaries = listSessionFiles();

      const scopedSessionIds =
        scope === "import_set" && importSetId && importSets.get(importSetId)
          ? importSets.get(importSetId)?.session_ids ?? []
          : sessionId
          ? [sessionId]
          : [];

      if (scopedSessionIds.length === 0) {
        json(res, 400, { error: "Provide `session_id` or a valid import-set scope." });
        return true;
      }

      const collectedEvents: CanonicalEvent[] = [];
      for (const id of scopedSessionIds) {
        const summary = summaries.find((item) => item.session_id === id);
        if (!summary) continue;
        const payload = readSessionFile(summary.absolute_path);
        collectedEvents.push(...payload.events);
      }
      if (collectedEvents.length === 0) {
        json(res, 404, { error: "No events found for requested follow-up scope." });
        return true;
      }

      const generated = generateFollowupArtifacts(collectedEvents, {
        focus,
        mode,
        strictness,
      });
      json(res, 200, {
        scope,
        focus,
        mode,
        strictness,
        session_ids: scopedSessionIds,
        generated_at: new Date().toISOString(),
        ...generated,
      });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname.startsWith("/api/sessions/")) {
    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    const key = decodeURIComponent(pathname.slice("/api/sessions/".length));
    if (!key) {
      json(res, 400, { error: "Missing session key." });
      return true;
    }

    if (key.endsWith("/export")) {
      const rawKey = key.slice(0, -"/export".length);
      const summary = listSessionFiles().find((item) => item.key === rawKey || item.session_id === rawKey);
      if (!summary) {
        json(res, 404, { error: "Session not found." });
        return true;
      }
      try {
        const exported = exportSessionJson(summary.session_id);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${summary.session_id}.session.json"`,
        });
        res.end(exported);
      } catch (error) {
        json(res, 500, {
          error: error instanceof Error ? error.message : "Failed to export session.",
        });
      }
      return true;
    }

    if (key.endsWith("/token-breakdown")) {
      const rawKey = key.slice(0, -"/token-breakdown".length);
      const summary = listSessionFiles().find((item) => item.key === rawKey || item.session_id === rawKey);
      if (!summary) {
        json(res, 404, { error: "Session not found." });
        return true;
      }
      try {
        const payload = readSessionFile(summary.absolute_path);
        const breakdown = deriveIntentTokenBreakdown(payload.events);
        json(res, 200, {
          session_id: summary.session_id,
          generated_at: new Date().toISOString(),
          ...breakdown,
        });
      } catch (error) {
        json(res, 500, {
          error: error instanceof Error ? error.message : "Failed to derive token breakdown.",
        });
      }
      return true;
    }

    if (key.endsWith("/subagent-graph")) {
      const rawKey = key.slice(0, -"/subagent-graph".length);
      const summary = listSessionFiles().find((item) => item.key === rawKey || item.session_id === rawKey);
      if (!summary) {
        json(res, 404, { error: "Session not found." });
        return true;
      }
      try {
        const payload = readSessionFile(summary.absolute_path);
        const graph = deriveSubagentGraph(payload.events);
        json(res, 200, {
          session_id: summary.session_id,
          generated_at: new Date().toISOString(),
          ...graph,
        });
      } catch (error) {
        json(res, 500, {
          error: error instanceof Error ? error.message : "Failed to derive subagent graph.",
        });
      }
      return true;
    }

    const summary = listSessionFiles().find((item) => item.key === key || item.session_id === key);
    if (!summary) {
      json(res, 404, { error: "Session not found." });
      return true;
    }

    try {
      const payload = readSessionFile(summary.absolute_path);
      json(res, 200, payload);
    } catch (error) {
      json(res, 500, {
        error: error instanceof Error ? error.message : "Failed to read session file.",
      });
    }
    return true;
  }

  json(res, 404, { error: "Unknown API endpoint." });
  return true;
}

function handleStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const webappDir = getDashboardWebappDir();

  handleApi(req, res, pathname)
    .then((handled) => {
    if (handled) return;

    if (!existsSync(webappDir)) {
      serveMissingWebapp(res);
      return;
    }

    const relative = pathname === "/" ? "/index.html" : pathname;
    const resolved = safeJoin(webappDir, relative);
    if (!resolved) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }

    const hasExt = extname(relative).length > 0;
    const target = existsSync(resolved) ? resolved : hasExt ? null : join(webappDir, "index.html");
    if (!target || !existsSync(target)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const body = readFileSync(target);
    res.writeHead(200, {
      "content-type": contentType(target),
      "cache-control": target.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    });
    res.end(body);
    })
    .catch((error) => {
      json(res, 500, {
        error: error instanceof Error ? error.message : "Unhandled server error.",
      });
    });
}

export function startDashboardServer(): { host: string; port: number } | null {
  if (!isDashboardEnabled()) {
    process.stderr.write("AL dashboard disabled (AL_DASHBOARD_ENABLED=false)\n");
    return null;
  }

  const host = getDashboardHost();
  const port = getDashboardPort();
  const server = createServer((req, res) => handleStatic(req, res));
  server.listen(port, host, () => {
    process.stderr.write(
      `AL dashboard listening at http://${host}:${port} (sessions: ${resolve(getSessionsDir())}, webapp: ${getDashboardWebappDir()})\n`
    );
  });
  server.on("error", (error) => {
    process.stderr.write(`AL dashboard failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  return { host, port };
}
