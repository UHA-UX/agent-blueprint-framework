/**
 * handoff-helpers.js
 * Pure functions for the Agent Handoff export tab.
 */

// ── Factory ──────────────────────────────────────────────

export function defaultActionSpec(name) {
  return {
    name,
    implType: "Flow",
    apexClass: "",
    flowApiName: "",
    promptTemplateId: "",
    description: "",
    requiredInputs: [],
    optionalInputs: [],
    outputs: [],
    errorModes: ["timeout", "no_access", "not_found", "validation_error"],
    fallback: "",
  };
}

function safeTopicId(topic, idx) {
  return topic?.id || `topic-${idx + 1}`;
}

function normalizeActionInventoryItem(item) {
  if (typeof item === "string") return { name: item, targetType: "Flow", description: "", inputs: [], outputs: [] };
  return {
    name: item.name || "",
    targetType: item.targetType || "Flow",
    description: item.description || "",
    inputs: Array.isArray(item.inputs) ? item.inputs : [],
    outputs: Array.isArray(item.outputs) ? item.outputs : [],
  };
}

function getTopics(blueprint) {
  const raw = blueprint.logicPlan?.topics || [];
  if (!raw.length) {
    return [{
      id: "topic-1",
      topicName: "",
      topicDescription: "",
      routingAndAvailability: [],
      prechecks: [],
      actionInventory: [],
      outputInstructions: [],
      actionSpecs: [],
    }];
  }
  return raw.map((t, i) => ({
    id: safeTopicId(t, i),
    topicName: t.topicName || "",
    topicDescription: t.topicDescription || "",
    routingAndAvailability: Array.isArray(t.routingAndAvailability) ? t.routingAndAvailability : [],
    prechecks: Array.isArray(t.prechecks) ? t.prechecks : [],
    actionInventory: (Array.isArray(t.actionInventory) ? t.actionInventory : []).map(normalizeActionInventoryItem),
    outputInstructions: Array.isArray(t.outputInstructions) ? t.outputInstructions : [],
    actionSpecs: Array.isArray(t.actionSpecs) ? t.actionSpecs : [],
  }));
}

function getAnnotatedScriptByTopic(blueprint) {
  const map = blueprint.annotatedScriptByTopic || {};
  if (Object.keys(map).length > 0) return map;

  return {
    "topic-1": {
      scenarios: {},
      activeScenarioId: null,
    },
  };
}

function getScenariosForTopic(topicEntry) {
  if (!topicEntry) return [];
  if (topicEntry.scenarios && typeof topicEntry.scenarios === "object") {
    return Object.values(topicEntry.scenarios);
  }
  if (topicEntry.goldenPath) {
    return [{ id: "sc-legacy", name: "Basic", type: "basic", goldenPath: topicEntry.goldenPath }];
  }
  return [];
}

function getAllGoldenPaths(topicEntry) {
  return getScenariosForTopic(topicEntry).map((sc) => sc.goldenPath || []);
}

// ── Lint / Validation ────────────────────────────────────

export function lintHandoff(blueprint) {
  const errors = [];
  const warnings = [];
  const c = blueprint.charter || {};
  const topics = getTopics(blueprint);
  const scriptsByTopic = getAnnotatedScriptByTopic(blueprint);

  // --- Errors ---
  if (!c.agentRole) errors.push("Missing required field: Agent Role");
  if (!c.agentName) errors.push("Missing required field: Agent Name");
  if (!c.goal) errors.push("Missing required field: User Goal / JTBD");
  if (!c.tone) errors.push("Missing required field: Tone & Voice");
  if (!c.jurisdiction) errors.push("Missing required field: Jurisdiction");
  if (!c.hardStop) errors.push("Missing required field: Hard Stop");
  if (topics.length === 0) errors.push("At least one Topic is required");

  const nouns = c.systemObjects || [];
  if (nouns.length === 0) errors.push("No System Objects (Nouns) defined");

  const verbs = [
    ...(c.systemActions || []),
    ...topics.flatMap((t) => (t.actionInventory || []).map((a) => a.name)),
  ];
  const uniqueVerbs = [...new Set(verbs.filter(Boolean))];
  if (uniqueVerbs.length === 0)
    errors.push("No System Actions / Verbs defined");

  const seenActionNames = new Set();
  const duplicateActionNames = new Set();
  for (const t of topics) {
    if (!t.topicName) {
      errors.push(`Topic ${safeTopicId(t, 0)}: Missing Topic Name`);
    }
    const specs = t.actionSpecs || [];
    for (const spec of specs) {
      if (seenActionNames.has(spec.name)) duplicateActionNames.add(spec.name);
      seenActionNames.add(spec.name);
      if (!spec.fallback) {
        errors.push(`Topic "${t.topicName || t.id}" Action "${spec.name}" is missing a fallback`);
      }
    }
    if ((t.actionInventory || []).length > 0 && specs.length === 0) {
      errors.push(`Topic "${t.topicName || t.id}" Action Specs not yet generated`);
    }
    const outputInstructions = t.outputInstructions || [];
    if (outputInstructions.length === 0) {
      errors.push(`Topic "${t.topicName || t.id}" Output Instructions are empty (Console requires defined output types)`);
    }
    if ((t.prechecks || []).length === 0) {
      warnings.push(`Topic "${t.topicName || t.id}" Prechecks are empty — recommend permission + context checks`);
    }
  }
  if (duplicateActionNames.size > 0) {
    warnings.push(`Duplicate action names across topics: ${Array.from(duplicateActionNames).join(", ")}`);
  }

  // Check for unsafe-claims guardrail presence
  const guardrails = c.guardrails || [];
  const hasUnsafeClaimGuard = guardrails.some(
    (g) =>
      /claim.*success.*without.*tool/i.test(g) ||
      /no.*false.*success/i.test(g) ||
      /never.*claim/i.test(g)
  );
  if (!hasUnsafeClaimGuard)
    errors.push(
      'Missing guardrail for unsafe claims (e.g., "Do not claim success without tool result")'
    );

  // --- Warnings ---
  if (!c.developerName)
    warnings.push("Developer Name is empty — required for Agent Script deployment");
  if (!c.welcomeMessage)
    warnings.push("Welcome Message is empty — required by Agent Script system block");
  if (!c.errorMessage)
    warnings.push("Error Message is empty — required by Agent Script system block");
  if (guardrails.length === 0)
    warnings.push("Guardrails are empty — recommend adding trust & safety rules");

  // --- Script-specific lint rules (iterate all scenarios) ---
  for (const t of topics) {
    const topicEntry = scriptsByTopic[t.id] || {};
    const scenarios = getScenariosForTopic(topicEntry);
    if (scenarios.length === 0) {
      warnings.push(`Topic "${t.topicName || t.id}": No scenarios defined`);
      continue;
    }

    for (const sc of scenarios) {
      const scLabel = `Topic "${t.topicName || t.id}" / ${sc.name || sc.id}`;
      const goldenPath = sc.goldenPath || [];
      const allSteps = flattenSteps(goldenPath);

      for (const s of goldenPath) {
        if (s.labels?.action && (!s.substeps || s.substeps.length === 0)) {
          errors.push(`${scLabel} Step ${s.step}: Action "${s.labels.action}" has no fallback substeps`);
        }
      }

      const capturedVars = new Set();
      for (const s of allSteps) {
        const stateVars = (s.labels?.state || "").match(/@[\w]+/g);
        if (stateVars) stateVars.forEach((v) => capturedVars.add(v));
      }
      const contextVars = new Set();
      for (const s of allSteps) {
        const precheckVars = (s.labels?.precheck || "").match(/@[\w]+/g);
        if (precheckVars) precheckVars.forEach((v) => contextVars.add(v));
      }
      for (const s of allSteps) {
        const inputVars = (s.labels?.inputs || "").match(/@[\w]+/g);
        if (!inputVars) continue;
        for (const v of inputVars) {
          if (!capturedVars.has(v) && !contextVars.has(v)) {
            errors.push(`${scLabel} Step ${s.step}: Variable "${v}" in inputs was never captured in state`);
          }
        }
      }

      for (const s of allSteps) {
        if (s.actor === "Agent" && !s.labels?.guardrail) {
          warnings.push(`${scLabel} Step ${s.step} (Agent) has no guardrail label`);
        }
      }
      for (const s of allSteps) {
        if (s.labels?.action && !s.labels?.result) {
          warnings.push(`${scLabel} Step ${s.step}: Action "${s.labels.action}" has no result label`);
        }
      }
      const hasTelemetry = allSteps.some((s) => s.labels?.telemetry);
      if (allSteps.length > 0 && !hasTelemetry) {
        warnings.push(`${scLabel}: No telemetry labels in script`);
      }
      if (goldenPath.length > 0 && goldenPath.length < 4) {
        warnings.push(`${scLabel} has only ${goldenPath.length} top-level steps (recommend 4+)`);
      }
    }
  }

  return { errors, warnings };
}

// ── Typed parameter parsing ──────────────────────────────

const AGENT_TYPES = new Set(["string", "number", "integer", "long", "boolean", "object", "date", "datetime", "time", "currency", "id"]);

function parseTypedParam(raw) {
  if (typeof raw !== "string") return { name: String(raw), type: "string" };
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    const name = raw.slice(0, colonIdx).trim();
    const typeRaw = raw.slice(colonIdx + 1).trim().toLowerCase();
    if (typeRaw.startsWith("list[")) {
      return { name, type: typeRaw };
    }
    return { name, type: AGENT_TYPES.has(typeRaw) ? typeRaw : "string" };
  }
  const name = raw.trim();
  if (/id$/i.test(name) || /^id$/i.test(name)) return { name, type: "id" };
  if (/count|quantity|amount|total|num/i.test(name)) return { name, type: "number" };
  if (/^is_|^has_|^can_|^should_/i.test(name)) return { name, type: "boolean" };
  if (/date/i.test(name)) return { name, type: "date" };
  if (/\[\]$/.test(name)) return { name: name.replace(/\[\]$/, ""), type: "list[object]" };
  return { name, type: "string" };
}

function parseTypedParams(arr) {
  return (arr || []).filter(Boolean).map(parseTypedParam);
}

function buildActionTarget(spec) {
  const type = spec.implType || spec.impl_type || "Flow";
  if (type === "Flow") return `flow://${spec.flowApiName || spec.flow_api_name || spec.name || ""}`;
  if (type === "Apex") return `apex://${spec.apexClass || spec.apex_class || spec.name || ""}`;
  if (type === "Prompt Template") return `prompt://${spec.promptTemplateId || spec.prompt_template_id || spec.name || ""}`;
  return `flow://${spec.name || ""}`;
}

function inferVariablesFromBlueprint(topics, scriptsByTopic) {
  const vars = new Map();

  for (const topic of topics) {
    for (const action of (topic.actionInventory || [])) {
      for (const raw of (action.inputs || [])) {
        const p = parseTypedParam(raw);
        if (!vars.has(p.name)) {
          vars.set(p.name, { name: p.name, type: p.type, kind: "mutable", default: "", description: `Input for ${action.name}` });
        }
      }
      for (const raw of (action.outputs || [])) {
        const p = parseTypedParam(raw);
        if (!vars.has(p.name)) {
          vars.set(p.name, { name: p.name, type: p.type, kind: "linked", default: "", description: `Output from ${action.name}` });
        }
      }
    }
  }

  for (const [, topicEntry] of Object.entries(scriptsByTopic || {})) {
    const scenarios = getScenariosForTopic(topicEntry);
    for (const sc of scenarios) {
      for (const step of flattenSteps(sc.goldenPath || [])) {
        const stateVal = step.labels?.state || "";
        const matches = stateVal.match(/@[\w]+/g);
        if (!matches) continue;
        for (const v of matches) {
          const name = v.replace(/^@/, "");
          if (!vars.has(name)) {
            const sourceMatch = stateVal.match(/source:\s*([\w]+)/i);
            vars.set(name, { name, type: "string", kind: "mutable", default: "", description: sourceMatch ? `Captured from ${sourceMatch[1]}` : "Captured from conversation" });
          }
        }
      }
    }
  }

  return Array.from(vars.values());
}

// ── Script helpers ───────────────────────────────────────

function flattenSteps(steps) {
  const out = [];
  for (const s of steps || []) {
    out.push(s);
    if (s.substeps?.length) out.push(...flattenSteps(s.substeps));
  }
  return out;
}

function extractVariableMap(steps) {
  const vars = [];
  const seen = new Set();
  for (const s of flattenSteps(steps)) {
    const stateVal = s.labels?.state || "";
    if (!stateVal) continue;
    const matches = stateVal.match(/@[\w]+/g);
    if (!matches) continue;
    for (const v of matches) {
      if (seen.has(v)) continue;
      seen.add(v);
      const sourceMatch = stateVal.match(/source:\s*([\w]+)/i);
      vars.push({
        name: v,
        source: sourceMatch ? sourceMatch[1] : "unknown",
        captured_at_step: s.step,
      });
    }
  }
  return vars;
}

function extractUnhappyPathMatrix(steps) {
  const matrix = [];
  for (const s of flattenSteps(steps)) {
    const fail = s.labels?.failure;
    const recov = s.labels?.recovery;
    if (!fail) continue;
    matrix.push({
      step: s.step,
      actor: s.actor,
      failure: fail,
      recovery: recov || "none specified",
    });
  }
  return matrix;
}

// ── Step serializer (for JSON export) ────────────────────

function serializeStep(step) {
  const labels = step.labels || {};
  const filledLabels = {};
  for (const k of ["trigger","routing","precheck","action","inputs","state","ui","failure","recovery","guardrail","result","telemetry"]) {
    if (labels[k]) filledLabels[k] = labels[k];
  }
  return {
    step: step.step,
    actor: step.actor,
    dialogue: step.dialogue || "",
    labels: filledLabels,
    substeps: (step.substeps || []).map(serializeStep),
  };
}

// ── Start Agent Block Generation ─────────────────────────

function buildStartAgentBlock(topics) {
  const transitions = [];
  for (const topic of topics) {
    const topicDevName = (topic.topicName || topic.id || "").replace(/\s+/g, "_");
    const routing = topic.routingAndAvailability || [];
    const availableWhen = routing.filter((r) => /available\s*when/i.test(r));
    const description = topic.topicDescription || `Handle ${topicDevName} requests`;
    transitions.push({
      tool_name: `go_to_${topicDevName.toLowerCase()}`,
      transition_to: `@topic.${topicDevName}`,
      description,
      available_when: availableWhen.length > 0
        ? availableWhen.map((r) => r.replace(/^.*?available\s*when\s*/i, "").trim())
        : [],
    });
  }
  return {
    _maps_to: "Agent Script start_agent block (Topic Selector)",
    description: "Classify user intent and route to the appropriate topic.",
    reasoning_actions: transitions,
  };
}

// ── JSON Export Bundle (Agent-aligned) ──────────────

export function buildAgentHandoffPackage(blueprint) {
  const c = blueprint.charter || {};
  const topics = getTopics(blueprint);
  const scriptsByTopic = getAnnotatedScriptByTopic(blueprint);

  const bundleTopics = topics.map((topic, idx) => {
    const topicId = safeTopicId(topic, idx);
    const specs = topic.actionSpecs || [];
    const topicEntry = scriptsByTopic[topicId] || {};
    const scenarios = getScenariosForTopic(topicEntry);
    const allGoldenPaths = scenarios.map((sc) => sc.goldenPath || []);
    const primaryPath = allGoldenPaths[0] || [];
    const inventoryNames = (topic.actionInventory || []).map((a) => a.name).filter(Boolean);
    const allActions = [...new Set([...(c.systemActions || []), ...inventoryNames])];
    const variableMap = extractVariableMap(primaryPath);
    const unhappyMatrix = extractUnhappyPathMatrix(primaryPath);
    const topicDescription = topic.topicDescription || (c.goal ? `Handle user requests related to: ${c.goal}` : "");
    const topicInstructions = [];
    if (c.tone) topicInstructions.push(`Respond with a ${c.tone} tone.`);
    if (c.jurisdiction) topicInstructions.push(`Jurisdiction: ${c.jurisdiction}.`);
    if (c.hardStop) topicInstructions.push(`HARD STOP: ${c.hardStop}.`);
    for (const g of (c.guardrails || [])) topicInstructions.push(g);
    topicInstructions.push("Only reference data returned by tools or provided in context.");
    topicInstructions.push("Before calling a tool, ensure required inputs are present; otherwise ask ONE clarifying question.");
    topicInstructions.push("Never claim the record was updated unless the tool returns success.");

    return {
      topic_id: topicId,
      topic_configuration: {
        _maps_to: "GenAiPlugin (Agent Topic)",
        topic_name: topic.topicName || "",
        topic_description: topicDescription,
        scope: `Objects: ${(c.systemObjects || []).join(", ") || "none"}. Actions: ${allActions.join(", ") || "none"}.`,
        classification_description: `Route to this topic when: ${(topic.routingAndAvailability || []).join("; ") || "any intent related to " + (c.goal || "this topic")}.`,
        instructions: topicInstructions,
        routing_and_availability: topic.routingAndAvailability || [],
        prechecks: topic.prechecks || [],
        actions: allActions,
        action_inventory: (topic.actionInventory || []).map((a) => ({
          name: a.name,
          target_type: a.targetType || "Flow",
          target: buildActionTarget({ implType: a.targetType, flowApiName: a.name, apexClass: a.name, promptTemplateId: a.name, name: a.name }),
          description: a.description || "",
          inputs: parseTypedParams(a.inputs),
          outputs: parseTypedParams(a.outputs),
        })),
        output_instructions: topic.outputInstructions || [],
      },
      action_specs: specs.map((s) => ({
        _maps_to: "Agent Action (GenAiFunction)",
        name: s.name,
        impl_type: s.implType,
        target: buildActionTarget(s),
        flow_api_name: s.implType === "Flow" ? (s.flowApiName || "") : undefined,
        apex_class: s.implType === "Apex" ? (s.apexClass || "") : undefined,
        prompt_template_id: s.implType === "Prompt Template" ? (s.promptTemplateId || "") : undefined,
        description: s.description,
        required_inputs: parseTypedParams(s.requiredInputs),
        optional_inputs: parseTypedParams(s.optionalInputs),
        outputs: parseTypedParams(s.outputs),
        error_modes: s.errorModes,
        fallback: s.fallback,
      })),
      conversation_variables: {
        _maps_to: "BotVersion ConversationVariable",
        legacy_variable_map: variableMap,
        typed_variables: inferVariablesFromBlueprint([topic], { [topicId]: topicEntry }),
      },
      conversation_flow: {
        channel: c.channel || "Console",
        scenarios: scenarios.map((sc) => ({
          scenario_id: sc.id,
          scenario_name: sc.name || sc.type || "Unnamed",
          scenario_type: sc.type || "basic",
          golden_path: (sc.goldenPath || []).map(serializeStep),
          unhappy_path_scenarios: extractUnhappyPathMatrix(sc.goldenPath || []),
        })),
      },
      acceptance_criteria: {
        golden_path_test:
          "Seeded Console scenario: run end-to-end happy path and verify output + state changes.",
        unhappy_path_matrix: unhappyMatrix.length > 0
          ? unhappyMatrix.map((u) => `Step ${u.step}: ${u.failure} → ${u.recovery}`)
          : ["missing_input", "no_results", "multiple_matches", "no_access", "tool_timeout_or_error"],
        safety_tests: [
          "hard_stop_enforced",
          "no_false_success_claim",
          "pii_masking_check",
        ],
      },
    };
  });

  return {
    package_version: "1.0",
    generated_at: new Date().toISOString(),

    // ── Maps to: Bot / BotVersion / AiAuthoringBundle metadata ──
    agent_definition: {
      _maps_to: "Bot / BotVersion / AiAuthoringBundle config block",
      display_name: c.agentName || "",
      developer_name: c.developerName || "",
      role: c.agentRole || "",
      description: `${c.agentRole || "Agent"} — ${c.goal || ""}`.trim(),
      agent_type: c.agentType || "AgentServiceAgent",
      primary_jtbd: c.goal || "",
      tone: c.tone || "",
      channel: c.channel || "Console",
    },

    system_block: {
      _maps_to: "Agent Script system block",
      messages: {
        welcome: c.welcomeMessage || "",
        error: c.errorMessage || "",
      },
    },

    start_agent_block: buildStartAgentBlock(topics),

    topics: bundleTopics,

    global_variables: {
      _maps_to: "Agent Script variables block",
      inferred_variables: inferVariablesFromBlueprint(topics, scriptsByTopic),
      data_objects: c.systemObjects || [],
    },

    // ── Guardrails & Policy ──
    guardrails_and_policy: {
      jurisdiction: c.jurisdiction || "",
      hard_stops: [c.hardStop].filter(Boolean),
      guardrails: c.guardrails || [],
      safety_notes: [
        "Do not claim success without tool result.",
        "Mask sensitive data in Console responses when applicable.",
      ],
    },

    // ── Telemetry ──
    telemetry: {
      recommended_events: [
        "agent_invoked",
        "intent_routed",
        "precheck_failed",
        "tool_called",
        "tool_result",
        "fallback_used",
        "handoff_to_human",
      ],
    },

    // ── Design Context (preserves P1/P2 intent for engineers) ──
    design_context: {
      user_goal: c.goal || "",
      design_rationale: `This agent was designed to serve as a ${c.agentRole || "specialist"} helping users ${c.goal || "accomplish their task"}. The golden-path script captures the intended conversation flow. Guardrails and fallback scenarios reflect the design team's risk assessment. Engineers should preserve the design intent (tone, jurisdiction boundaries, hard stops) when implementing Flows and Apex actions.`,
    },
  };
}

// ── Agent Script (.agent) Export ─────────────────────────

export function buildAgentScript(blueprint) {
  const c = blueprint.charter || {};
  const topics = getTopics(blueprint);
  const scriptsByTopic = getAnnotatedScriptByTopic(blueprint);
  const allVars = inferVariablesFromBlueprint(topics, scriptsByTopic);
  const lines = [];
  const indent = (n) => "  ".repeat(n);

  lines.push("# ─────────────────────────────────────────────────────────────");
  lines.push("# REFERENCE ONLY — This is NOT deployable Salesforce metadata.");
  lines.push("# Use this as a design reference when building your Agent in");
  lines.push("# Salesforce Setup or generating SFDX metadata (BotVersion,");
  lines.push("# GenAiPlugin, GenAiPlannerFunctionInvocable).");
  lines.push("# ─────────────────────────────────────────────────────────────");
  lines.push("");

  // ── system block ──
  lines.push("system:");
  lines.push(`${indent(1)}messages:`);
  lines.push(`${indent(2)}welcome:`);
  if (c.welcomeMessage) {
    lines.push(`${indent(3)}| ${c.welcomeMessage}`);
  } else {
    lines.push(`${indent(3)}| Hello! How can I help you today?`);
  }
  lines.push(`${indent(2)}error:`);
  if (c.errorMessage) {
    lines.push(`${indent(3)}| ${c.errorMessage}`);
  } else {
    lines.push(`${indent(3)}| I'm sorry, something went wrong. Please try again.`);
  }
  lines.push("");

  // ── config block ──
  const devName = c.developerName || toDevName(c.agentName) || "My_Agent";
  lines.push("config:");
  lines.push(`${indent(1)}developer_name: "${devName}"`);
  if (c.agentName) lines.push(`${indent(1)}agent_label: "${c.agentName}"`);
  lines.push(`${indent(1)}description: "${(c.agentRole || "Agent")} — ${(c.goal || "").replace(/"/g, '\\"')}"`);
  if (c.agentRole) lines.push(`${indent(1)}role: "${c.agentRole.replace(/"/g, '\\"')}"`);
  lines.push(`${indent(1)}agent_type: ${c.agentType || "AgentServiceAgent"}`);
  lines.push("");

  // ── variables block ──
  if (allVars.length > 0) {
    lines.push("variables:");
    for (const v of allVars) {
      const mutability = v.kind === "linked" ? "" : "mutable ";
      const defaultVal = v.default ? ` = ${JSON.stringify(v.default)}` : "";
      lines.push(`${indent(1)}${v.name}: ${mutability}${v.type}${defaultVal}`);
      if (v.description) lines.push(`${indent(2)}description: "${v.description.replace(/"/g, '\\"')}"`);
    }
    lines.push("");
  }

  // ── start_agent block ──
  lines.push("start_agent topic_selector:");
  lines.push(`${indent(1)}description: "Classify user intent and route to the appropriate topic."`);
  lines.push(`${indent(1)}reasoning:`);

  const guardrailText = [];
  if (c.tone) guardrailText.push(`Respond with a ${c.tone} tone.`);
  if (c.jurisdiction) guardrailText.push(`Jurisdiction: ${c.jurisdiction}.`);
  if (c.hardStop) guardrailText.push(`HARD STOP: ${c.hardStop}.`);
  if (guardrailText.length > 0) {
    lines.push(`${indent(2)}| ${guardrailText.join(" ")}`);
  }

  lines.push(`${indent(2)}actions:`);
  for (const topic of topics) {
    const topicDevName = toDevName(topic.topicName) || topic.id;
    lines.push(`${indent(3)}go_to_${topicDevName.toLowerCase()}:`);
    lines.push(`${indent(4)}@utils.transition to @topic.${topicDevName}`);
    if (topic.topicDescription) {
      lines.push(`${indent(4)}description: "${topic.topicDescription.replace(/"/g, '\\"')}"`);
    }
    const routing = topic.routingAndAvailability || [];
    const avail = routing.filter((r) => /available\s*when/i.test(r));
    if (avail.length > 0) {
      const cond = avail.map((r) => r.replace(/^.*?available\s*when\s*/i, "").trim()).join(" and ");
      lines.push(`${indent(4)}available when ${cond}`);
    }
  }
  lines.push("");

  // ── topic blocks ──
  for (const topic of topics) {
    const topicDevName = toDevName(topic.topicName) || topic.id;
    lines.push(`topic ${topicDevName}:`);
    if (topic.topicDescription) {
      lines.push(`${indent(1)}description: "${topic.topicDescription.replace(/"/g, '\\"')}"`);
    }

    // actions
    const allActionItems = topic.actionInventory || [];
    const allSpecs = topic.actionSpecs || [];
    if (allActionItems.length > 0 || allSpecs.length > 0) {
      lines.push(`${indent(1)}actions:`);
      for (const action of allActionItems) {
        const actionName = toDevName(action.name) || "unnamed_action";
        lines.push(`${indent(2)}${actionName}:`);
        if (action.description) lines.push(`${indent(3)}description: "${action.description.replace(/"/g, '\\"')}"`);
        const matchingSpec = allSpecs.find((s) => s.name === action.name);
        const target = matchingSpec ? buildActionTarget(matchingSpec) : buildActionTarget({ implType: action.targetType, name: action.name });
        lines.push(`${indent(3)}target: "${target}"`);
        const inputs = parseTypedParams(action.inputs);
        if (inputs.length > 0) {
          lines.push(`${indent(3)}inputs:`);
          for (const p of inputs) lines.push(`${indent(4)}${p.name}: ${p.type}`);
        }
        const outputs = parseTypedParams(action.outputs);
        if (outputs.length > 0) {
          lines.push(`${indent(3)}outputs:`);
          for (const p of outputs) lines.push(`${indent(4)}${p.name}: ${p.type}`);
        }
      }
    }

    // reasoning
    lines.push(`${indent(1)}reasoning:`);

    // logic instructions from prechecks
    const prechecks = topic.prechecks || [];
    if (prechecks.length > 0) {
      for (const pc of prechecks) {
        if (pc.includes("==") || pc.includes("!=") || pc.startsWith("@")) {
          lines.push(`${indent(2)}if ${pc}:`);
          lines.push(`${indent(3)}# Add deterministic logic here`);
        }
      }
    }

    // prompt instructions from golden path
    const topicEntry = scriptsByTopic[topic.id] || {};
    const scenarios = getScenariosForTopic(topicEntry);
    const promptParts = [];
    if (c.tone) promptParts.push(`Respond with a ${c.tone} tone.`);
    if (c.jurisdiction) promptParts.push(`Jurisdiction: ${c.jurisdiction}.`);
    if (c.hardStop) promptParts.push(`HARD STOP: ${c.hardStop}.`);
    for (const g of (c.guardrails || [])) promptParts.push(g);

    if (scenarios.length > 0) {
      const primarySc = scenarios[0];
      const agentSteps = (primarySc.goldenPath || []).filter((s) => s.actor === "Agent");
      for (const step of agentSteps) {
        if (step.dialogue) promptParts.push(step.dialogue);
      }
    }

    if (promptParts.length > 0) {
      lines.push(`${indent(2)}| ${promptParts[0]}`);
      for (let i = 1; i < promptParts.length; i++) {
        lines.push(`${indent(2)}  ${promptParts[i]}`);
      }
    }

    // reasoning actions (tools exposed to LLM)
    if (allActionItems.length > 0) {
      lines.push(`${indent(2)}actions:`);
      for (const action of allActionItems) {
        const actionName = toDevName(action.name) || "unnamed_action";
        const toolName = `${actionName}_tool`;
        lines.push(`${indent(3)}${toolName}:`);
        lines.push(`${indent(4)}@actions.${actionName}`);
        if (action.description) lines.push(`${indent(4)}description: "${action.description.replace(/"/g, '\\"')}"`);
        const inputs = parseTypedParams(action.inputs);
        for (const p of inputs) {
          lines.push(`${indent(4)}with ${p.name}=@variables.${p.name}`);
        }
        const outputs = parseTypedParams(action.outputs);
        for (const p of outputs) {
          lines.push(`${indent(4)}set @variables.${p.name}=@outputs.${p.name}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function toDevName(label) {
  if (!label) return "";
  return label
    .replace(/[^a-zA-Z0-9\s_]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
}

// ── Prompt Template ──────────────────────────────────────

export function buildPromptTemplate(blueprint) {
  const c = blueprint.charter || {};
  const topics = getTopics(blueprint);
  const scriptsByTopic = getAnnotatedScriptByTopic(blueprint);

  const lines = [];
  const hr = "─".repeat(60);

  // ── 0. DESIGN INTENT ──
  lines.push("## 0 ── DESIGN INTENT");
  lines.push("");
  lines.push("This prompt template was generated from a structured Agent Blueprint authored by the design team. It captures the intended behavior, guardrails, and conversation flow. Engineers implementing Flows/Apex should preserve these design decisions.");
  lines.push("");
  if (c.goal) lines.push(`**User Goal:** ${c.goal}`);
  if (c.agentRole) lines.push(`**Agent Role:** ${c.agentRole}`);
  const topicNames = topics.map((t) => t.topicName || t.id).filter(Boolean);
  if (topicNames.length > 0) lines.push(`**Topics:** ${topicNames.join(", ")}`);
  lines.push("");
  lines.push(hr);
  lines.push("");

  // ── 1. SYSTEM / ROLE ──
  lines.push("## 1 ── SYSTEM / ROLE");
  lines.push("");
  lines.push(`You are **${c.agentName || "<AgentName>"}**, a ${c.agentRole || "<AgentRole>"}.`);
  if (c.developerName) lines.push(`Developer Name: \`${c.developerName}\``);
  if (c.agentType) lines.push(`Agent Type: ${c.agentType}`);
  lines.push("");
  lines.push(`**Primary JTBD:** ${c.goal || "<Goal>"}`);
  lines.push(`**Tone:** ${c.tone || "<Tone>"}`);
  lines.push(`**Jurisdiction:** ${c.jurisdiction || "<Jurisdiction>"}`);
  lines.push("");
  if (c.welcomeMessage) {
    lines.push(`**Welcome Message:** ${c.welcomeMessage}`);
    lines.push("");
  }
  if (c.errorMessage) {
    lines.push(`**Error Message:** ${c.errorMessage}`);
    lines.push("");
  }
  lines.push("**Hard Stops (never violate):**");
  if (c.hardStop) {
    lines.push(`- ${c.hardStop}`);
  } else {
    lines.push("- <define hard stops>");
  }
  lines.push("");
  lines.push(hr);
  lines.push("");

  // ── 2. TOOLS ──
  lines.push("## 2 ── TOOLS");
  lines.push("");
  const allSpecs = topics.flatMap((t) => (t.actionSpecs || []).map((s) => ({ ...s, _topic: t.topicName || t.id })));
  if (allSpecs.length === 0) {
    lines.push("_No action specs defined yet._");
  } else {
    for (const s of allSpecs) {
      lines.push(`### ${s.name}  (${s.implType})`);
      lines.push(`- Topic: ${s._topic}`);
      lines.push(`- Target: \`${buildActionTarget(s)}\``);
      if (s.implType === "Flow" && s.flowApiName)
        lines.push(`- Flow API Name: \`${s.flowApiName}\``);
      if (s.implType === "Apex" && s.apexClass)
        lines.push(`- Apex Class: \`${s.apexClass}\``);
      if (s.implType === "Prompt Template" && s.promptTemplateId)
        lines.push(`- Prompt Template ID: \`${s.promptTemplateId}\``);
      if (s.description) lines.push(`- Description: ${s.description}`);
      const typedInputs = parseTypedParams(s.requiredInputs);
      const typedOptInputs = parseTypedParams(s.optionalInputs);
      const typedOutputs = parseTypedParams(s.outputs);
      lines.push(
        `- Required Inputs: ${typedInputs.length ? typedInputs.map((p) => `${p.name}: ${p.type}`).join(", ") : "none"}`
      );
      lines.push(
        `- Optional Inputs: ${typedOptInputs.length ? typedOptInputs.map((p) => `${p.name}: ${p.type}`).join(", ") : "none"}`
      );
      lines.push(
        `- Outputs: ${typedOutputs.length ? typedOutputs.map((p) => `${p.name}: ${p.type}`).join(", ") : "none"}`
      );
      lines.push(
        `- Error Modes: ${s.errorModes.length ? s.errorModes.join(", ") : "none"}`
      );
      lines.push(`- Fallback: ${s.fallback || "⚠️ NOT DEFINED"}`);
      lines.push("");
    }
  }
  lines.push(hr);
  lines.push("");

  // ── 2b. TOPIC INSTRUCTIONS (maps to GenAiPlugin) ──
  if (topics.length > 0) {
    lines.push("## 2b ── TOPIC INSTRUCTIONS");
    lines.push("");
    for (const topic of topics) {
      lines.push(`### Topic: ${topic.topicName || topic.id}`);
      if (topic.topicDescription) {
        lines.push(`- Description: ${topic.topicDescription}`);
      } else if (c.goal) {
        lines.push(`- Description: Handle user requests related to: ${c.goal}`);
      }
      const topicSpecs = topic.actionSpecs || [];
      const inventoryNames = (topic.actionInventory || []).map((a) => a.name).filter(Boolean);
      const actionNames = topicSpecs.length ? topicSpecs.map(s => s.name) : inventoryNames;
      const scope = `Objects: ${(c.systemObjects || []).join(", ") || "none"}. Actions: ${actionNames.join(", ") || "none"}.`;
      lines.push(`- Scope: ${scope}`);
      if ((topic.routingAndAvailability || []).length > 0) {
        lines.push(`- Routing & Availability: ${topic.routingAndAvailability.join("; ")}`);
      }
      if ((topic.prechecks || []).length > 0) {
        lines.push("- Pre-reasoning checks:");
        for (const p of topic.prechecks) lines.push(`  - ${p}`);
      }
      lines.push("");
    }
    lines.push(hr);
    lines.push("");
  }

  // ── 3. EXECUTION RULES ──
  lines.push("## 3 ── EXECUTION RULES");
  lines.push("");
  const defaultRules = [
    "Only reference data returned by tools or provided in context.",
    "Before calling a tool, ensure required inputs are present; otherwise ask ONE clarifying question.",
    "Never claim the record was updated unless the tool returns success.",
    `Prefer ${c.channel || "Console"}-friendly outputs: concise summary + next actions.`,
    "If a tool errors, retry once. If it fails again, hand off to a human agent.",
  ];
  const guardrails = c.guardrails || [];
  const allRules = [...defaultRules, ...guardrails];
  for (const r of allRules) {
    lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push(hr);
  lines.push("");

  // ── 4. OUTPUT FORMAT ──
  const channel = c.channel || "Console";
  lines.push(`## 4 ── OUTPUT FORMAT (${channel})`);
  lines.push("");
  lines.push("Every response MUST follow this structure:");
  lines.push("");
  lines.push("```");
  lines.push("**[Title]**");
  lines.push("");
  lines.push("[Summary — 2-3 lines max]");
  lines.push("");
  lines.push("Key fields:");
  lines.push("- Field 1: value");
  lines.push("- Field 2: value");
  lines.push("");
  lines.push("Next actions:");
  lines.push("[ Button / Quick Action 1 ]  [ Button / Quick Action 2 ]");
  lines.push("```");
  lines.push("");
  lines.push("If blocked or ambiguous:");
  lines.push("");
  lines.push("```");
  lines.push("I need one more piece of information:");
  lines.push("[Single clarifying question]");
  lines.push("");
  lines.push("Suggested replies:");
  lines.push("[ Quick Reply A ]  [ Quick Reply B ]  [ Quick Reply C ]");
  lines.push("```");
  lines.push("");
  lines.push(hr);
  lines.push("");

  // ── 5. CONVERSATION FLOW ──
  lines.push("## 5 ── CONVERSATION FLOW (Scenarios)");
  lines.push("");

  const renderFlowStep = (step, indent = "") => {
    lines.push(`${indent}### Step ${step.step}  [${step.actor}]`);
    if (step.dialogue) lines.push(`${indent}> ${step.dialogue}`);
    const labels = step.labels || {};
    const labelKeys = ["trigger","routing","precheck","action","inputs","state","ui","failure","recovery","guardrail","result","telemetry"];
    const filledLabels = labelKeys.filter((k) => labels[k]);
    if (filledLabels.length > 0) {
      lines.push(`${indent}| Label | Value |`);
      lines.push(`${indent}|-------|-------|`);
      for (const k of filledLabels) {
        const display = k.charAt(0).toUpperCase() + k.slice(1);
        lines.push(`${indent}| ${display} | ${labels[k]} |`);
      }
    }
    lines.push("");
    for (const sub of step.substeps || []) renderFlowStep(sub, indent + "  ");
  };

  for (const topic of topics) {
    const topicEntry = scriptsByTopic[topic.id] || {};
    const scenarios = getScenariosForTopic(topicEntry);
    if (scenarios.length === 0) continue;
    lines.push(`### Topic: ${topic.topicName || topic.id}`);
    lines.push("");

    for (const sc of scenarios) {
      const goldenPath = sc.goldenPath || [];
      if (goldenPath.length === 0) continue;
      lines.push(`#### Scenario: ${sc.name || sc.id} (${sc.type || "basic"})`);
      lines.push("");
      lines.push("Follow this reference conversation flow. Each step includes structured annotations that describe the system logic you MUST follow.");
      lines.push("");

      for (const step of goldenPath) renderFlowStep(step);

      const varMap = extractVariableMap(goldenPath);
      if (varMap.length > 0) {
        lines.push("#### Variable Map");
        lines.push("");
        lines.push("| Variable | Source | Captured At |");
        lines.push("|----------|--------|-------------|");
        for (const v of varMap) lines.push(`| ${v.name} | ${v.source} | Step ${v.captured_at_step} |`);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}
