import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, CheckCircle2, FileUp, Sparkles, Wand2, Search, Link2, Copy, Trash2, Package, ClipboardCheck, Settings, Loader2, Bot, Star, Download, Check } from "lucide-react";
import { defaultActionSpec, lintHandoff, buildAgentHandoffPackage, buildPromptTemplate, buildAgentScript } from "./handoff-helpers";
import {
  hasApiKey, getApiKey, setApiKey, getModel, setModel,
  extractWithLLM, generateLogicPlan as llmGenerateLogicPlan,
  generateScript as llmGenerateScript, reviewBlueprint as llmReviewBlueprint,
  optimizeBlueprint as llmOptimizeBlueprint, generatePRD as llmGeneratePRD,
  continueScript as llmContinueScript,
} from "./llm-service";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const LEGACY_AUTOSAVE_KEY = ["agent", "force_blueprint_autosave"].join("");
const AUTOSAVE_KEY = "agent_blueprint_autosave";

/**
 * Demo-ready prototype: Agent Blueprint Autofill
 * - Upload or paste PRD text
 * - Heuristic extraction to prefill: Agent Charter, Logic Planning, Annotated Script
 * - Evidence + confidence + review flags
 *
 * This is a prototype — not a production extractor.
 * Replace `extractFromText()` with your LLM + grounding pipeline.
 */

// -----------------------------
// Utilities
// -----------------------------

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function norm(s) {
  return (s || "").replace(/\r/g, "").trim();
}

function firstNonEmpty(...arr) {
  for (const a of arr) {
    const v = norm(a);
    if (v) return v;
  }
  return "";
}

function toLines(text) {
  return norm(text).split("\n").map((l) => l.trim());
}

function scoreConfidence(hitCount, expected) {
  // Simple scoring: hits / expected; with floor/ceiling
  const raw = expected <= 0 ? 0 : hitCount / expected;
  return clamp(Math.round(raw * 100), 5, 95);
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return "{}";
  }
}

function extractTopicSections(markdown) {
  if (!markdown) return [];
  const lines = markdown.split("\n");
  const sections = [];
  let current = null;
  const topicHeader = /^(#{2,4})\s+Topic:\s*(.+)$/i;

  for (const line of lines) {
    const m = line.match(topicHeader);
    if (m) {
      if (current) sections.push(current);
      current = {
        title: m[2].trim() || "Unnamed Topic",
        lines: [line],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ title: s.title, content: s.lines.join("\n") }));
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Step / Labels helpers ──

const EMPTY_LABELS = {
  trigger: "", routing: "", precheck: "", action: "", inputs: "",
  state: "", ui: "", failure: "", recovery: "", guardrail: "", result: "", telemetry: "",
};

const LABEL_KEYS = Object.keys(EMPTY_LABELS);

const LABEL_META = {
  trigger: { label: "Trigger", hint: "user_input_received" },
  routing: { label: "Routing", hint: "intent = X → topic = Y" },
  precheck: { label: "Precheck", hint: "required condition" },
  action: { label: "Action", hint: "ToolOrFlowName (Flow/Apex)" },
  inputs: { label: "Inputs", hint: "field1, field2, @variable" },
  state: { label: "State", hint: "set @var (source: user/tool)" },
  ui: { label: "UI", hint: "component + purpose" },
  failure: { label: "Failure", hint: "plain-language reason" },
  recovery: { label: "Recovery", hint: "one clear next step" },
  guardrail: { label: "Guardrail", hint: "do/don't rule" },
  result: { label: "Result", hint: "success | failure | empty | partial" },
  telemetry: { label: "Telemetry", hint: "event names/metrics" },
};

function labelsToAnnotation(labels) {
  if (!labels) return "";
  return LABEL_KEYS
    .filter((k) => labels[k])
    .map((k) => `${LABEL_META[k].label}: ${labels[k]}`)
    .join("\n");
}

function annotationToLabels(annotation) {
  const labels = { ...EMPTY_LABELS };
  if (!annotation) return labels;
  const lines = annotation.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (match) {
      const key = match[1].toLowerCase();
      if (key in labels) {
        labels[key] = labels[key] ? labels[key] + "; " + match[2] : match[2];
      }
    }
  }
  return labels;
}

function makeStep(step, actor, dialogue = "", labels = null, substeps = []) {
  return {
    step: String(step),
    actor,
    dialogue,
    labels: labels || { ...EMPTY_LABELS },
    substeps: substeps || [],
  };
}

function toSalesforceDeveloperName(label) {
  if (!label) return "";
  return label
    .replace(/[^a-zA-Z0-9\s_]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

function makeActionInventoryItem(name = "", overrides = {}) {
  return {
    name,
    targetType: "Flow",
    description: "",
    inputs: [],
    outputs: [],
    ...overrides,
  };
}

function normalizeActionInventoryItem(item) {
  if (typeof item === "string") return makeActionInventoryItem(item);
  return makeActionInventoryItem(item.name || "", item);
}

function makeTopic(id, overrides = {}) {
  const raw = {
    id,
    topicName: "",
    topicDescription: "",
    routingAndAvailability: [],
    prechecks: [],
    actionInventory: [],
    outputInstructions: [],
    actionSpecs: [],
    ...overrides,
  };
  raw.actionInventory = (raw.actionInventory || []).map(normalizeActionInventoryItem);
  return raw;
}

function renumberSubsteps(substeps, parentStep) {
  return (substeps || []).map((sub, idx) => {
    const stepNum = `${parentStep}-${idx + 1}`;
    return {
      ...sub,
      step: stepNum,
      substeps: renumberSubsteps(sub.substeps || [], stepNum),
    };
  });
}

function renumberSteps(steps, startFrom = 1) {
  return (steps || []).map((row, idx) => {
    const topStep = String(startFrom + idx);
    return {
      ...row,
      step: topStep,
      substeps: renumberSubsteps(row.substeps || [], topStep),
    };
  });
}

function migrateStep(old) {
  if (old.labels) return { ...old, step: String(old.step), substeps: (old.substeps || []).map(migrateStep) };
  return {
    step: String(old.step),
    actor: old.actor || "Agent",
    dialogue: old.dialogue || "",
    labels: annotationToLabels(old.annotation || ""),
    substeps: [],
  };
}

function makeScenario(id, type = "basic", goldenPath = [], overrides = {}) {
  const SCENARIO_NAMES = { basic: "Basic", advanced: "Advanced", tricky: "Tricky", custom: "Custom" };
  return {
    id,
    name: overrides.name || SCENARIO_NAMES[type] || "Basic",
    type,
    customPrompt: overrides.customPrompt || "",
    goldenPath: goldenPath,
    createdAt: overrides.createdAt || Date.now(),
  };
}

function migrateTopicScripts(raw) {
  if (!raw) return { scenarios: {}, activeScenarioId: null };
  if (raw.scenarios && typeof raw.scenarios === "object") {
    const migrated = {};
    for (const [k, v] of Object.entries(raw.scenarios)) {
      migrated[k] = { ...v, goldenPath: (v.goldenPath || []).map(migrateStep) };
    }
    return { scenarios: migrated, activeScenarioId: raw.activeScenarioId || Object.keys(migrated)[0] || null };
  }
  const goldenPath = (raw.goldenPath || []).map(migrateStep);
  if (goldenPath.length === 0) return { scenarios: {}, activeScenarioId: null };
  const sc = makeScenario("sc-1", "basic", goldenPath);
  return { scenarios: { "sc-1": sc }, activeScenarioId: "sc-1" };
}

function migrateTopicFields(t) {
  const migrated = { ...t };
  if (t.routingRules && !t.routingAndAvailability) {
    migrated.routingAndAvailability = t.routingRules;
  }
  delete migrated.routingRules;
  if (t.outputSchema && !t.outputInstructions) {
    migrated.outputInstructions = t.outputSchema;
  }
  delete migrated.outputSchema;
  if (!migrated.topicDescription) {
    migrated.topicDescription = "";
  }
  delete migrated.triggers;
  delete migrated.fallbacks;
  return migrated;
}

function migrateBlueprint(bp) {
  if (!bp) return bp;
  const rawTopics = bp.logicPlan?.topics || [];
  const topics = rawTopics.length > 0
    ? rawTopics.map((t, i) => makeTopic(t.id || `topic-${i + 1}`, migrateTopicFields(t)))
    : [makeTopic("topic-1")];
  const topicIds = topics.map((t, i) => t.id || `topic-${i + 1}`);

  let annotatedScriptByTopic = bp.annotatedScriptByTopic || {};
  if (Object.keys(annotatedScriptByTopic).length === 0 && bp?.annotatedScript?.goldenPath) {
    const goldenPath = (bp.annotatedScript?.goldenPath || []).map(migrateStep);
    const sc = makeScenario("sc-1", "basic", goldenPath);
    annotatedScriptByTopic = {
      [topicIds[0]]: { scenarios: { "sc-1": sc }, activeScenarioId: "sc-1" },
    };
  } else {
    const next = {};
    for (const id of topicIds) {
      next[id] = migrateTopicScripts(annotatedScriptByTopic[id]);
    }
    annotatedScriptByTopic = next;
  }

  const firstTopic = annotatedScriptByTopic[topicIds[0]] || { scenarios: {}, activeScenarioId: null };
  const firstScenario = firstTopic.scenarios?.[firstTopic.activeScenarioId] || Object.values(firstTopic.scenarios || {})[0];

  const charter = bp.charter || {};
  if (!charter.developerName) charter.developerName = "";
  if (!charter.agentType) charter.agentType = "AgentServiceAgent";
  if (!charter.channel) charter.channel = "Console";
  if (!charter.welcomeMessage) charter.welcomeMessage = "";
  if (!charter.errorMessage) charter.errorMessage = "";

  return {
    ...bp,
    charter,
    logicPlan: { ...bp.logicPlan, topics },
    annotatedScript: {
      channel: "Console",
      goldenPath: firstScenario?.goldenPath || [],
    },
    annotatedScriptByTopic,
  };
}

// -----------------------------
// Extraction (heuristic)
// -----------------------------

const PATTERNS = {
  agentRole: [/\bRole\s*[:\-]\s*(.+)$/im, /\bAgent Role Name\b[\s\S]*?\n\s*e\.g\.,?\s*[“\"]?(.+?)[”\"]?\s*$/im],
  agentName: [/\bAgent Name\s*[:\-]\s*(.+)$/im, /\bName\s*[:\-]\s*(.+)$/im],
  userGoal: [/\bUser Goal\b[\s\S]*?\n\s*e\.g\.,?\s*[“\"]?(.+?)[”\"]?\s*$/im, /\bJTBD\b[\s\S]*?\n\s*(.+)$/im],
  tone: [/\bTone\s*&\s*Voice\s*[:\-]\s*(.+)$/im, /\bSystem Instruction\s*\(Tone\)\s*[:\-]\s*(.+)$/im],
  jurisdiction: [/\bJurisdiction\b\s*[:\-]\s*(.+)$/im, /\bThe “Jurisdiction”\b[\s\S]*?\n\s*e\.g\.,?\s*[“\"]?(.+?)[”\"]?\s*$/im],
  hardStop: [/\bHard Stop\b[\s\S]*?\n\s*e\.g\.,?\s*[“\"]?(.+?)[”\"]?\s*$/im, /\bNegative Scope\b\s*[:\-]\s*(.+)$/im],
  systemObjects: [/\bSystem Objects\b[\s\S]*?\n\s*e\.g\.,?\s*(.+)$/im, /\bObjects\s*\(Data\s*\/\s*“Nouns”\)\b\s*[:\-]\s*(.+)$/im],
  actions: [/\bSystem Action\b[\s\S]*?\n\s*e\.g\.,?\s*(.+)$/im, /\bAction\s*[:\-]\s*(Get_[A-Za-z0-9_]+|[A-Za-z0-9_]+)\b/im],
  kpis: [/\bPrimary KPI\b[\s\S]*?\n\s*e\.g\.,?\s*[“\"]?(.+?)[”\"]?\s*$/im, /\bSuccess Metrics\b[\s\S]*?\n\s*e\.g\.,?\s*(.+)$/im, /\bTelemetry\b\s*[:\-]\s*(.+)$/im],
};

function extractMatches(text, regexes) {
  for (const r of regexes) {
    const m = text.match(r);
    if (m && m[1]) return norm(m[1]);
  }
  return "";
}

function extractListByKeywords(lines, keywords, max = 12) {
  // Collect bullet-like lines near keyword hits.
  const hits = [];
  const lower = lines.map((l) => l.toLowerCase());
  const keyLower = keywords.map((k) => k.toLowerCase());

  const idxs = [];
  lower.forEach((l, i) => {
    if (keyLower.some((k) => l.includes(k))) idxs.push(i);
  });

  for (const start of idxs) {
    for (let j = start + 1; j < Math.min(lines.length, start + 14); j++) {
      const line = lines[j];
      if (!line) continue;
      const isBullet = /^[-•*]|^\d+[\.)]/.test(line);
      if (isBullet) {
        const cleaned = line.replace(/^[-•*]\s*/, "").replace(/^\d+[\.)]\s*/, "");
        if (cleaned && !hits.includes(cleaned)) hits.push(cleaned);
      }
      if (/^\w+\s*[:\-]/.test(line)) break;
    }
  }

  return hits.slice(0, max);
}

function findActionLikeTokens(text) {
  // Pull probable "Verbs" (Flow/Apex/action names)
  const tokens = new Set();
  const re = /\b([A-Z][A-Za-z0-9]+_(?:[A-Z][A-Za-z0-9]+_?)+)\b/g; // e.g., Get_Case_Status
  let m;
  while ((m = re.exec(text))) tokens.add(m[1]);

  // Also accept Get_* / Update_* / Create_* / Search_*
  const re2 = /\b((?:Get|Update|Create|Search|List|Reschedule|Cancel)_[A-Za-z0-9_]+)\b/g;
  while ((m = re2.exec(text))) tokens.add(m[1]);

  return Array.from(tokens).slice(0, 20);
}

function extractNounLikeObjects(text) {
  // Common CRM-like objects: Case, Contact, Appointment etc.
  const candidates = [
    "Case",
    "Contact",
    "Account",
    "Order",
    "Appointment",
    "Task",
    "Referral",
    "CarePlan",
    "Patient",
    "Member",
    "Provider",
    "Location",
    "User",
  ];
  const found = candidates.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
  return found.slice(0, 10);
}

function extractFromText(raw) {
  const text = norm(raw);
  const lines = toLines(text);

  const agentRole = extractMatches(text, PATTERNS.agentRole);
  const agentName = extractMatches(text, PATTERNS.agentName);
  const userGoal = extractMatches(text, PATTERNS.userGoal);
  const tone = extractMatches(text, PATTERNS.tone);
  const jurisdiction = extractMatches(text, PATTERNS.jurisdiction);
  const hardStop = extractMatches(text, PATTERNS.hardStop);

  const inferredActions = findActionLikeTokens(text);
  const inferredObjects = extractNounLikeObjects(text);

  const guardrails = extractListByKeywords(lines, ["guardrail", "policy", "hard stop", "never"], 10);

  // Evidence snippets: keep short phrases that justify key fields
  const evidence = [];
  const addEvidence = (label, value) => {
    if (!value) return;
    const snip = value.length > 140 ? value.slice(0, 140) + "…" : value;
    evidence.push({ label, snippet: snip });
  };
  addEvidence("Agent Role", agentRole);
  addEvidence("Agent Name", agentName);
  addEvidence("User Goal", userGoal);
  addEvidence("Tone & Voice", tone);
  addEvidence("Jurisdiction", jurisdiction);
  addEvidence("Hard Stop", hardStop);

  const hitCount = [agentRole, agentName, userGoal, tone, jurisdiction, hardStop].filter(Boolean).length;
  const confidence = scoreConfidence(hitCount, 6);

  // Review flags
  const needsReview = {
    agentRole: !agentRole,
    agentName: !agentName,
    userGoal: !userGoal,
    tone: !tone,
    jurisdiction: !jurisdiction,
    hardStop: !hardStop,
    objects: inferredObjects.length === 0,
    actions: inferredActions.length === 0,
  };

  return {
    meta: {
      confidence,
      hitCount,
      timestamp: new Date().toISOString(),
    },
    charter: {
      agentRole,
      agentName,
      goal: userGoal,
      tone,
      jurisdiction,
      hardStop,
      systemObjects: inferredObjects,
      systemActions: inferredActions,
      guardrails,
    },
    evidence,
    needsReview,
  };
}

// -----------------------------
// Templates
// -----------------------------

const DEFAULT_BLUEPRINT = {
  charter: {
    agentRole: "",
    agentName: "",
    developerName: "",
    agentType: "AgentServiceAgent",
    channel: "Console",
    welcomeMessage: "",
    errorMessage: "",
    goal: "",
    tone: "",
    jurisdiction: "",
    hardStop: "",
    systemObjects: [],
    systemActions: [],
    guardrails: [],
  },
  logicPlan: {
    topics: [makeTopic("topic-1")],
  },
  annotatedScript: {
    channel: "Console",
    goldenPath: [],
  },
  annotatedScriptByTopic: {
    "topic-1": {
      scenarios: {},
      activeScenarioId: null,
    },
  },
};

// -----------------------------
// UI Components
// -----------------------------

function SectionTitle({ title, subtitle, right }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 pb-3">
      <div className="min-w-0">
        <div className="text-base font-semibold tracking-tight md:text-lg">{title}</div>
        {subtitle ? <div className="mt-1 text-sm leading-5 text-muted-foreground">{subtitle}</div> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

function Field({ label, required, children, hint, status }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-medium tracking-tight">{label}</div>
          {required ? <Badge variant="secondary" className="text-[10px]">Required</Badge> : null}
          {status}
        </div>
      </div>
      {children}
      {hint ? <div className="text-xs leading-5 text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function useClipboard(timeout = 2000) {
  const [copiedKey, setCopiedKey] = useState(null);
  const copy = useCallback((text, key) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), timeout);
    });
  }, [timeout]);
  return { copy, copiedKey };
}

function CopyButton({ text, label, copyKey, copiedKey, onCopy, variant = "secondary", className = "" }) {
  const isCopied = copiedKey === copyKey;
  return (
    <Button
      variant={variant}
      className={`gap-2 ${className}`}
      onClick={() => onCopy(text, copyKey)}
    >
      {isCopied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
      {isCopied ? "Copied!" : label}
    </Button>
  );
}

function ModalBackdrop({ onClose, children }) {
  const contentRef = useRef(null);

  useEffect(() => {
    const el = contentRef.current;
    if (el) el.focus();
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    const prev = document.activeElement;
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div ref={contentRef} tabIndex={-1} className="outline-none" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ open, title, description, confirmLabel = "Confirm", onConfirm, onCancel }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (el) el.focus();
    const handleKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={onCancel}>
      <Card className="w-full max-w-sm rounded-2xl" ref={dialogRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-5 space-y-4">
          <div className="text-base font-semibold">{title}</div>
          <div className="text-sm text-muted-foreground">{description}</div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button variant="destructive" className="text-white hover:text-white" onClick={onConfirm}>{confirmLabel}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PillListEditor({ value, onChange, placeholder = "Add item…", max = 50 }) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = norm(draft);
    if (!v) return;
    if (value.includes(v)) return setDraft("");
    const next = [...value, v].slice(0, max);
    onChange(next);
    setDraft("");
  };

  const remove = (i) => {
    const next = value.filter((_, idx) => idx !== i);
    onChange(next);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); add(); }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKeyDown} placeholder={placeholder} />
        <Button onClick={add} variant="secondary" className="shrink-0">Add</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {value.map((v, i) => (
          <Badge key={v + i} variant="outline" className="gap-2 py-1">
            <span className="max-w-[36ch] truncate">{v}</span>
            <button type="button" onClick={() => remove(i)} className="opacity-70 transition-opacity hover:opacity-100" aria-label={`Remove ${v}`}>×</button>
          </Badge>
        ))}
        {value.length === 0 ? <div className="text-xs text-muted-foreground">No items added yet.</div> : null}
      </div>
    </div>
  );
}

function ConfidenceBadge({ n }) {
  const variant = n >= 75 ? "default" : n >= 45 ? "secondary" : "destructive";
  return <Badge variant={variant} className="gap-1"><Sparkles className="h-3.5 w-3.5" /> {n}% confidence</Badge>;
}

function ReviewBadge({ needsReview }) {
  if (!needsReview) return <Badge className="gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Complete</Badge>;
  return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3.5 w-3.5" /> Needs review</Badge>;
}

// -----------------------------
// Settings Panel (API Key)
// -----------------------------

function SettingsPanel({ open, onClose }) {
  const [key, setKey] = useState(getApiKey());
  const [model, setMdl] = useState(getModel());
  const panelRef = useRef(null);
  const saveTimerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    const handleClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("keydown", handleKey);
    setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open, onClose]);

  const handleKeyChange = (value) => {
    setKey(value);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const trimmed = value.trim();
      if (!trimmed || /^sk-/.test(trimmed)) setApiKey(trimmed);
    }, 400);
  };

  if (!open) return null;

  return (
    <Card className="rounded-2xl absolute right-0 top-full mt-2 z-50 w-[360px] shadow-lg" ref={panelRef}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">AI settings</div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none" aria-label="Close settings">&times;</button>
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">OpenAI API Key</div>
          <Input
            type="password"
            value={key}
            onChange={(e) => handleKeyChange(e.target.value)}
            placeholder="sk-..."
          />
          {key && !/^sk-/.test(key.trim()) && (
            <div className="text-xs text-destructive">Key should start with &quot;sk-&quot;</div>
          )}
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Model</div>
          <Select value={model} onValueChange={(v) => { setMdl(v); setModel(v); }}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gpt-4o-mini">gpt-4o-mini (fast, cheap)</SelectItem>
              <SelectItem value="gpt-4o">gpt-4o (best quality)</SelectItem>
              <SelectItem value="gpt-4.1-mini">gpt-4.1-mini</SelectItem>
              <SelectItem value="gpt-4.1">gpt-4.1</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          {hasApiKey() ? (
            <Badge className="gap-1"><CheckCircle2 className="h-3 w-3" /> Key set</Badge>
          ) : (
            <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" /> No key</Badge>
          )}
          <div className="text-xs text-muted-foreground">Stored in this browser only.</div>
        </div>
      </CardContent>
    </Card>
  );
}

// -----------------------------
// Handoff Panel
// -----------------------------

const DEFINITION_OF_DONE = [
  "All Agent Charter required fields populated",
  "Topic name, description, and routing defined",
  "Every action has a fallback strategy",
  "Output instructions defined for Console channel",
  "Prompt template reviewed for tone + hard-stop alignment",
  "Golden-path acceptance test drafted",
  "Unhappy-path matrix covers at least 3 scenarios",
  "Safety tests include hard-stop enforcement + PII masking",
];

// ── Script Editor Components ──

function LabelChipEditor({ labels, onLabelsChange }) {
  const filledKeys = LABEL_KEYS.filter((k) => labels[k] !== undefined && labels[k] !== null && labels[k] !== "");
  const activeKeys = filledKeys.length > 0 ? filledKeys : [];

  const addChip = () => {
    const nextKey = LABEL_KEYS.find((k) => !labels[k]) || LABEL_KEYS[0];
    onLabelsChange({ ...labels, [nextKey]: " " });
  };

  const removeChip = (key) => {
    onLabelsChange({ ...labels, [key]: "" });
  };

  const changeType = (oldKey, newKey) => {
    if (oldKey === newKey) return;
    const val = labels[oldKey] || "";
    const merged = labels[newKey] ? labels[newKey] + "; " + val : val;
    onLabelsChange({ ...labels, [oldKey]: "", [newKey]: merged });
  };

  const changeValue = (key, val) => {
    onLabelsChange({ ...labels, [key]: val });
  };

  return (
    <div className="space-y-1.5 mt-2">
      {activeKeys.map((key) => (
        <div key={key} className="flex items-center gap-1">
          <Select value={key} onValueChange={(v) => changeType(key, v)}>
            <SelectTrigger className="h-7 w-[110px] text-[11px] font-semibold shrink-0 px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LABEL_KEYS.map((k) => (
                <SelectItem key={k} value={k} className="text-xs">{LABEL_META[k].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={labels[key]?.trim() === "" ? "" : labels[key]}
            onChange={(e) => changeValue(key, e.target.value)}
            placeholder={LABEL_META[key].hint}
            className="h-7 text-xs flex-1"
            autoFocus={labels[key]?.trim() === ""}
          />
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-destructive px-1"
            onClick={() => removeChip(key)}
            title="Remove label"
          >
            ×
          </button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 mt-1" onClick={addChip}>
        + Add Label
      </Button>
    </div>
  );
}

function ScriptStepList({ steps, onChange, depth = 0 }) {
  const updateStep = (idx, patch) => {
    onChange(steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const removeStep = (idx) => {
    onChange(steps.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step: depth === 0 ? String(i + 1) : s.step })));
  };
  const updateSubsteps = (idx, newSubs) => {
    updateStep(idx, { substeps: newSubs });
  };

  return (
    <div className="space-y-3">
      {steps.map((row, idx) => (
        <ScriptStepCard
          key={`${depth}-${idx}`}
          step={row}
          depth={depth}
          onUpdate={(patch) => updateStep(idx, patch)}
          onRemove={() => removeStep(idx)}
          onSubstepsChange={(subs) => updateSubsteps(idx, subs)}
        />
      ))}
    </div>
  );
}

function ScriptStepCard({ step, depth, onUpdate, onRemove, onSubstepsChange }) {
  const [justInjected, setJustInjected] = useState(false);
  const labels = step.labels || { ...EMPTY_LABELS };
  const prevActionRef = useRef(labels.action);

  useEffect(() => {
    const hadAction = prevActionRef.current;
    prevActionRef.current = labels.action;
    if (labels.action && !hadAction && (!step.substeps || step.substeps.length === 0)) {
      const actionName = labels.action.replace(/\s*\(.*\)/, "").trim();
      const sub = makeStep(
        `${step.step}-1`,
        "Fallback Option",
        "",
        { ...EMPTY_LABELS, failure: `${actionName} returned error or empty result`, recovery: `ask user for missing info → re-run ${actionName}` }
      );
      onSubstepsChange([sub]);
      setJustInjected(true);
      setTimeout(() => setJustInjected(false), 2500);
    }
  }, [labels.action]);

  const borderColor = depth === 0 ? "border-border" : "border-orange-300 dark:border-orange-700";
  const bgColor = depth === 0 ? "" : "bg-orange-50/50 dark:bg-orange-950/20";

  return (
    <div className={`rounded-2xl border ${borderColor} ${bgColor} p-3 ${depth > 0 ? "ml-6" : ""}`}>
      {/* Step header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold">Step {step.step}</div>
          <Select value={step.actor} onValueChange={(v) => onUpdate({ actor: v })}>
            <SelectTrigger className="w-[160px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="User">User</SelectItem>
              <SelectItem value="Agent">Agent</SelectItem>
              <SelectItem value="Fallback Option">Fallback Option</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={onRemove}>Remove</Button>
      </div>

      {/* Side-by-side: Dialogue | Logic Annotation chips */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
        <div>
          <div className="text-xs text-muted-foreground">Dialogue (Experience)</div>
          <Textarea
            value={step.dialogue}
            onChange={(e) => onUpdate({ dialogue: e.target.value })}
            placeholder="Write naturally in the channel voice."
            className="min-h-[88px] mt-2"
          />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Logic Annotation (Invisible System)</div>
          <LabelChipEditor
            labels={labels}
            onLabelsChange={(newLabels) => onUpdate({ labels: newLabels })}
          />
        </div>
      </div>

      {/* Substeps (fallback options) */}
      {(step.substeps || []).length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <span>Fallback / Sub-steps</span>
            <Badge variant="secondary" className="text-[10px] px-1">{step.substeps.length}</Badge>
            {justInjected && (
              <Badge variant="outline" className="text-[10px] px-1 text-green-600 border-green-300 animate-pulse">
                Auto-added
              </Badge>
            )}
          </div>
          <ScriptStepList
            steps={step.substeps}
            onChange={onSubstepsChange}
            depth={depth + 1}
          />
        </div>
      )}

      {/* Manual Add Fallback button */}
      {step.actor === "Agent" && depth === 0 && (
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => {
              const sub = makeStep(
                `${step.step}-${(step.substeps || []).length + 1}`,
                "Fallback Option",
                "",
                { ...EMPTY_LABELS, failure: "", recovery: "" }
              );
              onSubstepsChange([...(step.substeps || []), sub]);
            }}
          >
            + Add Fallback
          </Button>
        </div>
      )}
    </div>
  );
}

function HandoffPanel({ blueprint, setBlueprint, onAiReview, aiReview, reviewLoading, onAiOptimize, optimizeLoading, pristine, prdContent, onGeneratePRD, prdLoading, selectedTopicId, onSelectTopic }) {
  const lint = useMemo(() => lintHandoff(blueprint), [blueprint]);
  const pkg = useMemo(() => buildAgentHandoffPackage(blueprint), [blueprint]);
  const prompt = useMemo(() => buildPromptTemplate(blueprint), [blueprint]);
  const agentScript = useMemo(() => buildAgentScript(blueprint), [blueprint]);
  const pkgJson = useMemo(() => safeJson(pkg), [pkg]);
  const promptTopicSections = useMemo(() => extractTopicSections(prompt), [prompt]);
  const prdTopicSections = useMemo(() => extractTopicSections(prdContent), [prdContent]);
  const [handoffStep, setHandoffStep] = useState("validate");
  const { copy: clipCopy, copiedKey } = useClipboard();

  const overallStatus = pristine
    ? "neutral"
    : lint.errors.length > 0 ? "red" : lint.warnings.length > 0 ? "yellow" : "green";
  const visibleErrorCount = pristine ? 0 : lint.errors.length;
  const visibleWarningCount = pristine ? 0 : lint.warnings.length;

  const statusBadge =
    overallStatus === "neutral" ? (
      <Badge variant="outline" className="gap-1 text-muted-foreground">Not started</Badge>
    ) : overallStatus === "green" ? (
      <Badge className="gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Ready</Badge>
    ) : overallStatus === "yellow" ? (
      <Badge variant="secondary" className="gap-1"><AlertCircle className="h-3.5 w-3.5" /> Warnings</Badge>
    ) : (
      <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3.5 w-3.5" /> Errors</Badge>
    );

  const topics = blueprint.logicPlan?.topics || [];
  const activeTopic = topics.find((t) => t.id === selectedTopicId) || topics[0] || makeTopic("topic-1");
  const specs = activeTopic.actionSpecs || [];
  const allSpecs = topics.flatMap((t) => t.actionSpecs || []);
  const missingFallbackCount = allSpecs.filter((s) => !norm(s.fallback)).length;
  const missingTargetCount = allSpecs.filter((s) => {
    if (s.implType === "Apex") return !norm(s.apexClass);
    if (s.implType === "Prompt Template") return !norm(s.promptTemplateId);
    return !norm(s.flowApiName);
  }).length;
  const missingSpecDescriptionCount = allSpecs.filter((s) => !norm(s.description)).length;
  const allSpecsReady = allSpecs.length > 0 && missingFallbackCount === 0 && missingTargetCount === 0;

  const lintByCategory = useMemo(() => {
    const categorize = (message) => {
      if (
        /Missing required field|Developer Name|Welcome Message|Error Message|guardrail|System Objects|System Actions/i.test(message)
      ) return "Charter";
      if (/Action Specs|Action \"|fallback|Flow API Name|Apex Class|Prompt Template ID/i.test(message)) return "Action Specs";
      if (/Step \d|No telemetry labels|No scenarios defined|golden_path|script/i.test(message)) return "Script";
      if (/Topic/i.test(message)) return "Topics";
      return "General";
    };
    const grouped = {
      Charter: [],
      Topics: [],
      "Action Specs": [],
      Script: [],
      General: [],
    };
    for (const e of lint.errors) grouped[categorize(e)].push({ message: e, severity: "error" });
    for (const w of lint.warnings) grouped[categorize(w)].push({ message: w, severity: "warning" });
    return grouped;
  }, [lint]);

  const categoryFixHint = (category) => {
    if (category === "Charter") return "Fix in Agent Charter tab.";
    if (category === "Topics") return "Fix in Agent Topics tab.";
    if (category === "Action Specs") return "Fix in Handoff > Fix Action Specs.";
    if (category === "Script") return "Fix in Script Matrix tab.";
    return "Review related fields and update where needed.";
  };

  const stepMeta = [
    { id: "validate", label: "1. Validate" },
    { id: "fix", label: "2. Fix Action Specs" },
    { id: "export", label: "3. Review & Export" },
  ];

  const updateSpec = (idx, patch) => {
    setBlueprint((p) => {
      const newSpecs = (activeTopic.actionSpecs || []).map((s, i) =>
        i === idx ? { ...s, ...patch } : s
      );
      return {
        ...p,
        logicPlan: {
          ...p.logicPlan,
          topics: (p.logicPlan?.topics || []).map((t) =>
            t.id === activeTopic.id ? { ...t, actionSpecs: newSpecs } : t
          ),
        },
      };
    });
  };

  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4 space-y-4">
        <SectionTitle
          title="Handoff Package"
          subtitle="Follow a guided workflow: validate readiness, complete action specs, then review and export artifacts."
          right={statusBadge}
        />

        <div className="rounded-xl border p-3 md:p-4 space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="text-sm font-medium">Progress summary</div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={visibleErrorCount > 0 ? "destructive" : "outline"} className="gap-1">
                <AlertCircle className="h-3 w-3" /> {visibleErrorCount} errors
              </Badge>
              <Badge variant={visibleWarningCount > 0 ? "secondary" : "outline"} className="gap-1">
                <AlertCircle className="h-3 w-3" /> {visibleWarningCount} warnings
              </Badge>
              <Badge variant={pristine ? "outline" : allSpecsReady ? "default" : "secondary"} className="gap-1">
                <Package className="h-3 w-3" /> {pristine ? "Not started" : allSpecsReady ? "Action specs ready" : "Action specs need attention"}
              </Badge>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Recommended order: start with validation, resolve action spec gaps, then export final artifacts.
          </div>
        </div>

        <Tabs value={handoffStep} onValueChange={setHandoffStep} className="space-y-4">
          <TabsList className="w-full justify-start">
            {stepMeta.map((s) => (
              <TabsTrigger key={s.id} value={s.id} className="gap-1.5">
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="validate" className="space-y-4">
            <div className="space-y-3">
              <div className="text-sm font-semibold flex items-center gap-2">
                <ClipboardCheck className="h-4 w-4" /> Validation overview
              </div>

              {pristine ? (
                <div className="flex items-center gap-2 p-3 rounded-xl border border-dashed">
                  <div className="text-sm text-muted-foreground">
                    Complete charter, topics, and script fields to see readiness checks.
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="rounded-xl border p-3">
                    <div className="text-xs text-muted-foreground">Errors</div>
                    <div className="text-xl font-semibold mt-1">{lint.errors.length}</div>
                  </div>
                  <div className="rounded-xl border p-3">
                    <div className="text-xs text-muted-foreground">Warnings</div>
                    <div className="text-xl font-semibold mt-1">{lint.warnings.length}</div>
                  </div>
                  <div className="rounded-xl border p-3">
                    <div className="text-xs text-muted-foreground">Readiness</div>
                    <div className="text-xl font-semibold mt-1">
                      {lint.errors.length > 0 ? "Needs attention" : lint.warnings.length > 0 ? "Almost ready" : "Ready"}
                    </div>
                  </div>
                </div>
              )}

              {!pristine && (
                <div className="space-y-2">
                  {Object.entries(lintByCategory).map(([category, issues]) => {
                    if (issues.length === 0) return null;
                    return (
                      <details key={category} className="rounded-xl border bg-background" open={category === "Action Specs" || category === "Charter"}>
                        <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium flex items-center justify-between">
                          <span>{category}</span>
                          <span className="text-xs text-muted-foreground">{issues.length} issues</span>
                        </summary>
                        <div className="px-3 pb-3 space-y-2">
                          <div className="text-xs text-muted-foreground">{categoryFixHint(category)}</div>
                          {issues.map((item, i) => (
                            <div
                              key={`${category}-${i}`}
                              className={`flex items-start gap-2 rounded-lg border p-2 ${item.severity === "error" ? "border-destructive/30 bg-destructive/5" : "border-yellow-400/30 bg-yellow-400/5"}`}
                            >
                              <AlertCircle className={`h-4 w-4 shrink-0 mt-0.5 ${item.severity === "error" ? "text-destructive" : "text-yellow-600 dark:text-yellow-400"}`} />
                              <div className="text-sm">{item.message}</div>
                            </div>
                          ))}
                        </div>
                      </details>
                    );
                  })}

                  {lint.errors.length === 0 && lint.warnings.length === 0 && (
                    <div className="flex items-center gap-2 p-3 rounded-xl border bg-green-500/5 border-green-500/30">
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                      <div className="text-sm">All checks passed.</div>
                    </div>
                  )}
                </div>
              )}

              <Separator />

              <div className="text-xs font-medium text-muted-foreground">Definition of done</div>
              <div className="space-y-1">
                {DEFINITION_OF_DONE.map((item, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="text-xs text-muted-foreground mt-0.5">☐</div>
                    <div className="text-xs text-muted-foreground">{item}</div>
                  </div>
                ))}
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="text-sm font-semibold">AI quality review</div>
                <Button
                  variant="secondary"
                  className="gap-2 w-full md:w-auto"
                  onClick={onAiReview}
                  disabled={reviewLoading}
                >
                  {reviewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" />}
                  Run AI review
                </Button>

                {aiReview && (
                  <div className="space-y-2 p-3 rounded-xl border bg-background">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold">AI review</div>
                      <Badge variant={aiReview.score >= 80 ? "default" : aiReview.score >= 60 ? "secondary" : "destructive"} className="gap-1">
                        <Star className="h-3 w-3" /> {aiReview.score}/100
                      </Badge>
                    </div>
                    {aiReview.summary && <div className="text-xs text-muted-foreground">{aiReview.summary}</div>}

                    {aiReview.strengths?.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-green-600">Strengths</div>
                        {aiReview.strengths.map((s, i) => (
                          <div key={i} className="flex items-start gap-1.5">
                            <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0 mt-0.5" />
                            <div className="text-xs">{s}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {aiReview.suggestions?.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-yellow-600 dark:text-yellow-400">Suggestions</div>
                        {aiReview.suggestions.map((s, i) => (
                          <div key={i} className="flex items-start gap-1.5">
                            <AlertCircle className="h-3 w-3 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
                            <div className="text-xs">{s}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {aiReview.missingItems?.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-destructive">Missing items</div>
                        {aiReview.missingItems.map((s, i) => (
                          <div key={i} className="flex items-start gap-1.5">
                            <AlertCircle className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
                            <div className="text-xs">{s}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {aiReview && !aiReview._optimized && (
                  <Button
                    variant="secondary"
                    className="gap-2 w-full md:w-auto"
                    onClick={onAiOptimize}
                    disabled={optimizeLoading}
                  >
                    {optimizeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                    Apply AI improvements
                  </Button>
                )}

                {aiReview?._optimized && (
                  <div className="flex items-center gap-2 p-3 rounded-xl border bg-green-500/5 border-green-500/30">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <div className="text-sm">AI improvements applied. Checklist and exports are updated.</div>
                  </div>
                )}
              </div>

              <div className="pt-1">
                <Button variant="outline" onClick={() => setHandoffStep("fix")} className="gap-2">
                  Continue to Fix Action Specs
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="fix" className="space-y-4">
            <div className="space-y-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="text-sm font-semibold">Action specs</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Pick a topic and resolve missing implementation details, inputs/outputs, and fallback strategy.
                  </div>
                </div>
                <Select value={activeTopic.id} onValueChange={onSelectTopic}>
                  <SelectTrigger className="h-8 w-[230px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {topics.map((t) => (
                      <SelectItem key={t.id} value={t.id} className="text-xs">
                        {t.topicName || t.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-xl border p-3">
                  <div className="text-xs text-muted-foreground">Missing fallback</div>
                  <div className="text-xl font-semibold mt-1">{missingFallbackCount}</div>
                </div>
                <div className="rounded-xl border p-3">
                  <div className="text-xs text-muted-foreground">Missing implementation target</div>
                  <div className="text-xl font-semibold mt-1">{missingTargetCount}</div>
                </div>
                <div className="rounded-xl border p-3">
                  <div className="text-xs text-muted-foreground">Missing description</div>
                  <div className="text-xl font-semibold mt-1">{missingSpecDescriptionCount}</div>
                </div>
              </div>

              {specs.length === 0 && (
                <div className="text-sm text-muted-foreground p-3 rounded-xl border border-dashed">
                  No action specs found for this topic. Add actions in Charter or Agent Topics, then return here.
                </div>
              )}

              <ScrollArea className="h-[700px]">
                <div className="space-y-3 pr-3">
                  {specs.map((spec, idx) => (
                    <details key={`${spec.name || "action"}-${idx}`} className="rounded-xl border bg-background" open={idx === 0}>
                      <summary className="cursor-pointer select-none px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-semibold truncate">{spec.name || `Action ${idx + 1}`}</div>
                          <div className="flex items-center gap-1.5">
                            {!norm(spec.fallback) && (
                              <Badge variant="destructive" className="gap-1 text-[10px]">
                                <AlertCircle className="h-3 w-3" /> Missing fallback
                              </Badge>
                            )}
                            <Badge variant="outline" className="text-[10px] px-1.5">{spec.implType}</Badge>
                          </div>
                        </div>
                      </summary>
                      <div className="px-3 pb-3 space-y-3">
                        <div className="rounded-lg bg-muted/40 p-2 space-y-1.5">
                          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Context from topic inventory</div>
                          <div className="text-xs text-muted-foreground">
                            Use this context as guidance, then complete deployment-ready fields below.
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <div className="text-xs text-muted-foreground">Implementation type</div>
                            <Select
                              value={spec.implType}
                              onValueChange={(v) => updateSpec(idx, { implType: v })}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Flow">Flow</SelectItem>
                                <SelectItem value="Apex">Apex</SelectItem>
                                <SelectItem value="Prompt Template">Prompt Template</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs text-muted-foreground">
                              {spec.implType === "Flow" ? "Flow API name" : spec.implType === "Apex" ? "Apex class" : "Prompt template ID"}
                            </div>
                            <Input
                              className="h-8 text-xs"
                              value={spec.implType === "Flow" ? (spec.flowApiName || "") : spec.implType === "Apex" ? (spec.apexClass || "") : (spec.promptTemplateId || "")}
                              onChange={(e) =>
                                updateSpec(idx, spec.implType === "Flow"
                                  ? { flowApiName: e.target.value }
                                  : spec.implType === "Apex"
                                    ? { apexClass: e.target.value }
                                    : { promptTemplateId: e.target.value }
                                )
                              }
                              placeholder={spec.implType === "Flow" ? "e.g., Get_Case_Status" : spec.implType === "Apex" ? "e.g., CaseStatusHandler" : "e.g., Summarize_Case_Notes"}
                            />
                          </div>
                        </div>

                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">Description</div>
                          <Input
                            className="h-8 text-xs"
                            value={spec.description || ""}
                            onChange={(e) => updateSpec(idx, { description: e.target.value })}
                            placeholder="What this action does and when to use it"
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">Required inputs</div>
                          <PillListEditor
                            value={spec.requiredInputs || []}
                            onChange={(v) => updateSpec(idx, { requiredInputs: v })}
                            placeholder="e.g., CaseId: Id"
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">Optional inputs</div>
                          <PillListEditor
                            value={spec.optionalInputs || []}
                            onChange={(v) => updateSpec(idx, { optionalInputs: v })}
                            placeholder="e.g., IncludeHistory: Boolean"
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">Outputs</div>
                          <PillListEditor
                            value={spec.outputs || []}
                            onChange={(v) => updateSpec(idx, { outputs: v })}
                            placeholder="e.g., case_status: string"
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">Error modes</div>
                          <PillListEditor
                            value={spec.errorModes || []}
                            onChange={(v) => updateSpec(idx, { errorModes: v })}
                            placeholder="e.g., timeout"
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">
                            Fallback strategy <span className="text-destructive">*</span>
                          </div>
                          <Textarea
                            className={`min-h-[72px] text-xs ${!spec.fallback ? "border-destructive" : ""}`}
                            value={spec.fallback || ""}
                            onChange={(e) => updateSpec(idx, { fallback: e.target.value })}
                            placeholder="Required: missing input -> ask one question; tool error -> retry once then hand off"
                          />
                        </div>
                      </div>
                    </details>
                  ))}
                </div>
              </ScrollArea>

              <div className="pt-1">
                <Button variant="outline" onClick={() => setHandoffStep("export")} className="gap-2">
                  Continue to Review & Export
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="export" className="space-y-4">
            <div className="space-y-4">
              <div className="text-sm font-semibold">Review and export</div>

              <div className="rounded-xl border p-3 space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Generate</div>
                <Button
                  variant="secondary"
                  className="gap-2 w-full md:w-auto"
                  onClick={onGeneratePRD}
                  disabled={prdLoading}
                >
                  {prdLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                  Generate PRD
                </Button>
              </div>

              <div className="rounded-xl border p-3 space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Copy</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  <CopyButton text={pkgJson} label="Copy JSON" copyKey="json" copiedKey={copiedKey} onCopy={clipCopy} />
                  <CopyButton text={prompt} label="Copy Prompt" copyKey="prompt" copiedKey={copiedKey} onCopy={clipCopy} />
                  <CopyButton text={agentScript} label="Copy Script" copyKey="script" copiedKey={copiedKey} onCopy={clipCopy} />
                  {prdContent && (
                    <CopyButton text={prdContent} label="Copy PRD" copyKey="prd" copiedKey={copiedKey} onCopy={clipCopy} />
                  )}
                </div>
              </div>

              <div className="rounded-xl border p-3 space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Download</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  <Button
                    variant="outline"
                    className="gap-2"
                    onClick={() => downloadFile(pkgJson, "agent-handoff-bundle.json", "application/json")}
                  >
                    <Download className="h-4 w-4" /> Download JSON
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2"
                    onClick={() => downloadFile(prompt, "prompt-template.md", "text/markdown")}
                  >
                    <Download className="h-4 w-4" /> Download Prompt
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2"
                    onClick={() => downloadFile(agentScript, `${blueprint.charter?.developerName || "agent"}.agent-blueprint.yaml`, "text/plain")}
                  >
                    <Download className="h-4 w-4" /> Download Blueprint YAML
                  </Button>
                  {prdContent && (
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={() => downloadFile(prdContent, "agent-prd.md", "text/markdown")}
                    >
                      <Download className="h-4 w-4" /> Download PRD
                    </Button>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <details className="rounded-xl border bg-background" open>
                  <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                    Agent Handoff Bundle (JSON)
                  </summary>
                  <ScrollArea className="h-[280px] border-t">
                    <pre className="p-3 text-xs leading-5 whitespace-pre-wrap">{pkgJson}</pre>
                  </ScrollArea>
                </details>

                {Array.isArray(pkg.topics) && pkg.topics.length > 0 && (
                  <details className="rounded-xl border bg-background">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                      Topic breakdown (JSON)
                    </summary>
                    <ScrollArea className="h-[260px] border-t">
                      <div className="p-2 space-y-2">
                        {pkg.topics.map((t, i) => (
                          <details key={t.topic_id || i} className="rounded-lg border bg-background" open={i === 0}>
                            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                              {(t.topic_configuration?.topic_name || t.topic_id || `Topic ${i + 1}`)}
                            </summary>
                            <pre className="px-3 pb-3 text-xs leading-5 whitespace-pre-wrap">
                              {safeJson(t)}
                            </pre>
                          </details>
                        ))}
                      </div>
                    </ScrollArea>
                  </details>
                )}

                <details className="rounded-xl border bg-background">
                  <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                    Agent Blueprint YAML (reference only)
                  </summary>
                  <ScrollArea className="h-[280px] border-t">
                    <pre className="p-3 text-xs leading-5 whitespace-pre-wrap">{agentScript}</pre>
                  </ScrollArea>
                </details>

                <details className="rounded-xl border bg-background">
                  <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                    Prompt template
                  </summary>
                  <ScrollArea className="h-[280px] border-t">
                    <pre className="p-3 text-xs leading-5 whitespace-pre-wrap">{prompt}</pre>
                  </ScrollArea>
                </details>

                {promptTopicSections.length > 0 && (
                  <details className="rounded-xl border bg-background">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                      Prompt by topic
                    </summary>
                    <ScrollArea className="h-[260px] border-t">
                      <div className="p-2 space-y-2">
                        {promptTopicSections.map((section, i) => (
                          <details key={`${section.title}-${i}`} className="rounded-lg border bg-background" open={i === 0}>
                            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                              {section.title}
                            </summary>
                            <pre className="px-3 pb-3 text-xs leading-5 whitespace-pre-wrap">
                              {section.content}
                            </pre>
                          </details>
                        ))}
                      </div>
                    </ScrollArea>
                  </details>
                )}

                {prdContent && (
                  <details className="rounded-xl border bg-background">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                      Product Requirements Document (PRD)
                    </summary>
                    <ScrollArea className="h-[280px] border-t">
                      <pre className="p-3 text-xs leading-5 whitespace-pre-wrap">{prdContent}</pre>
                    </ScrollArea>
                  </details>
                )}

                {prdContent && prdTopicSections.length > 0 && (
                  <details className="rounded-xl border bg-background">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                      PRD by topic
                    </summary>
                    <ScrollArea className="h-[260px] border-t">
                      <div className="p-2 space-y-2">
                        {prdTopicSections.map((section, i) => (
                          <details key={`${section.title}-${i}`} className="rounded-lg border bg-background" open={i === 0}>
                            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                              {section.title}
                            </summary>
                            <pre className="px-3 pb-3 text-xs leading-5 whitespace-pre-wrap">
                              {section.content}
                            </pre>
                          </details>
                        ))}
                      </div>
                    </ScrollArea>
                  </details>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// -----------------------------
// Main App
// -----------------------------

export default function AgentBlueprintAutofillPrototype() {
  const fileRef = useRef(null);
  const [sourceText, setSourceText] = useState("");
  const [blueprint, setBlueprint] = useState(DEFAULT_BLUEPRINT);
  const [extraction, setExtraction] = useState(null);
  const [autoSync, setAutoSync] = useState(true);

  // AI / LLM state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llmLoading, setLlmLoading] = useState({ extraction: false, logic: false, script: false, review: false, optimize: false, prd: false });
  const [llmError, setLlmError] = useState("");
  const [aiReview, setAiReview] = useState(null);
  const [prdContent, setPrdContent] = useState("");
  const [selectedTopicId, setSelectedTopicId] = useState("topic-1");
  const [scriptContinuation, setScriptContinuation] = useState({
    show: false,
    hint: "",
    messages: [],
    topLevelCount: 0,
  });
  const [scenarioModal, setScenarioModal] = useState({ open: false, type: "basic", customPrompt: "" });
  const [lastSaved, setLastSaved] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [saveError, setSaveError] = useState("");
  const { copy: mainClipCopy, copiedKey: mainCopiedKey } = useClipboard();

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY) || localStorage.getItem(LEGACY_AUTOSAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.charter) {
          setBlueprint(migrateBlueprint(parsed));
          localStorage.setItem(AUTOSAVE_KEY, raw);
        }
      }
    } catch {}
  }, []);

  // Auto-save to localStorage (debounced 500ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(blueprint));
        setLastSaved(new Date());
        setSaveError("");
      } catch (err) {
        setSaveError("Auto-save failed — export your data to avoid losing work.");
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [blueprint]);

  const topics = blueprint.logicPlan?.topics || [];
  const activeTopicId = topics.some((t) => t.id === selectedTopicId)
    ? selectedTopicId
    : (topics[0]?.id || "topic-1");
  const activeTopic = topics.find((t) => t.id === activeTopicId) || makeTopic(activeTopicId);
  const topicScripts = blueprint.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
  const activeScenarioId = topicScripts.activeScenarioId || Object.keys(topicScripts.scenarios || {})[0] || null;
  const activeScenario = activeScenarioId ? (topicScripts.scenarios?.[activeScenarioId] || null) : null;
  const activeGoldenPath = activeScenario?.goldenPath || [];

  const setActiveScenarioId = (scenarioId) => {
    setBlueprint((p) => {
      const topicEntry = p.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
      return {
        ...p,
        annotatedScriptByTopic: {
          ...(p.annotatedScriptByTopic || {}),
          [activeTopicId]: { ...topicEntry, activeScenarioId: scenarioId },
        },
      };
    });
  };

  const updateTopicById = (topicId, patchOrUpdater) => {
    setBlueprint((p) => {
      const nextTopics = (p.logicPlan?.topics || []).map((t) => {
        if (t.id !== topicId) return t;
        if (typeof patchOrUpdater === "function") return patchOrUpdater(t);
        return { ...t, ...patchOrUpdater };
      });
      return { ...p, logicPlan: { ...p.logicPlan, topics: nextTopics } };
    });
  };

  const updateActiveScenario = (patchOrUpdater) => {
    if (!activeScenarioId) return;
    setBlueprint((p) => {
      const topicEntry = p.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
      const prev = topicEntry.scenarios?.[activeScenarioId] || makeScenario(activeScenarioId);
      const next = typeof patchOrUpdater === "function" ? patchOrUpdater(prev) : { ...prev, ...patchOrUpdater };
      const updatedScenarios = { ...topicEntry.scenarios, [activeScenarioId]: next };
      const firstScId = topicEntry.activeScenarioId || Object.keys(updatedScenarios)[0];
      const firstSc = updatedScenarios[firstScId];
      return {
        ...p,
        annotatedScriptByTopic: {
          ...(p.annotatedScriptByTopic || {}),
          [activeTopicId]: { ...topicEntry, scenarios: updatedScenarios },
        },
        annotatedScript: activeTopicId === (p.logicPlan?.topics?.[0]?.id || "topic-1")
          ? { channel: "Console", goldenPath: firstSc?.goldenPath || [] }
          : p.annotatedScript,
      };
    });
  };

  const addScenario = (type, customPrompt = "") => {
    const scId = `sc-${Date.now()}`;
    const sc = makeScenario(scId, type, [], { customPrompt });
    setBlueprint((p) => {
      const topicEntry = p.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
      return {
        ...p,
        annotatedScriptByTopic: {
          ...(p.annotatedScriptByTopic || {}),
          [activeTopicId]: {
            scenarios: { ...topicEntry.scenarios, [scId]: sc },
            activeScenarioId: scId,
          },
        },
      };
    });
    return scId;
  };

  const removeScenario = (scId) => {
    setBlueprint((p) => {
      const topicEntry = p.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
      const next = { ...topicEntry.scenarios };
      delete next[scId];
      const newActive = topicEntry.activeScenarioId === scId
        ? (Object.keys(next)[0] || null)
        : topicEntry.activeScenarioId;
      return {
        ...p,
        annotatedScriptByTopic: {
          ...(p.annotatedScriptByTopic || {}),
          [activeTopicId]: { scenarios: next, activeScenarioId: newActive },
        },
      };
    });
  };

  const renameScenario = (scId, newName) => {
    setBlueprint((p) => {
      const topicEntry = p.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
      const sc = topicEntry.scenarios?.[scId];
      if (!sc) return p;
      return {
        ...p,
        annotatedScriptByTopic: {
          ...(p.annotatedScriptByTopic || {}),
          [activeTopicId]: {
            ...topicEntry,
            scenarios: { ...topicEntry.scenarios, [scId]: { ...sc, name: newName } },
          },
        },
      };
    });
  };

  const derived = useMemo(() => {
    if (!sourceText) return null;
    return extractFromText(sourceText);
  }, [sourceText]);

  const applyPrefill = () => {
    if (!derived) return;
    const c = derived.charter;
    setBlueprint((prev) => ({
      ...prev,
      charter: {
        ...prev.charter,
        agentRole: firstNonEmpty(c.agentRole, prev.charter.agentRole),
        agentName: firstNonEmpty(c.agentName, prev.charter.agentName),
        goal: firstNonEmpty(c.goal, prev.charter.goal),
        tone: firstNonEmpty(c.tone, prev.charter.tone),
        jurisdiction: firstNonEmpty(c.jurisdiction, prev.charter.jurisdiction),
        hardStop: firstNonEmpty(c.hardStop, prev.charter.hardStop),
        systemObjects: c.systemObjects?.length ? c.systemObjects : prev.charter.systemObjects,
        systemActions: c.systemActions?.length ? c.systemActions : prev.charter.systemActions,
        guardrails: c.guardrails?.length ? c.guardrails : prev.charter.guardrails,
      },
    }));
    setExtraction(derived);
  };

  // Auto-sync on change
  React.useEffect(() => {
    if (!autoSync) return;
    if (!derived) return;
    applyPrefill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSync, derived?.meta?.timestamp]);

  // Live-sync actionSpecs from systemActions + actionInventory
  useEffect(() => {
    const charterActions = blueprint.charter.systemActions || [];
    const inventoryItems = activeTopic.actionInventory || [];
    const inventoryNames = inventoryItems.map((a) => a.name).filter(Boolean);
    const allActions = [...new Set([...charterActions, ...inventoryNames])];
    const existing = activeTopic.actionSpecs || [];

    const existingMap = new Map(existing.map((s) => [s.name, s]));
    const inventoryMap = new Map(inventoryItems.map((a) => [a.name, a]));
    const synced = allActions.map((name) => {
      const prev = existingMap.get(name) || {};
      const inv = inventoryMap.get(name);
      return {
        ...defaultActionSpec(name),
        ...prev,
        ...(inv && {
          implType: inv.targetType || prev.implType || "Flow",
          description: inv.description || prev.description || "",
          requiredInputs: inv.inputs?.length ? inv.inputs : prev.requiredInputs || [],
          outputs: inv.outputs?.length ? inv.outputs : prev.outputs || [],
        }),
      };
    });

    const changed =
      synced.length !== existing.length ||
      synced.some((s, i) => {
        const e = existing[i];
        if (!e || s.name !== e.name) return true;
        if (s.implType !== e.implType) return true;
        if (s.description !== e.description) return true;
        if (JSON.stringify(s.requiredInputs) !== JSON.stringify(e.requiredInputs)) return true;
        if (JSON.stringify(s.outputs) !== JSON.stringify(e.outputs)) return true;
        return false;
      });
    if (!changed) return;

    updateTopicById(activeTopicId, { actionSpecs: synced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    blueprint.charter.systemActions,
    activeTopic.actionInventory,
    activeTopicId,
  ]);

  const onPickFile = async (file) => {
    if (!file) return;
    if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pages.push(content.items.map((item) => item.str).join(" "));
        }
        setSourceText(pages.join("\n\n"));
      } catch (err) {
        setLlmError("Failed to read PDF: " + err.message);
      }
    } else {
      const text = await file.text();
      setSourceText(text);
    }
  };

  const executeReset = () => {
    setSourceText("");
    setBlueprint(DEFAULT_BLUEPRINT);
    setSelectedTopicId("topic-1");
    setExtraction(null);
    setAiReview(null);
    setPrdContent("");
    setScriptContinuation({ show: false, hint: "", messages: [], topLevelCount: 0 });
    setScenarioModal({ open: false, type: "basic", customPrompt: "" });
    setLlmError("");
    setSaveError("");
    setConfirmReset(false);
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
      localStorage.removeItem(LEGACY_AUTOSAVE_KEY);
    } catch {}
  };

  const resetAll = () => setConfirmReset(true);

  // ── AI Handlers ──
  const handleAiExtract = async () => {
    if (!sourceText) return;
    if (!hasApiKey()) { setSettingsOpen(true); return; }
    setLlmLoading((s) => ({ ...s, extraction: true }));
    setLlmError("");
    try {
      const c = await extractWithLLM(sourceText);
      setBlueprint((prev) => ({
        ...prev,
        charter: {
          ...prev.charter,
          agentRole: c.agentRole || prev.charter.agentRole,
          agentName: c.agentName || prev.charter.agentName,
          goal: c.goal || prev.charter.goal,
          tone: c.tone || prev.charter.tone,
          jurisdiction: c.jurisdiction || prev.charter.jurisdiction,
          hardStop: c.hardStop || prev.charter.hardStop,
          systemObjects: c.systemObjects?.length ? c.systemObjects : prev.charter.systemObjects,
          systemActions: c.systemActions?.length ? c.systemActions : prev.charter.systemActions,
          guardrails: c.guardrails?.length ? c.guardrails : prev.charter.guardrails,
        },
      }));
    } catch (err) {
      setLlmError(err.message);
    } finally {
      setLlmLoading((s) => ({ ...s, extraction: false }));
    }
  };

  const handleAiLogic = async () => {
    if (!hasApiKey()) { setSettingsOpen(true); return; }
    setLlmLoading((s) => ({ ...s, logic: true }));
    setLlmError("");
    try {
      const plan = await llmGenerateLogicPlan(blueprint.charter, activeTopic);
      updateTopicById(activeTopicId, (t) => ({
        ...t,
        topicName: plan.topicName || t.topicName,
        topicDescription: plan.topicDescription || t.topicDescription,
        routingAndAvailability: plan.routingAndAvailability?.length ? plan.routingAndAvailability : t.routingAndAvailability,
        prechecks: plan.prechecks?.length ? plan.prechecks : t.prechecks,
        actionInventory: plan.actionInventory?.length
          ? plan.actionInventory.map(normalizeActionInventoryItem)
          : t.actionInventory,
        outputInstructions: plan.outputInstructions?.length ? plan.outputInstructions : t.outputInstructions,
      }));
    } catch (err) {
      setLlmError(err.message);
    } finally {
      setLlmLoading((s) => ({ ...s, logic: false }));
    }
  };

  const handleAiScript = async (scenarioType = "basic", customPrompt = "") => {
    if (!hasApiKey()) { setSettingsOpen(true); return; }
    setLlmLoading((s) => ({ ...s, script: true }));
    setLlmError("");
    try {
      const scId = addScenario(scenarioType, customPrompt);
      const out = await llmGenerateScript(blueprint.charter, activeTopic, scenarioType, customPrompt);
      const goldenPath = renumberSteps((out.steps || []).map(migrateStep), 1);
      setBlueprint((p) => {
        const topicEntry = p.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
        const sc = topicEntry.scenarios?.[scId];
        if (!sc) return p;
        return {
          ...p,
          annotatedScriptByTopic: {
            ...(p.annotatedScriptByTopic || {}),
            [activeTopicId]: {
              ...topicEntry,
              scenarios: { ...topicEntry.scenarios, [scId]: { ...sc, goldenPath } },
              activeScenarioId: scId,
            },
          },
        };
      });
      if (out.hasMore) {
        setScriptContinuation({
          show: true,
          hint: out.continuationHint || "",
          messages: out.messages || [],
          topLevelCount: goldenPath.length,
          scenarioId: scId,
        });
      } else {
        setScriptContinuation({ show: false, hint: "", messages: [], topLevelCount: 0 });
      }
    } catch (err) {
      setLlmError(err.message);
    } finally {
      setLlmLoading((s) => ({ ...s, script: false }));
    }
  };

  const handleContinueScript = async () => {
    if (!hasApiKey()) { setSettingsOpen(true); return; }
    if (!scriptContinuation.messages?.length) return;
    setLlmLoading((s) => ({ ...s, script: true }));
    setLlmError("");
    try {
      const existing = activeGoldenPath;
      const out = await llmContinueScript(
        scriptContinuation.messages,
        existing,
        scriptContinuation.hint
      );
      const appended = renumberSteps((out.steps || []).map(migrateStep), existing.length + 1);
      const merged = [...existing, ...appended];
      updateActiveScenario({ goldenPath: merged });
      if (out.hasMore) {
        setScriptContinuation({
          show: true,
          hint: out.continuationHint || "",
          messages: out.messages || scriptContinuation.messages,
          topLevelCount: merged.length,
        });
      } else {
        setScriptContinuation({ show: false, hint: "", messages: [], topLevelCount: 0 });
      }
    } catch (err) {
      setLlmError(err.message);
    } finally {
      setLlmLoading((s) => ({ ...s, script: false }));
    }
  };

  const handleAiReview = async () => {
    if (!hasApiKey()) { setSettingsOpen(true); return; }
    setLlmLoading((s) => ({ ...s, review: true }));
    setLlmError("");
    try {
      const review = await llmReviewBlueprint(blueprint);
      setAiReview(review);
    } catch (err) {
      setLlmError(err.message);
    } finally {
      setLlmLoading((s) => ({ ...s, review: false }));
    }
  };

  const handleAiOptimize = async () => {
    if (!hasApiKey()) { setSettingsOpen(true); return; }
    if (!aiReview) return;
    setLlmLoading((s) => ({ ...s, optimize: true }));
    setLlmError("");
    try {
      const optimized = await llmOptimizeBlueprint(blueprint, aiReview);
      setBlueprint(optimized);
      setAiReview((prev) => prev ? { ...prev, _optimized: true } : prev);
    } catch (err) {
      setLlmError(err.message);
    } finally {
      setLlmLoading((s) => ({ ...s, optimize: false }));
    }
  };

  const handleGeneratePRD = async () => {
    if (!hasApiKey()) { setSettingsOpen(true); return; }
    setLlmLoading((s) => ({ ...s, prd: true }));
    setLlmError("");
    try {
      const md = await llmGeneratePRD(blueprint);
      setPrdContent(md);
    } catch (err) {
      setLlmError(err.message);
    } finally {
      setLlmLoading((s) => ({ ...s, prd: false }));
    }
  };

  const isBlueprintEmpty = useMemo(() => {
    const c = blueprint.charter || {};
    return !c.agentRole && !c.agentName && !c.goal && !c.tone &&
      !c.jurisdiction && !c.hardStop &&
      (c.systemObjects || []).length === 0 &&
      (c.systemActions || []).length === 0;
  }, [blueprint.charter]);

  // Live review: evaluates blueprint state in real-time (not the static extraction snapshot)
  const liveReview = useMemo(() => ({
    agentRole:    !blueprint.charter.agentRole,
    agentName:    !blueprint.charter.agentName,
    userGoal:     !blueprint.charter.goal,
    tone:         !blueprint.charter.tone,
    jurisdiction: !blueprint.charter.jurisdiction,
    hardStop:     !blueprint.charter.hardStop,
    objects:      blueprint.charter.systemObjects.length === 0,
    actions:      blueprint.charter.systemActions.length === 0,
  }), [blueprint.charter]);

  const needsReviewAny = useMemo(() => {
    return Object.values(liveReview).some(Boolean);
  }, [liveReview]);

  const charterComplete = useMemo(() => !Object.values(liveReview).some(Boolean) && !isBlueprintEmpty, [liveReview, isBlueprintEmpty]);
  const topicsComplete = useMemo(() => {
    const t = blueprint.logicPlan?.topics || [];
    return t.length > 0 && t.every((topic) => topic.topicName && (topic.actionInventory || []).some((a) => a.name));
  }, [blueprint.logicPlan?.topics]);
  const scriptComplete = useMemo(() => {
    const sbt = blueprint.annotatedScriptByTopic || {};
    return Object.values(sbt).some((entry) => {
      const scenarios = entry.scenarios ? Object.values(entry.scenarios) : [];
      return scenarios.some((sc) => (sc.goldenPath || []).length >= 4);
    });
  }, [blueprint.annotatedScriptByTopic]);
  const handoffLint = useMemo(() => lintHandoff(blueprint), [blueprint]);
  const handoffComplete = useMemo(() => !isBlueprintEmpty && handoffLint.errors.length === 0, [isBlueprintEmpty, handoffLint]);

  return (
    <div className="min-h-screen w-full bg-background">
      <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-2xl font-semibold tracking-tight">Agent Blueprint Builder</div>
            <div className="text-sm text-muted-foreground flex items-center gap-3">
              Upload a PRD or paste notes to draft your Charter, Topics, Script, and handoff package faster.
              {lastSaved && (
                <span className="text-xs text-muted-foreground/60 whitespace-nowrap">
                  Auto-saved {lastSaved.toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-2xl border px-3 py-2">
              <Switch checked={autoSync} onCheckedChange={setAutoSync} />
              <div className="text-sm">Auto-fill</div>
            </div>
            <div className="relative">
              <Button variant="outline" size="icon" onClick={() => setSettingsOpen((o) => !o)} className="relative">
                <Settings className="h-4 w-4" />
                {hasApiKey() && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-green-500 border-2 border-background" />}
              </Button>
              <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            </div>
            <Button variant="secondary" onClick={resetAll} className="gap-2"><Trash2 className="h-4 w-4" /> Reset all</Button>
          </div>
        </div>

        <ConfirmDialog
          open={confirmReset}
          title="Reset all data?"
          description="This will permanently delete your entire blueprint, including charter, topics, scripts, and all saved progress. This action cannot be undone."
          confirmLabel="Delete everything"
          onConfirm={executeReset}
          onCancel={() => setConfirmReset(false)}
        />

        {/* Error banner */}
        {llmError && (
          <div className="flex items-start gap-2 p-3 rounded-2xl border border-destructive/30 bg-destructive/5">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">{llmError}</div>
            <button onClick={() => setLlmError("")} className="text-muted-foreground hover:text-foreground text-lg leading-none">&times;</button>
          </div>
        )}

        {saveError && (
          <div className="flex items-start gap-2 p-3 rounded-2xl border border-yellow-400/30 bg-yellow-400/5">
            <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">{saveError}</div>
            <button onClick={() => setSaveError("")} className="text-muted-foreground hover:text-foreground text-lg leading-none">&times;</button>
          </div>
        )}

        {/* Intake */}
        <Card className="rounded-2xl">
          <CardContent className="p-4 space-y-4">
            <SectionTitle
              title="1) Add your PRD content"
              subtitle="Upload a file or paste text to prefill the workspace. You can still edit every field manually."
              right={
                <div className="flex items-center gap-2">
                  {extraction?.meta?.confidence ? <ConfidenceBadge n={extraction.meta.confidence} /> : null}
                  {!isBlueprintEmpty && <ReviewBadge needsReview={needsReviewAny} />}
                </div>
              }
            />

            <div className="flex flex-col md:flex-row gap-3">
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.rtf,.json,.pdf"
                className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0])}
              />
              <Button onClick={() => fileRef.current?.click()} className="gap-2">
                <FileUp className="h-4 w-4" /> Upload file
              </Button>
              <Button variant="secondary" onClick={() => setSourceText(SAMPLE_PRD)} className="gap-2">
                <Wand2 className="h-4 w-4" /> Load sample
              </Button>
              <Button
                variant="secondary"
                onClick={handleAiExtract}
                className="gap-2"
              >
                {llmLoading.extraction ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                Fill with AI
              </Button>
              <div className="flex-1" />
              <CopyButton text={safeJson(blueprint)} label="Copy data JSON" copyKey="data-json" copiedKey={mainCopiedKey} onCopy={mainClipCopy} variant="outline" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="text-sm font-medium">Paste PRD text</div>
                <Textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder="Paste PRD content here…"
                  className="min-h-[260px]"
                />
                <div className="text-xs text-muted-foreground">
                  Supports plain text, Markdown, and PDF.
                </div>
              </div>

              <div className="space-y-3">
                <div className="text-sm font-medium flex items-center gap-2">
                  <Search className="h-4 w-4" /> Extraction checklist
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {CHECKLIST.map((c) => {
                    const missing = liveReview[c.key];
                    return (
                      <div key={c.key} className="p-3 rounded-2xl border">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{c.label}</div>
                          {isBlueprintEmpty ? (
                            <Badge variant="outline" className="gap-1 text-muted-foreground">—</Badge>
                          ) : missing ? (
                            <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3.5 w-3.5" /> Missing</Badge>
                          ) : (
                            <Badge className="gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Complete</Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">{c.why}</div>
                      </div>
                    );
                  })}
                </div>

              </div>
            </div>
          </CardContent>
        </Card>

        {/* Main editor */}
        <Tabs defaultValue="charter" className="space-y-4">
          <TabsList>
            <TabsTrigger value="charter" className="gap-1.5">Agent Charter {charterComplete && <CheckCircle2 className="h-3 w-3 text-green-600" />}</TabsTrigger>
            <TabsTrigger value="logic" className="gap-1.5">Agent Topics {topicsComplete && <CheckCircle2 className="h-3 w-3 text-green-600" />}</TabsTrigger>
            <TabsTrigger value="script" className="gap-1.5">Script Matrix {scriptComplete && <CheckCircle2 className="h-3 w-3 text-green-600" />}</TabsTrigger>
            <TabsTrigger value="handoff" className="gap-1.5">Handoff Package {handoffComplete && <CheckCircle2 className="h-3 w-3 text-green-600" />}</TabsTrigger>
          </TabsList>

          <TabsContent value="charter" className="space-y-4">
            <Card className="rounded-2xl">
              <CardContent className="p-4 space-y-4">
                <SectionTitle
                  title="Agent Charter"
                  subtitle="Define role, boundaries, and requirements before building workflows."
                />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field
                    label="Agent Role Name"
                    required
                    status={flag(liveReview.agentRole, isBlueprintEmpty)}
                    hint="Use the equivalent human job title."
                  >
                    <Input
                      value={blueprint.charter.agentRole}
                      onChange={(e) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, agentRole: e.target.value } }))}
                      placeholder='e.g., "Order Management Specialist"'
                    />
                  </Field>

                  <Field
                    label="Agent Name"
                    required
                    status={flag(liveReview.agentName, isBlueprintEmpty)}
                    hint="Short system-facing name shown in UI and logs."
                  >
                    <Input
                      value={blueprint.charter.agentName}
                      onChange={(e) => {
                        const name = e.target.value;
                        setBlueprint((p) => ({
                          ...p,
                          charter: {
                            ...p.charter,
                            agentName: name,
                            developerName: p.charter.developerName || toSalesforceDeveloperName(name),
                          },
                        }));
                      }}
                      placeholder='e.g., "Care Scheduling Agent"'
                    />
                  </Field>

                  <Field
                    label="Developer Name (API)"
                    hint="Salesforce API name. Auto-generated from Agent Name. Letters, digits, underscores only."
                  >
                    <Input
                      value={blueprint.charter.developerName}
                      onChange={(e) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, developerName: toSalesforceDeveloperName(e.target.value) } }))}
                      placeholder="e.g., Care_Scheduling_Agent"
                    />
                  </Field>

                  <Field
                    label="Agent Type"
                    hint="Maps to config.agent_type in Agent Script."
                  >
                    <Select
                      value={blueprint.charter.agentType || "AgentServiceAgent"}
                      onValueChange={(v) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, agentType: v } }))}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="AgentServiceAgent">Service Agent</SelectItem>
                        <SelectItem value="AgentEmployeeAgent">Employee Agent</SelectItem>
                        <SelectItem value="AgentSalesAgent">Sales Agent</SelectItem>
                        <SelectItem value="AgentCommerceAgent">Commerce Agent</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field
                    label="Channel"
                    hint="Primary deployment channel. Affects output format instructions in exports."
                  >
                    <Select
                      value={blueprint.charter.channel || "Console"}
                      onValueChange={(v) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, channel: v } }))}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Console">Console</SelectItem>
                        <SelectItem value="Chat">Chat</SelectItem>
                        <SelectItem value="Messaging">Messaging</SelectItem>
                        <SelectItem value="Slack">Slack</SelectItem>
                        <SelectItem value="API">API</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field
                    label="User Goal / JTBD"
                    required
                    status={flag(liveReview.userGoal, isBlueprintEmpty)}
                    hint="One concrete outcome, not a list of features."
                  >
                    <Textarea
                      value={blueprint.charter.goal}
                      onChange={(e) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, goal: e.target.value } }))}
                      placeholder='e.g., "Provide current case status and next steps"'
                      className="min-h-[88px]"
                    />
                  </Field>

                  <Field
                    label="Tone & Voice"
                    required
                    status={flag(liveReview.tone, isBlueprintEmpty)}
                    hint="Keep this aligned with brand voice and policy."
                  >
                    <Input
                      value={blueprint.charter.tone}
                      onChange={(e) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, tone: e.target.value } }))}
                      placeholder='e.g., "Empathetic but policy-firm. Concise."'
                    />
                  </Field>

                  <Field
                    label="Jurisdiction (Must-Haves)"
                    required
                    status={flag(liveReview.jurisdiction, isBlueprintEmpty)}
                    hint="Define what this agent can handle and under what constraints."
                  >
                    <Textarea
                      value={blueprint.charter.jurisdiction}
                      onChange={(e) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, jurisdiction: e.target.value } }))}
                      placeholder='e.g., "Existing orders only. Must verify identity before sharing status."'
                      className="min-h-[88px]"
                    />
                  </Field>

                  <Field
                    label="Hard Stop (Negative Scope)"
                    required
                    status={flag(liveReview.hardStop, isBlueprintEmpty)}
                    hint="Define non-negotiable limits to reduce risk."
                  >
                    <Textarea
                      value={blueprint.charter.hardStop}
                      onChange={(e) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, hardStop: e.target.value } }))}
                      placeholder='e.g., "Never touches credit card data. Never gives medical advice."'
                      className="min-h-[88px]"
                    />
                  </Field>

                  <Field
                    label="Welcome Message"
                    hint="Displayed when the conversation starts. Required by Agent Script."
                  >
                    <Textarea
                      value={blueprint.charter.welcomeMessage}
                      onChange={(e) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, welcomeMessage: e.target.value } }))}
                      placeholder={"e.g., Hi! I'm your Care Scheduling Agent. How can I help you today?"}
                      className="min-h-[60px]"
                    />
                  </Field>

                  <Field
                    label="Error Message"
                    hint="Displayed when the agent encounters an unrecoverable error. Required by Agent Script."
                  >
                    <Textarea
                      value={blueprint.charter.errorMessage}
                      onChange={(e) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, errorMessage: e.target.value } }))}
                      placeholder={"e.g., I'm sorry, something went wrong. Let me connect you to a human agent."}
                      className="min-h-[60px]"
                    />
                  </Field>
                </div>

                <Separator />

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <Field
                    label='System Objects ("Nouns")'
                    required
                    status={flag(liveReview.objects, isBlueprintEmpty)}
                    hint="List real data objects that exist in your system."
                  >
                    <PillListEditor
                      value={blueprint.charter.systemObjects}
                      onChange={(v) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, systemObjects: v } }))}
                      placeholder="Add object… (Case, Appointment, Referral)"
                    />
                  </Field>

                  <Field
                    label='System Actions / Tools ("Verbs")'
                    required
                    status={flag(liveReview.actions, isBlueprintEmpty)}
                    hint="List actions that are already available as tools."
                  >
                    <PillListEditor
                      value={blueprint.charter.systemActions}
                      onChange={(v) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, systemActions: v } }))}
                      placeholder="Add action… (Get_Status, Reschedule_Appointment)"
                    />
                  </Field>

                  <Field
                    label="Guardrails (Policy)"
                    hint="Policy rules that constrain wording and behavior."
                  >
                    <PillListEditor
                      value={blueprint.charter.guardrails}
                      onChange={(v) => setBlueprint((p) => ({ ...p, charter: { ...p.charter, guardrails: v } }))}
                      placeholder="Add guardrail… (Mask PII, don’t claim success without tool result)"
                    />
                  </Field>

                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl">
              <CardContent className="p-4 space-y-3">
                <SectionTitle
                  title="What comes next"
                  subtitle="After the Charter is complete, generate a first draft of Topics and Script." 
                  right={<Badge variant="outline" className="gap-2"><Link2 className="h-3.5 w-3.5" /> Connectors</Badge>}
                />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {NEXT_STEPS.map((s) => (
                    <div key={s.title} className="p-3 rounded-2xl border">
                      <div className="text-sm font-medium">{s.title}</div>
                      <div className="text-xs text-muted-foreground mt-1">{s.desc}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="logic" className="space-y-4">
            <Card className="rounded-2xl">
              <CardContent className="p-4 space-y-4">
                <SectionTitle
                  title="Agent Topics"
                  subtitle="Define topics, routing, checks, and actions. These fields map directly to Agent Script configuration."
                />

                <div className="rounded-xl border p-3 space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Topic manager</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={activeTopicId} onValueChange={setSelectedTopicId}>
                      <SelectTrigger className="h-8 w-[220px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {topics.map((t) => (
                          <SelectItem key={t.id} value={t.id} className="text-xs">
                            {t.topicName || t.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => {
                        const id = `topic-${Date.now()}`;
                        setBlueprint((p) => ({
                          ...p,
                          logicPlan: { ...p.logicPlan, topics: [...(p.logicPlan?.topics || []), makeTopic(id)] },
                          annotatedScriptByTopic: {
                            ...(p.annotatedScriptByTopic || {}),
                            [id]: { scenarios: {}, activeScenarioId: null },
                          },
                        }));
                        setSelectedTopicId(id);
                      }}
                    >
                      Add topic
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => {
                        const id = `topic-${Date.now()}`;
                        const srcScripts = blueprint.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
                        const copiedScenarios = {};
                        for (const [k, v] of Object.entries(srcScripts.scenarios || {})) {
                          copiedScenarios[k] = { ...v, goldenPath: [...(v.goldenPath || [])] };
                        }
                        setBlueprint((p) => ({
                          ...p,
                          logicPlan: {
                            ...p.logicPlan,
                            topics: [
                              ...(p.logicPlan?.topics || []),
                              makeTopic(id, {
                                ...activeTopic,
                                id,
                                topicName: `${activeTopic.topicName || "Topic"} Copy`,
                                topicDescription: activeTopic.topicDescription || "",
                                routingAndAvailability: [...(activeTopic.routingAndAvailability || [])],
                                prechecks: [...(activeTopic.prechecks || [])],
                                actionInventory: (activeTopic.actionInventory || []).map((a) => ({ ...a, inputs: [...(a.inputs || [])], outputs: [...(a.outputs || [])] })),
                                outputInstructions: [...(activeTopic.outputInstructions || [])],
                                actionSpecs: (activeTopic.actionSpecs || []).map((s) => ({ ...s })),
                              }),
                            ],
                          },
                          annotatedScriptByTopic: {
                            ...(p.annotatedScriptByTopic || {}),
                            [id]: { scenarios: copiedScenarios, activeScenarioId: srcScripts.activeScenarioId },
                          },
                        }));
                        setSelectedTopicId(id);
                      }}
                    >
                      Duplicate topic
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={topics.length <= 1}
                      onClick={() => {
                        setBlueprint((p) => {
                          const rest = (p.logicPlan?.topics || []).filter((t) => t.id !== activeTopicId);
                          const nextScripts = { ...(p.annotatedScriptByTopic || {}) };
                          delete nextScripts[activeTopicId];
                          return {
                            ...p,
                            logicPlan: { ...p.logicPlan, topics: rest.length ? rest : [makeTopic("topic-1")] },
                            annotatedScriptByTopic: rest.length ? nextScripts : {
                              "topic-1": { scenarios: {}, activeScenarioId: null },
                            },
                          };
                        });
                        setSelectedTopicId((prev) => {
                          if (prev !== activeTopicId) return prev;
                          return topics.find((t) => t.id !== activeTopicId)?.id || "topic-1";
                        });
                      }}
                    >
                      Remove topic
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <Field label="Topic Name" required hint="Maps to a topic block in Agent Script. Use snake_case.">
                    <Input
                      value={activeTopic.topicName}
                      onChange={(e) => updateTopicById(activeTopicId, { topicName: e.target.value })}
                      placeholder='e.g., "Reschedule_Appointment"'
                    />
                  </Field>

                  <Field label="Topic Description" hint="Describe what this topic handles. Used for routing decisions.">
                    <Textarea
                      value={activeTopic.topicDescription}
                      onChange={(e) => updateTopicById(activeTopicId, { topicDescription: e.target.value })}
                      placeholder="e.g., Handles appointment rescheduling requests including date changes and cancellations"
                      className="min-h-[60px]"
                    />
                  </Field>

                  <Field label="Routing & Availability" hint="Define go_to transitions and available-when conditions.">
                    <PillListEditor
                      value={activeTopic.routingAndAvailability}
                      onChange={(v) => updateTopicById(activeTopicId, { routingAndAvailability: v })}
                      placeholder="e.g., go_to_reschedule: available when @variables.verified == True"
                    />
                  </Field>

                  <Field label="Prechecks (Pre-Reasoning)" hint="Conditions checked before reasoning starts.">
                    <PillListEditor
                      value={activeTopic.prechecks}
                      onChange={(v) => updateTopicById(activeTopicId, { prechecks: v })}
                      placeholder="e.g., @variables.customer_verified == True"
                    />
                  </Field>

                  <div className="lg:col-span-2">
                    <Field label="Output Instructions" hint="Allowed output types for this channel.">
                      <PillListEditor
                        value={activeTopic.outputInstructions}
                        onChange={(v) => updateTopicById(activeTopicId, { outputInstructions: v })}
                        placeholder="e.g., text response, quick replies, record card"
                      />
                    </Field>
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold">Action inventory</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Each action maps to a Flow, Apex class, or Prompt Template.
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => {
                        const items = [...(activeTopic.actionInventory || []), makeActionInventoryItem()];
                        updateTopicById(activeTopicId, { actionInventory: items });
                      }}
                    >
                      + Add Action
                    </Button>
                  </div>

                  {(activeTopic.actionInventory || []).length === 0 && (
                    <div className="text-xs text-muted-foreground italic p-3 border rounded-lg border-dashed text-center">
                      No actions yet. Add one manually or generate from Charter below.
                    </div>
                  )}

                  {(activeTopic.actionInventory || []).map((action, idx) => (
                    <div key={idx} className="rounded-lg border p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <Input
                            value={action.name}
                            onChange={(e) => {
                              const items = [...activeTopic.actionInventory];
                              items[idx] = { ...items[idx], name: e.target.value };
                              updateTopicById(activeTopicId, { actionInventory: items });
                            }}
                            placeholder="Action name (snake_case)"
                            className="text-xs"
                          />
                          <Select
                            value={action.targetType}
                            onValueChange={(v) => {
                              const items = [...activeTopic.actionInventory];
                              items[idx] = { ...items[idx], targetType: v };
                              updateTopicById(activeTopicId, { actionInventory: items });
                            }}
                          >
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="Flow" className="text-xs">Flow</SelectItem>
                              <SelectItem value="Apex" className="text-xs">Apex</SelectItem>
                              <SelectItem value="Prompt Template" className="text-xs">Prompt Template</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            value={action.description}
                            onChange={(e) => {
                              const items = [...activeTopic.actionInventory];
                              items[idx] = { ...items[idx], description: e.target.value };
                              updateTopicById(activeTopicId, { actionInventory: items });
                            }}
                            placeholder="Description"
                            className="text-xs"
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 shrink-0"
                          onClick={() => {
                            const items = activeTopic.actionInventory.filter((_, i) => i !== idx);
                            updateTopicById(activeTopicId, { actionInventory: items });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <PillListEditor
                          value={action.inputs}
                          onChange={(v) => {
                            const items = [...activeTopic.actionInventory];
                            items[idx] = { ...items[idx], inputs: v };
                            updateTopicById(activeTopicId, { actionInventory: items });
                          }}
                          placeholder="Inputs as name: type (e.g., order_id: id, email: string)"
                        />
                        <PillListEditor
                          value={action.outputs}
                          onChange={(v) => {
                            const items = [...activeTopic.actionInventory];
                            items[idx] = { ...items[idx], outputs: v };
                            updateTopicById(activeTopicId, { actionInventory: items });
                          }}
                          placeholder="Outputs as name: type (e.g., order_summary: string)"
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <Separator />

                <Card className="rounded-2xl border-dashed">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold">Generate from Charter</div>
                        <div className="text-xs text-muted-foreground mt-1">
                          Proposes topic description, prechecks, action inventory, and output instructions from your Agent Charter.
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          className="gap-2"
                          onClick={() => {
                            updateTopicById(activeTopicId, (t) => ({
                              ...t,
                              topicName: t.topicName || "<TopicName>",
                              topicDescription: t.topicDescription || (blueprint.charter.goal ? `Handle user requests related to: ${blueprint.charter.goal}` : ""),
                              prechecks: t.prechecks.length
                                ? t.prechecks
                                : [
                                    "@variables.required_context_present == True",
                                    "@variables.user_has_access == True",
                                    "Tool availability confirmed",
                                  ],
                              actionInventory: t.actionInventory.length
                                ? t.actionInventory
                                : (blueprint.charter.systemActions.length
                                    ? blueprint.charter.systemActions.map((name) => makeActionInventoryItem(name))
                                    : [makeActionInventoryItem("<ActionName>")]),
                              outputInstructions: t.outputInstructions.length
                                ? t.outputInstructions
                                : ["Text response", "Clarifying question", "Quick replies"],
                            }));
                          }}
                        >
                          <Sparkles className="h-4 w-4" /> Generate draft
                        </Button>
                        <Button
                          variant="secondary"
                          className="gap-2"
                          onClick={handleAiLogic}
                          disabled={llmLoading.logic}
                        >
                          {llmLoading.logic ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                          Generate with AI
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="script" className="space-y-4">
            <Card className="rounded-2xl">
              <CardContent className="p-4 space-y-4">
                <SectionTitle
                  title="Script Matrix"
                  subtitle="Draft the golden path naturally, then annotate each line with structured labels."
                />

                <div className="flex flex-col md:flex-row gap-3 md:items-center">
                  <Select value={activeTopicId} onValueChange={setSelectedTopicId}>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {topics.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.topicName || t.id}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {(() => {
                    const scenarioList = Object.values(topicScripts.scenarios || {});
                    const SCENARIO_TYPE_COLORS = { basic: "default", advanced: "secondary", tricky: "destructive", custom: "outline" };
                    return (
                      <>
                        <Select
                          value={activeScenarioId || "__none__"}
                          onValueChange={(v) => v !== "__none__" && setActiveScenarioId(v)}
                        >
                          <SelectTrigger className="w-[240px]">
                            <SelectValue placeholder="No scenario selected" />
                          </SelectTrigger>
                          <SelectContent>
                            {scenarioList.length === 0 && (
                              <SelectItem value="__none__" disabled>No scenarios yet</SelectItem>
                            )}
                            {scenarioList.map((sc) => (
                              <SelectItem key={sc.id} value={sc.id}>
                                <span className="flex items-center gap-2">
                                  {sc.name}
                                  <Badge variant={SCENARIO_TYPE_COLORS[sc.type] || "outline"} className="text-[10px] px-1.5 py-0">{sc.type}</Badge>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {activeScenario && (
                          <Input
                            className="h-9 w-[160px] text-xs"
                            value={activeScenario.name}
                            onChange={(e) => renameScenario(activeScenarioId, e.target.value)}
                            title="Rename scenario"
                          />
                        )}
                        {activeScenario && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs text-destructive"
                            onClick={() => removeScenario(activeScenarioId)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </>
                    );
                  })()}

                  <div className="flex-1" />

                  <Button
                    variant="secondary"
                    className="gap-2"
                    onClick={() => {
                      const topic = activeTopic.topicName || "<TopicName>";
                      const a1 = blueprint.charter.systemActions[0] || "<ActionName>";
                      const scId = addScenario("basic");
                      setBlueprint((p) => {
                        const topicEntry = p.annotatedScriptByTopic?.[activeTopicId] || { scenarios: {}, activeScenarioId: null };
                        const sc = topicEntry.scenarios?.[scId];
                        if (!sc) return p;
                        return {
                          ...p,
                          annotatedScriptByTopic: {
                            ...(p.annotatedScriptByTopic || {}),
                            [activeTopicId]: {
                              ...topicEntry,
                              scenarios: {
                                ...topicEntry.scenarios,
                                [scId]: {
                                  ...sc,
                                  name: "Skeleton",
                                  goldenPath: [
                                    makeStep("1", "User", "", { ...EMPTY_LABELS, trigger: "user_input_received", routing: `intent = <IntentName> → topic = ${topic}` }),
                                    makeStep("2", "Agent", "", { ...EMPTY_LABELS, precheck: "required context present", guardrail: "do not claim success without tool result", ui: "ask 1 clarifying question (quick replies)" }),
                                    makeStep("3", "Agent", "", { ...EMPTY_LABELS, action: a1, inputs: "<list>", state: "set <variables> (source: tool)", result: "success | failure | empty | partial" }, [
                                      makeStep("3-1", "Fallback Option", "", { ...EMPTY_LABELS, failure: "missing required input", recovery: "ask for missing field → re-run action" }),
                                    ]),
                                  ],
                                },
                              },
                              activeScenarioId: scId,
                            },
                          },
                        };
                      });
                    }}
                  >
                    <Sparkles className="h-4 w-4" /> Create skeleton
                  </Button>
                  <Button
                    variant="secondary"
                    className="gap-2"
                    onClick={() => setScenarioModal({ open: true, type: "basic", customPrompt: "" })}
                    disabled={llmLoading.script}
                  >
                    {llmLoading.script ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                    Generate with AI
                  </Button>
                </div>

                {activeScenario ? (
                  <>
                    <ScriptStepList
                      steps={activeGoldenPath}
                      onChange={(newSteps) => updateActiveScenario({ goldenPath: newSteps })}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => {
                          updateActiveScenario((prev) => ({
                            ...prev,
                            goldenPath: [
                              ...prev.goldenPath,
                              makeStep(String(prev.goldenPath.length + 1), "Agent"),
                            ],
                          }));
                        }}
                      >
                        Add step
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center p-8 rounded-xl border border-dashed text-sm text-muted-foreground">
                    No scenario selected. Choose "Create skeleton" or "Generate with AI" to get started.
                  </div>
                )}

                {/* Scenario Creation Modal */}
                {scenarioModal.open && (
                  <ModalBackdrop onClose={() => setScenarioModal({ open: false, type: "basic", customPrompt: "" })}>
                    <Card className="w-full max-w-lg rounded-2xl">
                      <CardContent className="p-5 space-y-4">
                        <div className="text-base font-semibold">Create new scenario</div>
                        <div className="text-sm text-muted-foreground">
                          Choose the scenario type to generate. Each scenario creates an independent script under this topic.
                        </div>
                        <div className="grid grid-cols-1 gap-2">
                          {[
                            { value: "basic", label: "Basic", desc: "Common happy-path flow." },
                            { value: "advanced", label: "Advanced", desc: "Broader flow with optional rules and edge cases." },
                            { value: "tricky", label: "Tricky", desc: "Complex flow with unexpected inputs and recovery paths." },
                            { value: "custom", label: "Custom", desc: "Describe the exact scenario to generate." },
                          ].map((opt) => (
                            <div
                              key={opt.value}
                              className={`rounded-xl border p-3 cursor-pointer transition-colors ${scenarioModal.type === opt.value ? "border-primary bg-primary/5" : "hover:border-muted-foreground/30"}`}
                              onClick={() => setScenarioModal((s) => ({ ...s, type: opt.value }))}
                            >
                              <div className="flex items-center gap-2">
                                <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${scenarioModal.type === opt.value ? "border-primary" : "border-muted-foreground/40"}`}>
                                  {scenarioModal.type === opt.value && <div className="h-2 w-2 rounded-full bg-primary" />}
                                </div>
                                <div className="text-sm font-medium">{opt.label}</div>
                              </div>
                              <div className="text-xs text-muted-foreground mt-1 ml-6">{opt.desc}</div>
                            </div>
                          ))}
                        </div>
                        {scenarioModal.type === "custom" && (
                          <Textarea
                            placeholder="Describe the scenario you want to generate..."
                            value={scenarioModal.customPrompt}
                            onChange={(e) => setScenarioModal((s) => ({ ...s, customPrompt: e.target.value }))}
                            className="min-h-[80px]"
                          />
                        )}
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" onClick={() => setScenarioModal({ open: false, type: "basic", customPrompt: "" })}>
                            Cancel
                          </Button>
                          <Button
                            variant="secondary"
                            className="gap-2"
                            disabled={llmLoading.script || (scenarioModal.type === "custom" && !scenarioModal.customPrompt.trim())}
                            onClick={() => {
                              setScenarioModal((s) => ({ ...s, open: false }));
                              handleAiScript(scenarioModal.type, scenarioModal.customPrompt);
                            }}
                          >
                            <Bot className="h-4 w-4" /> Generate scenario
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </ModalBackdrop>
                )}

                {/* Script Continuation Modal */}
                {scriptContinuation.show && (
                  <ModalBackdrop onClose={() => setScriptContinuation({ show: false, hint: "", messages: [], topLevelCount: 0 })}>
                    <Card className="w-full max-w-lg rounded-2xl">
                      <CardContent className="p-4 space-y-3">
                        <div className="text-base font-semibold">More steps available</div>
                        <div className="text-sm text-muted-foreground">
                          Additional steps may exist beyond step {scriptContinuation.topLevelCount}. Continue generating?
                        </div>
                        {scriptContinuation.hint ? (
                          <div className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                            {scriptContinuation.hint}
                          </div>
                        ) : null}
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            onClick={() => setScriptContinuation({ show: false, hint: "", messages: [], topLevelCount: 0 })}
                            disabled={llmLoading.script}
                          >
                            Stop here
                          </Button>
                          <Button
                            variant="secondary"
                            className="gap-2"
                            onClick={handleContinueScript}
                            disabled={llmLoading.script}
                          >
                            {llmLoading.script ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                            Continue
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </ModalBackdrop>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="handoff" className="space-y-4">
            <HandoffPanel
              blueprint={blueprint}
              setBlueprint={setBlueprint}
              onAiReview={handleAiReview}
              aiReview={aiReview}
              reviewLoading={llmLoading.review}
              onAiOptimize={handleAiOptimize}
              optimizeLoading={llmLoading.optimize}
              pristine={isBlueprintEmpty}
              prdContent={prdContent}
              onGeneratePRD={handleGeneratePRD}
              prdLoading={llmLoading.prd}
              selectedTopicId={activeTopicId}
              onSelectTopic={setSelectedTopicId}
            />
          </TabsContent>

        </Tabs>

        <footer className="text-xs text-muted-foreground pb-6">
          Prototype note: production should replace heuristic extraction with a grounded pipeline (RAG, schema validation, citations, policy linting, and review workflow).
        </footer>
      </div>
    </div>
  );
}

// -----------------------------
// Small helpers + constants
// -----------------------------

function flag(isMissing, pristine) {
  if (isMissing === undefined || isMissing === null) return null;
  if (pristine && isMissing) return null;
  return isMissing ? (
    <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3.5 w-3.5" /> Missing</Badge>
  ) : (
    <Badge className="gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Complete</Badge>
  );
}

const CHECKLIST = [
  { key: "agentRole", label: "Role", why: "Turns persona into a job contract." },
  { key: "agentName", label: "Name", why: "Used in UI + logs." },
  { key: "userGoal", label: "JTBD", why: "Prevents feature soup." },
  { key: "tone", label: "Tone", why: "Consistency across channels." },
  { key: "jurisdiction", label: "Jurisdiction", why: "Defines strategic boundary." },
  { key: "hardStop", label: "Hard Stops", why: "Prevents hallucinations + risk." },
  { key: "objects", label: "Nouns", why: "Data feasibility check." },
  { key: "actions", label: "Verbs", why: "Tool reality check." },
];

const NEXT_STEPS = [
  {
    title: "Define Agent Topics",
    desc: "Move to Agent Topics to define topic descriptions, routing rules, prechecks, and action inventory for each topic.",
  },
  {
    title: "Build Script Matrix",
    desc: "Generate annotated golden-path scripts for each topic scenario, with fallback substeps per action.",
  },
  {
    title: "Export Handoff Package",
    desc: "Complete action specs with fallback strategies, then export the Agent JSON bundle and prompt template.",
  },
];

const SAMPLE_PRD = `Title: Referral Management Agent\n\nRole: Care Operations Specialist\nAgent Name: Referral Navigator\nUser Goal / JTBD: Reduce time from referral received to appointment scheduled by guiding staff through next-best actions.\nTone & Voice: Empathetic, concise, policy-firm.\nJurisdiction: Existing referrals only. Must verify patient context before showing details.\nHard Stop: Never share PHI in chat transcript. Never schedule outside assigned clinic locations.\n\nSystem Objects (Data / Nouns): Referral, Appointment, Patient, Provider, Location\nSystem Action / Tool (Verbs): Get_Referral_Details, Get_Available_Slots, Create_Outreach_Task, Reschedule_Appointment\nRequired Inputs (Data Schema): ReferralId (or MRN), Location, AppointmentType\nTelemetry: tool_success_rate, fallback_rate, avg_time_to_schedule, handoff_rate\n\nUnhappy Paths (Edge Cases):\n- No availability in requested window\n- Missing Location\n- Multiple patients match MRN\n- Permission denied\n- Tool error / timeout\n\nGuardrail: do not claim success without tool result\nGuardrail: mask identifiers in UI\n`;
