const EXTENSION_ID = 'bobocloud.ai-agent';
const PROVIDER_ID = EXTENSION_ID + '.workbench';
const STORAGE_SCHEMA_VERSION = 1;
const MAX_SESSIONS = 100;
const MAX_MESSAGES = 200;
const MAX_TIMELINE = 240;
const MAX_MODEL_ROUNDS = 12;
const MAX_SKILL_CONTEXT = 160 * 1024;
const MAX_SESSION_MESSAGE_CHARS = 512 * 1024;
const MAX_SESSION_TIMELINE_CHARS = 256 * 1024;
const MAX_PERSISTED_BYTES = 6 * 1024 * 1024;

const COMMANDS = Object.freeze({
  create: EXTENSION_ID + '.createSession',
  select: EXTENSION_ID + '.selectSession',
  delete: EXTENSION_ID + '.deleteSession',
  send: EXTENSION_ID + '.send',
  cancel: EXTENSION_ID + '.cancel',
  approve: EXTENSION_ID + '.approve',
  reject: EXTENSION_ID + '.reject',
  preferences: EXTENSION_ID + '.preferences',
  configure: EXTENSION_ID + '.configure'
});

const TOOL_DEFINITIONS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'workspace_list',
      description: 'List files and directories in the active local workspace. Paths are workspace-relative.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory or file. Use . for the root.' },
          depth: { type: 'integer', minimum: 0, maximum: 8 },
          limit: { type: 'integer', minimum: 1, maximum: 2000 }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_read',
      description: 'Read one UTF-8 text file in the active local workspace and return its SHA-256 hash.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_search',
      description: 'Search supported text files in the active local workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          caseSensitive: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 500 }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_write',
      description: 'Request approval to create or replace one UTF-8 workspace file. Supply expectedSha256 after reading an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          expectedSha256: { type: 'string', description: 'SHA-256 returned by workspace_read for an existing file.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'process_run',
      description: 'Request approval to run one allowlisted executable with structured arguments and shell disabled.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' }, maxItems: 128 },
          cwd: { type: 'string', description: 'Workspace-relative working directory.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  }
]);

let runtime = null;

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function text(value, maximum = 256 * 1024) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(value);
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function selectedMode(value) {
  return value === 'goal' ? 'goal' : 'chat';
}

function selectedEffort(value) {
  return ['low', 'medium', 'high', 'max'].includes(value) ? value : 'medium';
}

function selectedSkills(value) {
  return Array.isArray(value) ? [...new Set(value.filter(validId))].slice(0, 64) : [];
}

function translated(key, values) {
  return runtime ? runtime.context.i18n.t(key, values) : key;
}

function errorMessage(error) {
  if (!error) return translated('error.unknown');
  const code = text(error.code, 120);
  const known = {
    AGENT_MODEL_UNCONFIGURED: 'error.modelUnconfigured',
    AGENT_NO_WORKSPACE: 'error.noWorkspace',
    AGENT_STALE_WORKSPACE: 'error.workspaceChanged',
    AGENT_FILE_CHANGED: 'error.fileChanged',
    AGENT_APPROVAL_EXPIRED: 'error.approvalExpired',
    AGENT_APPROVAL_NOT_FOUND: 'error.approvalExpired',
    EXTENSION_PERMISSION_DENIED: 'error.permissionDenied',
    EXTENSION_CANCELLED: 'error.cancelled'
  };
  if (known[code]) return translated(known[code]);
  return text(error.message, 2000) || translated('error.unknown');
}

function normalizeMessage(value) {
  if (!plain(value) || !validId(value.id) || !['user', 'assistant', 'system'].includes(value.role)) return null;
  return {
    id: value.id,
    role: value.role,
    content: text(value.content),
    reasoning: text(value.reasoning),
    createdAt: text(value.createdAt, 64) || now()
  };
}

function normalizeTimeline(value) {
  if (!plain(value) || !validId(value.id)) return null;
  return {
    id: value.id,
    kind: ['thought', 'tool', 'status', 'skill', 'error'].includes(value.kind) ? value.kind : 'status',
    titleKey: text(value.titleKey, 160) || 'timeline.status',
    titleValues: plain(value.titleValues) ? value.titleValues : {},
    detail: text(value.detail, 32 * 1024),
    status: ['pending', 'running', 'waiting', 'completed', 'failed', 'rejected'].includes(value.status) ? value.status : 'completed',
    createdAt: text(value.createdAt, 64) || now()
  };
}

function normalizeGoal(value) {
  if (!plain(value) || !Array.isArray(value.steps)) return null;
  return {
    title: text(value.title, 300) || translated('goal.defaultTitle'),
    status: ['pending', 'in-progress', 'completed', 'blocked'].includes(value.status) ? value.status : 'pending',
    steps: value.steps.slice(0, 8).map((step, index) => ({
      id: validId(step && step.id) ? step.id : 'step-' + index,
      titleKey: text(step && step.titleKey, 160) || 'goal.step.understand',
      status: ['pending', 'in-progress', 'completed', 'blocked'].includes(step && step.status) ? step.status : 'pending'
    }))
  };
}

function normalizeSession(value) {
  if (!plain(value) || !validId(value.id)) return null;
  const status = ['idle', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled'].includes(value.status)
    ? value.status
    : 'idle';
  const session = {
    id: value.id,
    title: text(value.title, 160),
    createdAt: text(value.createdAt, 64) || now(),
    updatedAt: text(value.updatedAt, 64) || now(),
    status: status === 'running' || status === 'waiting-approval' ? 'cancelled' : status,
    mode: selectedMode(value.mode),
    reasoningEffort: selectedEffort(value.reasoningEffort),
    modelRef: validId(value.modelRef) ? value.modelRef : '',
    skillIds: selectedSkills(value.skillIds),
    messages: Array.isArray(value.messages) ? value.messages.map(normalizeMessage).filter(Boolean).slice(-MAX_MESSAGES) : [],
    timeline: Array.isArray(value.timeline) ? value.timeline.map(normalizeTimeline).filter(Boolean).slice(-MAX_TIMELINE) : [],
    goal: normalizeGoal(value.goal)
  };
  if (status === 'running' || status === 'waiting-approval') {
    session.timeline.push(makeTimeline('status', 'timeline.interrupted', '', 'rejected'));
  }
  let messageCharacters = session.messages.reduce((total, item) => total + item.content.length + item.reasoning.length, 0);
  while (messageCharacters > MAX_SESSION_MESSAGE_CHARS && session.messages.length > 1) {
    messageCharacters -= session.messages[0].content.length + session.messages[0].reasoning.length;
    session.messages.shift();
  }
  let timelineCharacters = session.timeline.reduce((total, item) => total + item.detail.length, 0);
  while (timelineCharacters > MAX_SESSION_TIMELINE_CHARS && session.timeline.length > 1) {
    timelineCharacters -= session.timeline[0].detail.length;
    session.timeline.shift();
  }
  return session;
}

function loadState(value) {
  const source = plain(value) && value.schemaVersion === STORAGE_SCHEMA_VERSION ? value : {};
  const preferences = plain(source.preferences) ? source.preferences : {};
  const sessions = Array.isArray(source.sessions)
    ? source.sessions.map(normalizeSession).filter(Boolean).slice(-MAX_SESSIONS)
    : [];
  return {
    sessions,
    activeSessionId: sessions.some((session) => session.id === source.activeSessionId)
      ? source.activeSessionId
      : (sessions[0] && sessions[0].id || ''),
    preferences: {
      mode: selectedMode(preferences.mode),
      reasoningEffort: selectedEffort(preferences.reasoningEffort),
      modelRef: validId(preferences.modelRef) ? preferences.modelRef : '',
      skillIds: selectedSkills(preferences.skillIds)
    }
  };
}

function makeTimeline(kind, titleKey, detail = '', status = 'completed', titleValues = {}) {
  return { id: id('event'), kind, titleKey, titleValues, detail: text(detail, 32 * 1024), status, createdAt: now() };
}

function makeGoal(prompt) {
  return {
    title: text(prompt.trim(), 300) || translated('goal.defaultTitle'),
    status: 'in-progress',
    steps: [
      { id: id('step'), titleKey: 'goal.step.understand', status: 'in-progress' },
      { id: id('step'), titleKey: 'goal.step.inspect', status: 'pending' },
      { id: id('step'), titleKey: 'goal.step.act', status: 'pending' },
      { id: id('step'), titleKey: 'goal.step.summarize', status: 'pending' }
    ]
  };
}

function activeSession() {
  return runtime.sessions.find((session) => session.id === runtime.activeSessionId) || null;
}

function sessionTitle(session) {
  return session.title || translated('session.untitled');
}

function stateGoal(goal) {
  if (!goal) return null;
  return {
    title: goal.title,
    status: goal.status,
    steps: goal.steps.map((step) => ({ id: step.id, title: translated(step.titleKey), status: step.status }))
  };
}

function stateTimeline(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: translated(item.titleKey, item.titleValues),
    detail: item.detail,
    status: item.status,
    createdAt: item.createdAt
  };
}

function approvalState(pending) {
  return pending ? { id: pending.approval.id } : null;
}

function stateSnapshot() {
  const current = activeSession();
  const configured = runtime.models.some((model) => model.configured);
  let phase = configured ? 'ready' : 'unconfigured';
  let message = configured ? translated('state.ready') : translated('state.unconfigured');
  if (runtime.catalogError) {
    phase = 'error';
    message = runtime.catalogError;
  } else if (current) {
    if (current.status === 'running') message = translated('state.running');
    if (current.status === 'waiting-approval') message = translated('state.waitingApproval');
    if (current.status === 'failed') message = translated('state.failed');
    if (current.status === 'cancelled') message = translated('state.cancelled');
  }
  return {
    phase,
    message,
    activeSessionId: current ? current.id : '',
    sessions: [...runtime.sessions]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({
        id: session.id,
        title: sessionTitle(session),
        updatedAt: session.updatedAt,
        status: session.status,
        mode: session.mode
      })),
    models: runtime.models.map((model) => ({
      ref: model.ref,
      name: model.name,
      provider: model.provider,
      modelId: model.modelId,
      purpose: model.purpose,
      configured: model.configured === true
    })),
    skills: runtime.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      enabled: (current ? current.skillIds : runtime.preferences.skillIds).includes(skill.id)
    })),
    activeSession: current ? {
      id: current.id,
      title: sessionTitle(current),
      status: current.status,
      mode: current.mode,
      reasoningEffort: current.reasoningEffort,
      modelRef: current.modelRef,
      messages: current.messages.map((message) => ({ ...message })),
      timeline: current.timeline.map(stateTimeline),
      goal: stateGoal(current.goal),
      approval: approvalState(runtime.pending.get(current.id))
    } : null
  };
}

function persistedState() {
  const value = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    activeSessionId: runtime.activeSessionId,
    preferences: clone(runtime.preferences),
    sessions: runtime.sessions.slice(-MAX_SESSIONS).map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.status,
      mode: session.mode,
      reasoningEffort: session.reasoningEffort,
      modelRef: session.modelRef,
      skillIds: [...session.skillIds],
      messages: session.messages.slice(-MAX_MESSAGES).map((message) => ({ ...message })),
      timeline: session.timeline.slice(-MAX_TIMELINE).map((item) => ({ ...item })),
      goal: session.goal ? clone(session.goal) : null
    }))
  };
  while (new TextEncoder().encode(JSON.stringify(value)).length > MAX_PERSISTED_BYTES && value.sessions.length > 1) {
    const removable = value.sessions.findIndex((session) => session.id !== value.activeSessionId);
    if (removable < 0) break;
    const removedId = value.sessions[removable].id;
    value.sessions.splice(removable, 1);
    const runtimeIndex = runtime.sessions.findIndex((session) => session.id === removedId);
    if (runtimeIndex >= 0) runtime.sessions.splice(runtimeIndex, 1);
  }
  return value;
}

function publish() {
  if (!runtime || runtime.disposed || !runtime.provider) return Promise.resolve();
  const owner = runtime;
  const provider = runtime.provider;
  const snapshot = stateSnapshot();
  runtime.publishQueue = runtime.publishQueue.catch(() => {}).then(async () => {
    if (!owner.disposed && owner.provider === provider) await provider.setState(snapshot);
  });
  return runtime.publishQueue;
}

function persist() {
  if (!runtime || runtime.disposed) return Promise.resolve();
  const owner = runtime;
  const value = persistedState();
  runtime.storageQueue = runtime.storageQueue.catch(() => {}).then(async () => {
    if (!owner.disposed) await owner.context.storage.write(value);
  });
  return runtime.storageQueue;
}

function publishAndPersist() {
  void persist().catch(() => {});
  void publish();
}

function createSession(values = {}) {
  const preferences = runtime.preferences;
  const session = {
    id: id('session'),
    title: '',
    createdAt: now(),
    updatedAt: now(),
    status: 'idle',
    mode: selectedMode(values.mode || preferences.mode),
    reasoningEffort: selectedEffort(values.reasoningEffort || preferences.reasoningEffort),
    modelRef: validId(values.modelRef) ? values.modelRef : preferences.modelRef,
    skillIds: Array.isArray(values.skillIds) ? selectedSkills(values.skillIds) : [...preferences.skillIds],
    messages: [],
    timeline: [],
    goal: null
  };
  runtime.sessions.push(session);
  if (runtime.sessions.length > MAX_SESSIONS) runtime.sessions.splice(0, runtime.sessions.length - MAX_SESSIONS);
  runtime.activeSessionId = session.id;
  return session;
}

function applyPreferences(values, session) {
  if (!plain(values)) return;
  if (values.mode !== undefined) runtime.preferences.mode = selectedMode(values.mode);
  if (values.reasoningEffort !== undefined) runtime.preferences.reasoningEffort = selectedEffort(values.reasoningEffort);
  if (validId(values.modelRef)) runtime.preferences.modelRef = values.modelRef;
  if (Array.isArray(values.skillIds)) runtime.preferences.skillIds = selectedSkills(values.skillIds);
  if (!session) return;
  session.mode = runtime.preferences.mode;
  session.reasoningEffort = runtime.preferences.reasoningEffort;
  session.modelRef = runtime.preferences.modelRef;
  session.skillIds = [...runtime.preferences.skillIds];
  session.updatedAt = now();
}

function modelFor(session) {
  const selected = runtime.models.find((model) => model.ref === session.modelRef && model.configured);
  return selected || runtime.models.find((model) => model.configured && model.purpose === 'chat') || runtime.models.find((model) => model.configured) || null;
}

function systemPrompt(session, skillContext) {
  const mode = session.mode === 'goal'
    ? 'Goal mode is active. Work through the visible goal deliberately, inspect before changing files, verify completed work, and stop only when the goal is complete or genuinely blocked.'
    : 'Chat mode is active. Answer directly, using tools only when they materially improve correctness.';
  const effort = {
    low: 'Keep reasoning concise and prefer the smallest useful action.',
    medium: 'Use balanced reasoning and validate important assumptions.',
    high: 'Reason carefully, inspect relevant context, and verify consequential changes.',
    max: 'Use the highest available reasoning depth, consider failure modes, and verify the result thoroughly.'
  }[session.reasoningEffort];
  return [
    'You are the official BOBOCLOUD local workspace agent.',
    'You operate only through the provided structured tools. You never have direct filesystem, process, network, credential, Electron, Node.js, or DOM access.',
    'Paths are workspace-relative. Read an existing file before writing it and pass the returned expectedSha256. Never claim a tool action succeeded until its result confirms success.',
    'workspace_write and process_run always require explicit user approval. When approval is required, stop issuing further tools until the host resumes you with a tool result.',
    mode,
    effort,
    skillContext ? 'Selected skills follow. Treat them as user-provided operating instructions within the same safety boundary:\n\n' + skillContext : ''
  ].filter(Boolean).join('\n\n');
}

function wireMessages(session, system) {
  return [
    { role: 'system', content: system },
    ...session.messages.map((message) => ({ role: message.role, content: message.content }))
  ];
}

function appendTimeline(session, item) {
  session.timeline.push(item);
  if (session.timeline.length > MAX_TIMELINE) session.timeline.splice(0, session.timeline.length - MAX_TIMELINE);
  let characters = session.timeline.reduce((total, value) => total + value.detail.length, 0);
  while (characters > MAX_SESSION_TIMELINE_CHARS && session.timeline.length > 1) {
    characters -= session.timeline[0].detail.length;
    session.timeline.shift();
  }
  return item;
}

function appendMessage(session, role, content, reasoning = '') {
  const message = { id: id('message'), role, content: text(content), reasoning: text(reasoning), createdAt: now() };
  session.messages.push(message);
  if (session.messages.length > MAX_MESSAGES) session.messages.splice(0, session.messages.length - MAX_MESSAGES);
  let characters = session.messages.reduce((total, value) => total + value.content.length + value.reasoning.length, 0);
  while (characters > MAX_SESSION_MESSAGE_CHARS && session.messages.length > 1) {
    characters -= session.messages[0].content.length + session.messages[0].reasoning.length;
    session.messages.shift();
  }
  return message;
}

function updateGoalForTool(session, tool, completed) {
  if (!session.goal) return;
  session.goal.steps[0].status = 'completed';
  const readTool = tool === 'workspace_list' || tool === 'workspace_read' || tool === 'workspace_search';
  const actionTool = tool === 'workspace_write' || tool === 'process_run';
  if (readTool) session.goal.steps[1].status = completed ? 'completed' : 'in-progress';
  if (actionTool) {
    session.goal.steps[1].status = 'completed';
    session.goal.steps[2].status = completed ? 'completed' : 'in-progress';
  }
}

function finishGoal(session, failed = false) {
  if (!session.goal) return;
  session.goal.status = failed ? 'blocked' : 'completed';
  for (const step of session.goal.steps) step.status = failed ? (step.status === 'in-progress' ? 'blocked' : step.status) : 'completed';
}

async function loadSkillContext(session) {
  const sections = [];
  let size = 0;
  for (const skillId of session.skillIds.filter((candidate) => runtime.skills.some((skill) => skill.id === candidate))) {
    if (size >= MAX_SKILL_CONTEXT) break;
    const metadata = runtime.skills.find((skill) => skill.id === skillId);
    try {
      const skill = await runtime.context.skills.read(skillId);
      const body = text(skill && skill.content, Math.min(64 * 1024, MAX_SKILL_CONTEXT - size));
      if (!body) continue;
      const name = text(skill.name || metadata && metadata.name, 160) || skillId;
      const section = '## Skill: ' + name + '\n' + body;
      sections.push(section);
      size += section.length;
      appendTimeline(session, makeTimeline('skill', 'timeline.skillLoaded', '', 'completed', { name }));
    } catch (error) {
      appendTimeline(session, makeTimeline('error', 'timeline.skillFailed', errorMessage(error), 'failed', {
        name: metadata && metadata.name || skillId
      }));
    }
  }
  return sections.join('\n\n').slice(0, MAX_SKILL_CONTEXT);
}

function normalizeToolCalls(value) {
  return Array.isArray(value) ? value.slice(0, 16).map((call) => ({
    id: validId(call && call.id) ? call.id : id('call'),
    name: text(call && call.name, 96),
    arguments: text(call && call.arguments, 256 * 1024) || '{}'
  })).filter((call) => /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(call.name)) : [];
}

function parseToolInput(call) {
  try {
    const value = JSON.parse(call.arguments || '{}');
    if (plain(value)) return value;
  } catch (_) {}
  return null;
}

function wireToolCall(call) {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
}

function resultForModel(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch (_) { serialized = JSON.stringify({ error: 'Tool result could not be serialized.' }); }
  if (serialized.length > 96 * 1024) serialized = serialized.slice(0, 96 * 1024) + '\n[tool result truncated]';
  return serialized;
}

function toolResultDetail(tool, result) {
  if (tool === 'workspace_list') return translated('tool.result.entries', { count: Array.isArray(result && result.entries) ? result.entries.length : 0 });
  if (tool === 'workspace_read') return translated('tool.result.read', { path: text(result && result.path, 300), size: Number(result && result.size) || 0 });
  if (tool === 'workspace_search') return translated('tool.result.matches', { count: Array.isArray(result && result.results) ? result.results.length : 0 });
  if (tool === 'workspace_write') return translated('tool.result.written', { path: text(result && result.path, 300) });
  if (tool === 'process_run') return translated('tool.result.process', { code: Number.isInteger(result && result.exitCode) ? result.exitCode : '-' });
  return translated('tool.result.completed');
}

function isRunCurrent(session, run) {
  return runtime && !runtime.disposed && !run.cancelled && runtime.runs.get(session.id) === run;
}

async function handleToolCalls(session, execution, calls, run) {
  for (let index = 0; index < calls.length; index += 1) {
    if (!isRunCurrent(session, run)) return { stopped: true };
    const call = calls[index];
    const input = parseToolInput(call);
    const timeline = appendTimeline(session, makeTimeline('tool', 'timeline.toolRunning', '', 'running', { tool: call.name }));
    updateGoalForTool(session, call.name, false);
    publishAndPersist();
    if (!input) {
      timeline.status = 'failed';
      timeline.detail = translated('error.invalidToolArguments');
      execution.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: resultForModel({ error: timeline.detail }) });
      continue;
    }
    try {
      const result = await runtime.context.tools.invoke(call.name, input);
      if (!isRunCurrent(session, run)) return { stopped: true };
      if (result && result.approvalRequired === true) {
        if (!plain(result.approval) || !validId(result.approval.id)) throw new Error(translated('error.invalidApproval'));
        timeline.status = 'waiting';
        timeline.titleKey = 'timeline.toolApproval';
        runtime.pending.set(session.id, {
          approval: { id: result.approval.id },
          call,
          remaining: calls.slice(index + 1),
          execution,
          timelineId: timeline.id
        });
        session.status = 'waiting-approval';
        session.updatedAt = now();
        runtime.runs.delete(session.id);
        publishAndPersist();
        return { waiting: true };
      }
      timeline.status = 'completed';
      timeline.detail = toolResultDetail(call.name, result);
      updateGoalForTool(session, call.name, true);
      execution.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: resultForModel(result) });
      publishAndPersist();
    } catch (error) {
      if (!isRunCurrent(session, run)) return { stopped: true };
      timeline.status = 'failed';
      timeline.detail = errorMessage(error);
      execution.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: resultForModel({ error: timeline.detail }) });
      publishAndPersist();
    }
  }
  return { waiting: false };
}

async function runLoop(session, execution, run, initialCalls = []) {
  try {
    if (initialCalls.length) {
      const handled = await handleToolCalls(session, execution, initialCalls, run);
      if (handled.waiting || handled.stopped) return;
    }
    while (execution.round < MAX_MODEL_ROUNDS && isRunCurrent(session, run)) {
      execution.round += 1;
      const response = await runtime.context.models.generate({
        requestId: execution.requestId,
        modelRef: session.modelRef,
        messages: execution.messages,
        tools: TOOL_DEFINITIONS,
        reasoningEffort: session.reasoningEffort,
        maxTokens: session.reasoningEffort === 'max' ? 16384 : 8192,
        temperature: 0.2
      });
      if (!isRunCurrent(session, run)) return;
      const calls = normalizeToolCalls(response && response.toolCalls);
      const content = text(response && response.content);
      const reasoning = text(response && response.reasoning);
      if (reasoning) appendTimeline(session, makeTimeline('thought', 'timeline.thought', reasoning, 'completed'));
      if (content) appendMessage(session, 'assistant', content);
      if (!calls.length) {
        if (!content) appendMessage(session, 'assistant', translated('message.emptyResponse'));
        session.status = 'completed';
        session.updatedAt = now();
        finishGoal(session, execution.rejected === true);
        runtime.runs.delete(session.id);
        publishAndPersist();
        return;
      }
      execution.messages.push({ role: 'assistant', content, tool_calls: calls.map(wireToolCall) });
      const handled = await handleToolCalls(session, execution, calls, run);
      if (handled.waiting || handled.stopped) return;
    }
    if (!isRunCurrent(session, run)) return;
    throw new Error(translated('error.roundLimit'));
  } catch (error) {
    if (!runtime || runtime.disposed || run.cancelled) return;
    session.status = 'failed';
    session.updatedAt = now();
    appendTimeline(session, makeTimeline('error', 'timeline.failed', errorMessage(error), 'failed'));
    finishGoal(session, true);
    runtime.runs.delete(session.id);
    publishAndPersist();
  }
}

async function beginRun(session) {
  const model = modelFor(session);
  if (!model) {
    session.status = 'failed';
    appendTimeline(session, makeTimeline('error', 'timeline.failed', translated('error.modelUnconfigured'), 'failed'));
    finishGoal(session, true);
    publishAndPersist();
    return;
  }
  session.modelRef = model.ref;
  const requestId = id('request');
  const run = { requestId, cancelled: false };
  runtime.runs.set(session.id, run);
  const skillContext = await loadSkillContext(session);
  if (!isRunCurrent(session, run)) return;
  const execution = {
    requestId,
    round: 0,
    messages: wireMessages(session, systemPrompt(session, skillContext))
  };
  publishAndPersist();
  await runLoop(session, execution, run);
}

function handleCreate(values) {
  const session = createSession(plain(values) ? values : {});
  publishAndPersist();
  return { accepted: true, sessionId: session.id };
}

function handleSelect(values) {
  const sessionId = text(values && values.sessionId, 180);
  if (!runtime.sessions.some((session) => session.id === sessionId)) return { accepted: false };
  runtime.activeSessionId = sessionId;
  publishAndPersist();
  return { accepted: true, sessionId };
}

function handleDelete(values) {
  const sessionId = text(values && values.sessionId, 180);
  const index = runtime.sessions.findIndex((session) => session.id === sessionId);
  if (index < 0) return { accepted: false };
  void cancelSession(runtime.sessions[index], false);
  runtime.sessions.splice(index, 1);
  if (runtime.activeSessionId === sessionId) runtime.activeSessionId = runtime.sessions[0] && runtime.sessions[0].id || '';
  publishAndPersist();
  return { accepted: true };
}

function handlePreferences(values) {
  const session = activeSession();
  applyPreferences(plain(values) ? values : {}, session);
  publishAndPersist();
  return { accepted: true };
}

function handleSend(values) {
  values = plain(values) ? values : {};
  const prompt = text(values && values.text).trim();
  if (!prompt) return { accepted: false };
  let session = runtime.sessions.find((candidate) => candidate.id === values.sessionId) || activeSession();
  if (!session) session = createSession(values);
  if (session.status === 'running' || session.status === 'waiting-approval') return { accepted: false, reason: 'busy' };
  runtime.activeSessionId = session.id;
  applyPreferences(values, session);
  if (!session.title) session.title = prompt.replace(/\s+/g, ' ').slice(0, 72);
  appendMessage(session, 'user', prompt);
  appendTimeline(session, makeTimeline('status', 'timeline.started', '', 'running'));
  session.goal = session.mode === 'goal' ? makeGoal(prompt) : null;
  session.status = 'running';
  session.updatedAt = now();
  publishAndPersist();
  void beginRun(session);
  return { accepted: true, sessionId: session.id };
}

async function cancelSession(session, publishState = true) {
  const run = runtime.runs.get(session.id);
  if (run) {
    run.cancelled = true;
    runtime.runs.delete(session.id);
    void runtime.context.models.cancel(run.requestId).catch(() => {});
  }
  runtime.pending.delete(session.id);
  session.status = 'cancelled';
  session.updatedAt = now();
  appendTimeline(session, makeTimeline('status', 'timeline.cancelled', '', 'rejected'));
  finishGoal(session, true);
  if (publishState) publishAndPersist();
}

function handleCancel(values) {
  values = plain(values) ? values : {};
  const session = runtime.sessions.find((candidate) => candidate.id === values.sessionId) || activeSession();
  if (!session || (session.status !== 'running' && session.status !== 'waiting-approval')) return { accepted: false };
  void cancelSession(session);
  return { accepted: true };
}

function approvalSession(values) {
  const approvalId = text(values && values.approvalId, 180);
  const sessionId = text(values && values.sessionId, 180);
  for (const session of runtime.sessions) {
    if (sessionId && session.id !== sessionId) continue;
    const pending = runtime.pending.get(session.id);
    if (pending && pending.approval.id === approvalId) return { session, pending };
  }
  return null;
}

async function resumeApproval(session, pending, approvalResult, approved) {
  const execution = pending.execution;
  const run = { requestId: execution.requestId, cancelled: false };
  runtime.runs.set(session.id, run);
  const timeline = session.timeline.find((item) => item.id === pending.timelineId);
  try {
    if (!isRunCurrent(session, run)) return;
    const operationCompleted = approved && approvalResult.cancelled !== true;
    if (timeline) {
      timeline.status = operationCompleted ? 'completed' : 'rejected';
      timeline.detail = approved ? toolResultDetail(pending.call.name, approvalResult) : translated('tool.result.rejected');
    }
    updateGoalForTool(session, pending.call.name, operationCompleted);
    execution.messages.push({
      role: 'tool',
      tool_call_id: pending.call.id,
      name: pending.call.name,
      content: resultForModel(approved ? approvalResult : { ...approvalResult, reason: 'The user rejected this tool operation.' })
    });
    if (!operationCompleted) execution.rejected = true;
    session.status = 'running';
    session.updatedAt = now();
    publishAndPersist();
    await runLoop(session, execution, run, pending.remaining);
  } catch (error) {
    if (!runtime || runtime.disposed || run.cancelled) return;
    if (timeline) {
      timeline.status = 'failed';
      timeline.detail = errorMessage(error);
    }
    session.status = 'failed';
    session.updatedAt = now();
    appendTimeline(session, makeTimeline('error', 'timeline.failed', errorMessage(error), 'failed'));
    finishGoal(session, true);
    runtime.runs.delete(session.id);
    publishAndPersist();
  }
}

function handleApproval(values, approved) {
  values = plain(values) ? values : {};
  const match = approvalSession(values);
  if (!match) return { accepted: false };
  const result = values.approvalResult;
  if (!plain(result) || (approved ? result.approved !== true : result.rejected !== true) ||
      (result.tool !== undefined && result.tool !== match.pending.call.name)) {
    return { accepted: false };
  }
  runtime.pending.delete(match.session.id);
  match.session.status = 'running';
  match.session.updatedAt = now();
  publishAndPersist();
  void resumeApproval(match.session, match.pending, clone(result), approved);
  return { accepted: true };
}

async function refreshCatalogs() {
  runtime.catalogError = '';
  const [modelsOutcome, skillsOutcome] = await Promise.allSettled([
    runtime.context.models.list(),
    runtime.context.skills.list()
  ]);
  if (modelsOutcome.status === 'fulfilled') {
    const modelsResult = modelsOutcome.value;
    runtime.models = Array.isArray(modelsResult && modelsResult.models) ? modelsResult.models.filter((model) => plain(model) && validId(model.ref)) : [];
    if (!runtime.preferences.modelRef || !runtime.models.some((model) => model.ref === runtime.preferences.modelRef && model.configured)) {
      const preferred = runtime.models.find((model) => model.configured && model.purpose === 'chat') || runtime.models.find((model) => model.configured);
      runtime.preferences.modelRef = preferred && preferred.ref || '';
    }
  } else {
    runtime.models = [];
    runtime.catalogError = errorMessage(modelsOutcome.reason);
  }
  if (skillsOutcome.status === 'fulfilled') {
    const skillsResult = skillsOutcome.value;
    runtime.skills = Array.isArray(skillsResult && skillsResult.skills) ? skillsResult.skills.filter((skill) => plain(skill) && validId(skill.id)) : [];
  } else runtime.skills = [];
}

function handleConfigure() {
  void refreshCatalogs().then(() => {
    const session = activeSession();
    if (session && !modelFor(session)) session.modelRef = runtime.preferences.modelRef;
    publishAndPersist();
  });
  return { accepted: true };
}

function commandMetadata(key) {
  return { title: translated(key), category: translated('command.category') };
}

async function registerSurface() {
  const handlers = [
    ['create', handleCreate, 'command.create'],
    ['select', handleSelect, 'command.select'],
    ['delete', handleDelete, 'command.delete'],
    ['send', handleSend, 'command.send'],
    ['cancel', handleCancel, 'command.cancel'],
    ['approve', (values) => handleApproval(values, true), 'command.approve'],
    ['reject', (values) => handleApproval(values, false), 'command.reject'],
    ['preferences', handlePreferences, 'command.preferences'],
    ['configure', handleConfigure, 'command.configure']
  ];
  const disposables = [];
  for (const [name, handler, titleKey] of handlers) {
    disposables.push(await runtime.context.commands.register(COMMANDS[name], handler, commandMetadata(titleKey)));
  }
  const provider = await runtime.context.agents.register({
    id: PROVIDER_ID,
    title: translated('agent.title'),
    description: translated('agent.description'),
    icon: 'sparkles',
    order: 10,
    commands: { ...COMMANDS },
    capabilities: {
      modes: ['chat', 'goal'],
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      skills: true,
      localTools: true
    }
  });
  runtime.surface = disposables;
  runtime.provider = provider;
}

function disposeSurface() {
  if (!runtime) return;
  if (runtime.provider) runtime.provider.dispose();
  runtime.provider = null;
  for (const disposable of runtime.surface.splice(0).reverse()) disposable.dispose();
}

function rebuildSurface() {
  if (!runtime || runtime.disposed) return;
  runtime.surfaceQueue = runtime.surfaceQueue.catch(() => {}).then(async () => {
    if (!runtime || runtime.disposed) return;
    disposeSurface();
    await registerSurface();
    await publish();
  });
}

export async function activate(context) {
  if (runtime) await deactivate();
  const stored = await context.storage.read().catch(() => ({ value: {} }));
  const restored = loadState(stored && stored.value);
  runtime = {
    context,
    sessions: restored.sessions,
    activeSessionId: restored.activeSessionId,
    preferences: restored.preferences,
    models: [],
    skills: [],
    runs: new Map(),
    pending: new Map(),
    provider: null,
    surface: [],
    localeSubscription: null,
    catalogError: '',
    disposed: false,
    publishQueue: Promise.resolve(),
    storageQueue: Promise.resolve(),
    surfaceQueue: Promise.resolve()
  };
  await refreshCatalogs();
  await registerSurface();
  runtime.localeSubscription = context.i18n.onDidChange(() => rebuildSurface());
  context.subscriptions.add(runtime.localeSubscription);
  await publish();
  void persist().catch(() => {});
  return { dispose: deactivate };
}

export async function deactivate() {
  const current = runtime;
  if (!current) return;
  current.disposed = true;
  for (const run of current.runs.values()) {
    run.cancelled = true;
    void current.context.models.cancel(run.requestId).catch(() => {});
  }
  current.runs.clear();
  current.pending.clear();
  if (current.localeSubscription) current.localeSubscription.dispose();
  disposeSurface();
  runtime = null;
}

export const __testing = Object.freeze({
  commands: COMMANDS,
  providerId: PROVIDER_ID,
  getState: () => runtime ? stateSnapshot() : null
});
