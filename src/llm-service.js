/**
 * llm-service.js
 * Client-side LLM integration for Agent Blueprint Autofill.
 * Calls the OpenAI API directly using a user-provided API key stored in localStorage.
 */

const STORAGE_KEY_API = "openai_api_key";
const STORAGE_KEY_MODEL = "openai_model";
const DEFAULT_MODEL = "gpt-4o-mini";

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEY_API) || "";
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY_API, key.trim());
}

export function getModel() {
  return localStorage.getItem(STORAGE_KEY_MODEL) || DEFAULT_MODEL;
}

export function setModel(model) {
  localStorage.setItem(STORAGE_KEY_MODEL, model);
}

export function hasApiKey() {
  return !!getApiKey();
}

// ── Core LLM Call ────────────────────────────────────────

async function callLLMMultiTurn(messages, { json = true } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API key configured. Open Settings to add your OpenAI key.");

  const model = getModel();

  const body = {
    model,
    messages,
    temperature: 0.3,
    max_tokens: 16384,
  };

  if (json) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`OpenAI API error (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";

  let parsed = content;
  if (json) {
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("LLM returned invalid JSON. Try again.");
    }
  }

  const assistantMessage = { role: "assistant", content };
  return {
    parsed,
    content,
    messages: [...messages, assistantMessage],
  };
}

async function callLLM(systemPrompt, userMessage, { json = true } = {}) {
  const startMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  const out = await callLLMMultiTurn(startMessages, { json });
  return out.parsed;
}

// ── 1. Extract from PRD ──────────────────────────────────

const EXTRACT_SYSTEM = `You are an expert Salesforce Agent architect. Given a PRD (Product Requirements Document), extract structured agent charter fields.

Return a JSON object with EXACTLY these keys:
{
  "agentRole": "string — the agent's role title",
  "agentName": "string — short display name",
  "goal": "string — the user's job-to-be-done (JTBD), one sentence",
  "tone": "string — tone and voice description",
  "jurisdiction": "string — what the agent covers and constraints",
  "hardStop": "string — things the agent must NEVER do",
  "systemObjects": ["array of CRM object names (nouns)"],
  "systemActions": ["array of action/tool names (verbs), e.g. Get_Case_Status"],
  "guardrails": ["array of safety/policy guardrails"]
}

Rules:
- Extract ONLY what is stated or strongly implied in the PRD.
- For arrays, return [] if nothing is found — never make things up.
- For strings, return "" if not found.
- Keep values concise but complete.`;

export async function extractWithLLM(prdText) {
  const result = await callLLM(EXTRACT_SYSTEM, prdText);
  return {
    agentRole: result.agentRole || "",
    agentName: result.agentName || "",
    goal: result.goal || "",
    tone: result.tone || "",
    jurisdiction: result.jurisdiction || "",
    hardStop: result.hardStop || "",
    systemObjects: Array.isArray(result.systemObjects) ? result.systemObjects : [],
    systemActions: Array.isArray(result.systemActions) ? result.systemActions : [],
    guardrails: Array.isArray(result.guardrails) ? result.guardrails : [],
  };
}

// ── 2. Generate Logic Plan ───────────────────────────────

const LOGIC_SYSTEM = `You are an expert Salesforce Agent architect. Given an agent charter, generate a topic plan aligned with Agent Script configuration.

Return a JSON object with EXACTLY these keys:
{
  "topicName": "string — topic block name in snake_case, e.g. Reschedule_Appointment",
  "topicDescription": "string — describes what this topic handles; the LLM uses this to decide when to route here (maps to topic description in Agent Script)",
  "routingAndAvailability": ["array of go_to_ transition rules and available when conditions, e.g. 'go_to_reschedule: available when @variables.verified == True'"],
  "prechecks": ["array of pre-reasoning conditions (maps to available when filters and logic instructions in Agent Script), e.g. '@variables.customer_verified == True'"],
  "actionInventory": [{"name": "action_name", "targetType": "Flow|Apex|Prompt Template", "description": "what the action does", "inputs": ["input fields"], "outputs": ["output fields"]}],
  "outputInstructions": ["array of output types the LLM can display in this channel, e.g. 'text response', 'quick replies', 'record card'"]
}

Rules:
- Use the charter's systemActions as the basis for actionInventory names.
- Each action in actionInventory must specify targetType (Flow, Apex, or Prompt Template), description, inputs, and outputs.
- Prechecks should map to available when conditions: permission checks, required context variables, and tool availability.
- Output instructions should be Console-friendly (text responses, quick replies, record cards, summaries).
- Do NOT include fallbacks — those are handled in a later design step.`;

export async function generateLogicPlan(charter, topicContext = null) {
  const userMsg = topicContext
    ? `Agent Charter:\n${JSON.stringify(charter, null, 2)}\n\nActive Topic Context:\n${JSON.stringify(topicContext, null, 2)}`
    : `Agent Charter:\n${JSON.stringify(charter, null, 2)}`;
  const result = await callLLM(LOGIC_SYSTEM, userMsg);
  const rawInventory = Array.isArray(result.actionInventory) ? result.actionInventory : [];
  const actionInventory = rawInventory.map((item) => {
    if (typeof item === "string") return { name: item, targetType: "Flow", description: "", inputs: [], outputs: [] };
    return {
      name: item.name || "",
      targetType: item.targetType || "Flow",
      description: item.description || "",
      inputs: Array.isArray(item.inputs) ? item.inputs : [],
      outputs: Array.isArray(item.outputs) ? item.outputs : [],
    };
  });
  return {
    topicName: result.topicName || "",
    topicDescription: result.topicDescription || "",
    routingAndAvailability: Array.isArray(result.routingAndAvailability) ? result.routingAndAvailability : [],
    prechecks: Array.isArray(result.prechecks) ? result.prechecks : [],
    actionInventory,
    outputInstructions: Array.isArray(result.outputInstructions) ? result.outputInstructions : [],
  };
}

// ── 3. Generate Annotated Script (Rich Labels + Substeps) ────

const SCRIPT_SYSTEM = `You are an expert Salesforce Agent conversation designer. Given a charter and logic plan, generate a **richly annotated golden-path script** for a Console channel interaction.

## Data Model

Each step uses **structured principle labels** instead of free-text annotations:

\`\`\`json
{
  "step": "1",
  "actor": "User" | "Agent" | "Fallback Option",
  "dialogue": "natural channel-appropriate text",
  "labels": {
    "trigger":    "",   // e.g. "user_input_received"
    "routing":    "",   // e.g. "intent = Reschedule → topic = Reschedule_Appointment"
    "precheck":   "",   // e.g. "PatientId + AppointmentId in Console context"
    "action":     "",   // e.g. "Get_Available_Slots (Flow)"
    "inputs":     "",   // e.g. "AppointmentType, Location, @preferred_day"
    "state":      "",   // e.g. "set @slot_options[] (source: tool)"
    "ui":         "",   // e.g. "show top 3-5 slots + Select buttons"
    "failure":    "",   // e.g. "missing required input (Location)"
    "recovery":   "",   // e.g. "ask for missing field → re-run Get_Available_Slots"
    "guardrail":  "",   // e.g. "do not echo sensitive details"
    "result":     "",   // e.g. "success | failure | empty | partial"
    "telemetry":  ""    // e.g. "tool_success, confirmation_accept"
  },
  "substeps": []       // child steps (same shape) for Fallback Options
}
\`\`\`

Only include non-empty label values. Leave unused label keys as "".

## Few-Shot Example

Step 1: User says "I'd like to reschedule my appointment."
\`\`\`json
{
  "step": "1", "actor": "User",
  "dialogue": "I'd like to reschedule my appointment.",
  "labels": {
    "trigger": "user_input_received",
    "routing": "intent = Reschedule → topic = Reschedule_Appointment",
    "precheck": "", "action": "", "inputs": "", "state": "",
    "ui": "", "failure": "", "recovery": "", "guardrail": "",
    "result": "", "telemetry": "intent_routed"
  },
  "substeps": []
}
\`\`\`

Step 4: Agent calls tool and delivers result, with a fallback substep:
\`\`\`json
{
  "step": "4", "actor": "Agent",
  "dialogue": "Here are three available times. Which works best for you?",
  "labels": {
    "trigger": "", "routing": "",
    "precheck": "AppointmentId + Location confirmed",
    "action": "Get_Available_Slots (Flow)",
    "inputs": "AppointmentType, Location, @preferred_day",
    "state": "set @slot_options[] (source: tool)",
    "ui": "show top 3-5 slots + Select quick-reply buttons",
    "failure": "",
    "recovery": "",
    "guardrail": "do not claim slots exist without tool result",
    "result": "success",
    "telemetry": "tool_success"
  },
  "substeps": [
    {
      "step": "4-1", "actor": "Fallback Option",
      "dialogue": "I wasn't able to find open slots for that day. Could you try a different date?",
      "labels": {
        "trigger": "", "routing": "", "precheck": "",
        "action": "", "inputs": "", "state": "",
        "ui": "show date-picker quick reply",
        "failure": "tool returned empty result set",
        "recovery": "ask user for new preferred_day → re-run Get_Available_Slots",
        "guardrail": "do not fabricate available times",
        "result": "empty", "telemetry": "fallback_used"
      },
      "substeps": []
    }
  ]
}
\`\`\`

## Return Shape

Return a JSON object:
\`\`\`json
{
  "goldenPath": [ ...steps ],
  "has_more": false,
  "continuation_hint": ""
}
\`\`\`

## Quality Rules (defaults — a "Scenario Override" section in the user message may adjust these)

1. Generate 10-12 top-level steps covering a **full end-to-end conversation**: user trigger, intent routing, context gathering / clarification, tool call(s), result delivery, confirmation, and wrap-up.
2. If the scenario naturally requires more than 12 top-level steps, return ONLY the first 12 and set:
   - \`has_more: true\`
   - \`continuation_hint\`: a short note about what remains
3. If completed within this response, set:
   - \`has_more: false\`
   - \`continuation_hint: ""\`
4. **Every step that has a non-empty \`action\` label MUST include at least 1 substep** with actor "Fallback Option" modeling a realistic failure + recovery.
5. Every \`state\` label must cite its source (user | tool | context).
6. No variable (e.g. @preferred_day) may appear in \`inputs\` unless it was captured in a prior step's \`state\` label or exists in Console context noted in \`precheck\`.
7. Include at least one \`guardrail\` label among the steps.
8. Include at least one \`telemetry\` label among the steps.
9. Dialogue must be concise and Console-friendly.
10. Only fill a label when it is **relevant** to that step. Leave unused labels as empty strings — do not pad.`;

const SCENARIO_OVERRIDES = {
  basic: `## Scenario Override — Basic
Generate the most common, smooth end-to-end user journey with no complications.
This represents what ~80% of real sessions look like.

**Branching:** Single happy path. Each action step has exactly 1 fallback substep covering the single most common failure mode.
**Labels:** Fill core labels — trigger, routing, action, inputs, state, result — plus guardrail (at least once) and telemetry (at least once). Only fill other labels (precheck, ui, failure, recovery) when directly relevant to the step.
**Steps:** 10-12 top-level steps. Full conversation from trigger to wrap-up — do NOT truncate or shortcut.`,

  advanced: `## Scenario Override — Advanced
Generate a thorough scenario that exercises all available actions and covers edge cases an engineer needs to implement.

**Branching:** Use ALL actions from the topic's actionInventory. Every action step MUST have 2+ fallback substeps covering distinct failure modes (e.g. empty result, validation error, timeout). Include explicit precheck steps before tool calls and a confirmation/wrap-up sequence.
**Labels:** Fill labels when relevant to the step — do NOT force all 12 on every step. However, use a broader range compared to Basic: precheck before tool calls, state after data retrieval, ui when presenting choices or quick replies, telemetry at key decision points (intent routed, tool success/failure, confirmation). The goal is thoroughness, not padding.
**Steps:** 10-12 top-level steps. Full conversation from trigger to wrap-up — do NOT truncate or shortcut.`,

  tricky: `## Scenario Override — Tricky
Generate a complex, realistic scenario that stress-tests the agent design under adversarial or edge-case conditions.

**Branching:** Include at least 2 recovery loops (fallback substep → re-run action with corrected inputs). At least 1 step where the agent must refuse or redirect due to a guardrail trigger. At least 1 hard-stop or human-handoff scenario. Model the user changing their mind or providing ambiguous/conflicting input mid-flow.
**Labels:** Same relevance-based approach as Advanced, but failure + recovery labels should appear on at least 50% of steps given the adversarial nature. Guardrail labels should appear on multiple steps (not just once).
**Steps:** 10-12 top-level steps. Full conversation from trigger to wrap-up — do NOT truncate or shortcut.`,
};

export async function generateScript(charter, topicPlan, scenarioType = "basic", customPrompt = "") {
  const scenarioBlock = scenarioType === "custom" && customPrompt
    ? `\n\n## Scenario Override — Custom\n${customPrompt}\n\n**Steps:** 10-12 top-level steps. Full conversation from trigger to wrap-up — do NOT truncate or shortcut.`
    : `\n\n${SCENARIO_OVERRIDES[scenarioType] || SCENARIO_OVERRIDES.basic}`;
  const userMsg = `Agent Charter:\n${JSON.stringify(charter, null, 2)}\n\nActive Topic Plan:\n${JSON.stringify(topicPlan, null, 2)}${scenarioBlock}`;
  const startMessages = [
    { role: "system", content: SCRIPT_SYSTEM },
    { role: "user", content: userMsg },
  ];
  const out = await callLLMMultiTurn(startMessages);
  const result = out.parsed || {};
  const goldenPath = Array.isArray(result.goldenPath) ? result.goldenPath : [];
  return {
    steps: goldenPath.map((s, i) => normalizeStep(s, i)),
    hasMore: !!result.has_more,
    continuationHint: result.continuation_hint || "",
    messages: out.messages,
  };
}

export async function continueScript(previousMessages, existingSteps = [], continuationHint = "") {
  const topLevelCount = Array.isArray(existingSteps) ? existingSteps.length : 0;
  const nextStep = topLevelCount + 1;
  const continuePrompt = [
    `Continue generating the SAME scenario from step ${nextStep}.`,
    "Return ONLY new top-level steps (do not repeat earlier steps).",
    "Use the same JSON shape with keys: goldenPath, has_more, continuation_hint.",
    "Keep the same label quality and fallback rules.",
    continuationHint ? `Remaining context: ${continuationHint}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prior = Array.isArray(previousMessages) ? previousMessages : [];
  const out = await callLLMMultiTurn(
    [...prior, { role: "user", content: continuePrompt }],
    { json: true }
  );
  const result = out.parsed || {};
  const goldenPath = Array.isArray(result.goldenPath) ? result.goldenPath : [];
  return {
    steps: goldenPath.map((s, i) => normalizeStep(s, i)),
    hasMore: !!result.has_more,
    continuationHint: result.continuation_hint || "",
    messages: out.messages,
  };
}

const EMPTY_LABELS = {
  trigger: "", routing: "", precheck: "", action: "", inputs: "",
  state: "", ui: "", failure: "", recovery: "", guardrail: "", result: "", telemetry: "",
};

function normalizeStep(raw, idx) {
  const labels = raw.labels && typeof raw.labels === "object"
    ? { ...EMPTY_LABELS, ...raw.labels }
    : EMPTY_LABELS;

  const substeps = Array.isArray(raw.substeps)
    ? raw.substeps.map((sub, si) => normalizeStep(sub, si))
    : [];

  return {
    step: String(raw.step || idx + 1),
    actor: raw.actor || "Agent",
    dialogue: raw.dialogue || "",
    labels,
    substeps,
  };
}

// ── 4. Review Blueprint ──────────────────────────────────

const REVIEW_SYSTEM = `You are a senior Salesforce Agent architect performing a quality review of an agent blueprint. Analyze the entire blueprint and provide actionable feedback.

Return a JSON object with:
{
  "score": number (0-100, overall readiness score),
  "summary": "string — one-sentence overall assessment",
  "suggestions": ["array of specific, actionable improvement suggestions"],
  "missingItems": ["array of critical items that are missing or incomplete"],
  "strengths": ["array of things that are well-defined"]
}

Rules:
- Be specific and actionable — cite field names and explain why something matters.
- Check for: completeness, consistency between charter/logic/script, guardrail coverage, fallback coverage, output format suitability for Console channel.
- Score 80+ means production-ready, 60-79 means needs minor work, below 60 means significant gaps.`;

export async function reviewBlueprint(blueprint) {
  const userMsg = `Full Blueprint:\n${JSON.stringify(blueprint, null, 2)}`;
  const result = await callLLM(REVIEW_SYSTEM, userMsg);
  return {
    score: typeof result.score === "number" ? result.score : 0,
    summary: result.summary || "",
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    missingItems: Array.isArray(result.missingItems) ? result.missingItems : [],
    strengths: Array.isArray(result.strengths) ? result.strengths : [],
  };
}

// ── 5. Optimize Blueprint ────────────────────────────────

const OPTIMIZE_SYSTEM = `You are a senior Salesforce Agent architect. You are given an agent blueprint and the results of a quality review (suggestions, missing items). Your job is to OPTIMIZE the blueprint by applying the review feedback.

Return a JSON object with the EXACT same shape as the input blueprint:

{
  "charter": { ...same charter shape... },
  "logicPlan": { "topics": [ ...array of topic objects with actionSpecs... ] },
  "annotatedScriptByTopic": {
    "<topicId>": {
      "scenarios": {
        "<scenarioId>": {
          "id": "string",
          "name": "string",
          "type": "basic" | "advanced" | "tricky" | "custom",
          "goldenPath": [
            {
              "step": "1",
              "actor": "User" | "Agent" | "Fallback Option",
              "dialogue": "string",
              "labels": {
                "trigger": "", "routing": "", "precheck": "", "action": "",
                "inputs": "", "state": "", "ui": "", "failure": "",
                "recovery": "", "guardrail": "", "result": "", "telemetry": ""
              },
              "substeps": [ ...child steps same shape... ]
            }
          ]
        }
      },
      "activeScenarioId": "string or null"
    }
  }
}

Rules:
- PRESERVE all existing user-provided values. Do NOT delete or overwrite non-empty fields.
- FILL IN empty or missing fields based on the review feedback and your expertise.
- For empty string fields: generate appropriate content based on context.
- For empty arrays: add relevant items (guardrails, prechecks, metrics, unhappy paths, etc.).
- For actionSpecs with empty fallback: generate a specific fallback strategy for that action.
- Ensure the "do not claim success without tool result" guardrail is present.
- Ensure outputInstructions has Console-appropriate output types.
- Ensure every actionSpec has a description, required inputs, outputs, and fallback.
- If topicName is empty or a placeholder like "<TopicName>", generate a meaningful name.
- Topics use these fields: topicName, topicDescription, routingAndAvailability, prechecks, actionInventory (array of {name, targetType, description, inputs, outputs}), outputInstructions, actionSpecs.
- Every script step with a non-empty action label MUST have at least 1 substep (Fallback Option).
- Be specific and practical — this is for a real Agent implementation.`;

export async function optimizeBlueprint(blueprint, reviewResult) {
  const userMsg = `Current Blueprint:\n${JSON.stringify(blueprint, null, 2)}\n\nReview Feedback:\n${JSON.stringify(reviewResult, null, 2)}\n\nPlease return the optimized blueprint JSON.`;
  const result = await callLLM(OPTIMIZE_SYSTEM, userMsg, { json: true });

  const c = result.charter || {};
  const bp = blueprint;

  const origTopics = bp.logicPlan?.topics || [];
  const optTopics = result.logicPlan?.topics || [];
  const mergedTopics = origTopics.map((orig, i) => {
    const opt = optTopics.find((t) => t.id === orig.id) || optTopics[i] || {};
    return mergeTopicResult(opt, orig);
  });
  for (const opt of optTopics) {
    if (opt.id && !mergedTopics.some((m) => m.id === opt.id)) {
      mergedTopics.push({ ...opt, id: opt.id });
    }
  }

  const mergedScriptsByTopic = { ...(bp.annotatedScriptByTopic || {}) };
  const optScriptsByTopic = result.annotatedScriptByTopic || {};
  for (const [topicId, optEntry] of Object.entries(optScriptsByTopic)) {
    const origEntry = mergedScriptsByTopic[topicId] || { scenarios: {}, activeScenarioId: null };
    const optScenarios = optEntry.scenarios || {};
    const origScenarios = origEntry.scenarios || {};
    const mergedScenarios = { ...origScenarios };
    for (const [scId, optSc] of Object.entries(optScenarios)) {
      const origSc = origScenarios[scId] || {};
      const goldenPath = Array.isArray(optSc.goldenPath) && optSc.goldenPath.length
        ? optSc.goldenPath.map((step, i) => normalizeStep(step, i))
        : origSc.goldenPath || [];
      mergedScenarios[scId] = {
        ...origSc,
        ...optSc,
        goldenPath,
      };
    }
    mergedScriptsByTopic[topicId] = {
      scenarios: mergedScenarios,
      activeScenarioId: optEntry.activeScenarioId || origEntry.activeScenarioId,
    };
  }

  const firstTopicId = mergedTopics[0]?.id;
  const firstEntry = mergedScriptsByTopic[firstTopicId] || { scenarios: {}, activeScenarioId: null };
  const firstSc = firstEntry.scenarios?.[firstEntry.activeScenarioId] || Object.values(firstEntry.scenarios || {})[0];

  return {
    ...bp,
    charter: {
      agentRole: c.agentRole || bp.charter.agentRole || "",
      agentName: c.agentName || bp.charter.agentName || "",
      goal: c.goal || bp.charter.goal || "",
      tone: c.tone || bp.charter.tone || "",
      jurisdiction: c.jurisdiction || bp.charter.jurisdiction || "",
      hardStop: c.hardStop || bp.charter.hardStop || "",
      systemObjects: Array.isArray(c.systemObjects) && c.systemObjects.length ? c.systemObjects : bp.charter.systemObjects || [],
      systemActions: Array.isArray(c.systemActions) && c.systemActions.length ? c.systemActions : bp.charter.systemActions || [],
      guardrails: Array.isArray(c.guardrails) && c.guardrails.length ? c.guardrails : bp.charter.guardrails || [],
    },
    logicPlan: {
      ...bp.logicPlan,
      topics: mergedTopics,
    },
    annotatedScript: {
      channel: "Console",
      goldenPath: firstSc?.goldenPath || bp.annotatedScript?.goldenPath || [],
    },
    annotatedScriptByTopic: mergedScriptsByTopic,
  };
}

function mergeTopicResult(optimized, original) {
  const o = optimized || {};
  const t = original || {};
  return {
    id: t.id || o.id || `topic-${Date.now()}`,
    topicName: o.topicName || t.topicName || "",
    topicDescription: o.topicDescription || t.topicDescription || "",
    routingAndAvailability: Array.isArray(o.routingAndAvailability) && o.routingAndAvailability.length ? o.routingAndAvailability : t.routingAndAvailability || [],
    prechecks: Array.isArray(o.prechecks) && o.prechecks.length ? o.prechecks : t.prechecks || [],
    actionInventory: Array.isArray(o.actionInventory) && o.actionInventory.length ? o.actionInventory : t.actionInventory || [],
    outputInstructions: Array.isArray(o.outputInstructions) && o.outputInstructions.length ? o.outputInstructions : t.outputInstructions || [],
    actionSpecs: mergeActionSpecs(o.actionSpecs, t.actionSpecs),
  };
}

function mergeActionSpecs(optimized, original) {
  const origSpecs = Array.isArray(original) ? original : [];
  const optSpecs = Array.isArray(optimized) ? optimized : [];
  if (optSpecs.length === 0) return origSpecs;

  const origMap = new Map(origSpecs.map((s) => [s.name, s]));
  const merged = optSpecs.map((s) => {
    const orig = origMap.get(s.name) || {};
    return {
      name: s.name || orig.name || "",
      implType: s.implType || orig.implType || "Flow",
      apexClass: s.apexClass || orig.apexClass || "",
      flowApiName: s.flowApiName || orig.flowApiName || "",
      promptTemplateId: s.promptTemplateId || orig.promptTemplateId || "",
      description: s.description || orig.description || "",
      requiredInputs: Array.isArray(s.requiredInputs) && s.requiredInputs.length ? s.requiredInputs : orig.requiredInputs || [],
      optionalInputs: Array.isArray(s.optionalInputs) && s.optionalInputs.length ? s.optionalInputs : orig.optionalInputs || [],
      outputs: Array.isArray(s.outputs) && s.outputs.length ? s.outputs : orig.outputs || [],
      errorModes: Array.isArray(s.errorModes) && s.errorModes.length ? s.errorModes : orig.errorModes || [],
      fallback: s.fallback || orig.fallback || "",
    };
  });

  // Keep any original specs not in the optimized set
  for (const orig of origSpecs) {
    if (!merged.some((m) => m.name === orig.name)) {
      merged.push(orig);
    }
  }
  return merged;
}

// ── 6. Generate PRD ──────────────────────────────────────

const PRD_SYSTEM = `You are a senior Product Manager writing a Product Requirements Document (PRD) for an engineering team that will implement a Salesforce Agent. You are given a structured agent blueprint containing the charter, logic plan, annotated script, and action specs.

Produce a clear, well-structured Markdown PRD with these sections:

## 1. Overview
Agent name, role, one-line goal, business context, and target channel.

## 2. User Stories / JTBD
Frame the user goal as one or more user stories in the standard "As a [persona], I want [goal], so that [outcome]" format.

## 3. Scope & Jurisdiction
What is in-scope (jurisdiction) and explicitly out-of-scope (hard stops / negative scope). Be specific.

## 4. Functional Requirements
For each topic and each action/tool the agent uses:
- Name, implementation type (Flow/Apex), description
- Required and optional inputs
- Expected outputs
- Error modes and fallback behavior

Include a brief conversation flow summary referencing the golden-path steps for each topic.

## 5. Data Objects & Variables
List CRM objects (nouns) and conversation variables the agent needs access to.

## 6. Non-Functional Requirements
- Tone & voice guidelines
- Channel constraints (Console format)
- Guardrails and safety policies
- Trust & safety rules

## 7. Acceptance Criteria
- Golden-path test scenario description
- Unhappy-path scenarios to test
- Safety test cases

## 8. Telemetry & Success Metrics
List KPIs and recommended observability events.

## 9. Technical References
Note that companion artifacts (Agent Handoff JSON Bundle and Prompt Template) are available as separate exports from the same blueprint.

## 10. Topic Matrix
Add a concise matrix table with one row per topic:
- Topic name
- Trigger/routing summary
- Primary actions
- Primary fallback strategy
- Key telemetry signals

Rules:
- Write in professional PM language — concise, specific, actionable.
- Reference concrete field names, action names, and object names from the blueprint.
- If the blueprint has multiple topics, create separate subsections per topic (e.g. "### Topic: X").
- Do NOT invent requirements that aren't in the blueprint — only organize and articulate what exists.
- Use Markdown formatting: headers, bullet lists, tables where appropriate.
- Keep the total length reasonable (aim for 1-3 pages equivalent).`;

export async function generatePRD(blueprint) {
  const userMsg = `Full Agent Blueprint:\n${JSON.stringify(blueprint, null, 2)}`;
  return await callLLM(PRD_SYSTEM, userMsg, { json: false });
}
