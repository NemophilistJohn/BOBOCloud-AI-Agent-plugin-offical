import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing, activate, deactivate } from '../src/extension.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const messages = JSON.parse(await fs.readFile(path.join(root, 'language-packs', 'en', 'messages.json'), 'utf8'));

function interpolate(value, values = {}) {
  return String(value).replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, key) => Object.hasOwn(values, key) ? String(values[key]) : '{' + key + '}');
}

function harness(options = {}) {
  const commands = new Map();
  const states = [];
  const modelCalls = [];
  const titleCalls = [];
  const toolCalls = [];
  const cancellations = [];
  const writes = [];
  const subscriptions = [];
  let descriptor = null;
  let modelListCalls = 0;
  let skillListCalls = 0;
  let storageWriteCalls = 0;
  let commandRegisterCalls = 0;
  let stateWriteCalls = 0;
  const modelResponses = [...(options.modelResponses || [{ content: 'Done.', toolCalls: [] }])];
  const context = {
    subscriptions: {
      add(value) { subscriptions.push(value); return value; }
    },
    commands: {
      async register(commandId, handler, metadata) {
        commandRegisterCalls += 1;
        if (typeof options.registerCommand === 'function') await options.registerCommand(commandId, commandRegisterCalls);
        const record = { handler, metadata };
        commands.set(commandId, record);
        return { dispose() { if (commands.get(commandId) === record) commands.delete(commandId); } };
      }
    },
    agents: {
      async register(value) {
        descriptor = value;
        let active = true;
        return {
          id: value.id,
          async setState(state) {
            if (!active) return;
            stateWriteCalls += 1;
            states.push(structuredClone(state));
            if (typeof options.stateWrite === 'function') await options.stateWrite(state, stateWriteCalls);
          },
          clearState() {},
          dispose() { active = false; }
        };
      }
    },
    models: {
      async list() {
        modelListCalls += 1;
        if (typeof options.modelsList === 'function') return options.modelsList(modelListCalls);
        return { models: [{ ref: 'chat:test', purpose: 'chat', name: 'Test', provider: 'test', modelId: 'test-1', configured: true }] };
      },
      async generate(args) {
        if (String(args.requestId || '').startsWith('title-')) {
          titleCalls.push(structuredClone(args));
          if (typeof options.titleResponse === 'function') return options.titleResponse(args);
          return options.titleResponse || { content: 'Focused Agent task', toolCalls: [] };
        }
        modelCalls.push(structuredClone(args));
        const response = modelResponses.shift();
        if (typeof response === 'function') return response(args);
        return response || { content: 'Done.', toolCalls: [] };
      },
      async cancel(requestId) { cancellations.push(requestId); return { cancelled: true }; }
    },
    tools: {
      async invoke(tool, input) {
        toolCalls.push({ tool, input: structuredClone(input) });
        if (options.invoke) return options.invoke(tool, input);
        return { path: input.path || '.', content: 'export const value = 1;\n', sha256: 'a'.repeat(64), size: 24 };
      }
    },
    skills: {
      async list() {
        skillListCalls += 1;
        if (typeof options.skillsList === 'function') return options.skillsList(skillListCalls);
        return { skills: [{ id: 'skill-test', name: 'Test Skill', description: 'Testing instructions', source: 'workspace' }] };
      },
      async read(skillId) {
        assert.equal(skillId, 'skill-test');
        if (typeof options.skillRead === 'function') return options.skillRead(skillId);
        return { id: skillId, name: 'Test Skill', description: 'Testing instructions', source: 'workspace', content: 'Always inspect the target before editing.' };
      }
    },
    storage: {
      async read() { return { value: options.stored || {} }; },
      async write(value) {
        storageWriteCalls += 1;
        writes.push(structuredClone(value));
        if (typeof options.storageWrite === 'function') return options.storageWrite(value, storageWriteCalls);
        return { saved: true };
      }
    },
    i18n: {
      locale: 'en',
      t(key, values) { return interpolate(messages[key] || key, values); },
      onDidChange(listener) { return { dispose() {}, listener }; }
    }
  };
  return {
    context,
    commands,
    states,
    modelCalls,
    titleCalls,
    toolCalls,
    cancellations,
    writes,
    subscriptions,
    get descriptor() { return descriptor; }
  };
}

test('summarizes and sanitizes first prompts within a visual-width budget', () => {
  const prompt = '请你先探索代码，并参照 Codex、OpenCode 等开源 Agent 的架构，分析本云编译器的 AI Agent 服务如何扩展，最后给出详细计划。';
  const title = __testing.summarizeSessionTitle(prompt);
  assert.equal(title, '本云编译器的 AI Agent 服务如何扩展');
  assert.equal(__testing.titleUnits(title) <= __testing.maxSessionTitleUnits, true);
  assert.equal(__testing.shouldRefineSessionTitle(prompt), true);
  assert.equal(__testing.summarizeSessionTitle('Please help me fix auth.ts token refresh failures.'), 'fix auth.ts token refresh failures');
  const safeUnicodeTitle = __testing.summarizeSessionTitle('请修复\u202Eabc\u200b 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀');
  assert.equal(safeUnicodeTitle.includes('\u202E'), false);
  assert.equal(safeUnicodeTitle.includes('\u200b'), false);
  assert.equal(safeUnicodeTitle.endsWith('…'), true);
  assert.equal(__testing.titleUnits(safeUnicodeTitle) <= __testing.maxSessionTitleUnits, true);
  assert.equal(__testing.titleUnits(__testing.summarizeSessionTitle('请修复 😀'.repeat(40))) <= __testing.maxSessionTitleUnits, true);
  const combiningFlood = __testing.summarizeSessionTitle('Fix a' + '\u0301'.repeat(500) + ' title rendering');
  assert.equal(combiningFlood.length <= __testing.maxSessionTitleCodeUnits, true);
  assert.equal(combiningFlood.endsWith('…'), true);
});

test('refines a complex session title with the configured model and persists it', async () => {
  await deactivate();
  const host = harness({
    modelResponses: [{ content: 'The design report is ready.', toolCalls: [] }],
    titleResponse: { content: '云编译 Agent 工具架构', toolCalls: [] }
  });
  await activate(host.context);
  const prompt = '请你探索代码，分析如何把云编译、环境资源和自动调试能力作为安全工具提供给 AI Agent，并给出分阶段计划。';
  const sent = host.commands.get(__testing.commands.send).handler({ text: prompt, modelRef: 'chat:test' });
  assert.equal(sent.accepted, true);
  const immediate = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'running'));
  assert.notEqual(immediate.activeSession.title, prompt);
  assert.equal(__testing.titleUnits(immediate.activeSession.title) <= __testing.maxSessionTitleUnits, true);
  const titled = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.title === '云编译 Agent 工具架构'));
  assert.equal(titled.activeSession.title, '云编译 Agent 工具架构');
  assert.equal(host.titleCalls.length, 1);
  assert.equal(host.titleCalls[0].reasoningEffort, 'low');
  assert.equal(host.titleCalls[0].maxTokens, 64);
  assert.equal(host.titleCalls[0].tools, undefined);
  await waitFor(() => host.writes.some((value) => value.sessions?.some((session) => session.title === '云编译 Agent 工具架构')));
  await deactivate();
});

test('keeps the deterministic title when model title generation fails', async () => {
  await deactivate();
  const host = harness({
    modelResponses: [{ content: 'Done.', toolCalls: [] }],
    titleResponse() { throw new Error('title unavailable'); }
  });
  await activate(host.context);
  const prompt = 'Please inspect the workspace, diagnose the package installation failure, and propose a safe repair plan with tests.';
  const expected = __testing.summarizeSessionTitle(prompt);
  host.commands.get(__testing.commands.send).handler({ text: prompt, modelRef: 'chat:test' });
  await waitFor(() => host.titleCalls.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(__testing.getState().activeSession.title, expected);
  await deactivate();
});

function storedSession(messages, options = {}) {
  const createdAt = '2026-08-25T00:00:00.000Z';
  return {
    schemaVersion: options.schemaVersion || 2,
    activeSessionId: 'session-stored',
    preferences: {
      mode: options.mode || 'chat',
      reasoningEffort: options.reasoningEffort || 'medium',
      accessMode: options.accessMode || 'ask',
      modelRef: 'chat:test',
      skillIds: options.skillIds || []
    },
    sessions: [{
      id: 'session-stored',
      title: 'Stored session',
      createdAt,
      updatedAt: createdAt,
      status: 'completed',
      mode: options.mode || 'chat',
      reasoningEffort: options.reasoningEffort || 'medium',
      accessMode: options.accessMode || 'ask',
      modelRef: 'chat:test',
      skillIds: options.skillIds || [],
      messages: messages.map((message, index) => ({
        id: 'message-stored-' + index,
        role: message.role,
        content: message.content,
        reasoning: '',
        createdAt
      })),
      timeline: [],
      goal: null,
      compaction: options.compaction
    }]
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message || 'Timed out waiting for Agent state.');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

test('registers a host-rendered Agent and completes a goal with Skill-guided tool use', async () => {
  await deactivate();
  const host = harness({
    modelResponses: [
      {
        content: '',
        reasoning: 'I should inspect the requested file first.',
        toolCalls: [{ id: 'call-read', name: 'workspace_read', arguments: JSON.stringify({ path: 'src/example.js' }) }]
      },
      { content: 'The file was inspected and no change was needed.', toolCalls: [] }
    ]
  });
  await activate(host.context);
  assert.equal(host.descriptor.id, __testing.providerId);
  assert.deepEqual(host.descriptor.capabilities.modes, ['chat', 'goal']);
  assert.deepEqual(host.descriptor.capabilities.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(host.descriptor.capabilities.accessModes, ['ask', 'auto', 'full']);

  const created = host.commands.get(__testing.commands.create).handler({
    mode: 'goal', reasoningEffort: 'high', modelRef: 'chat:test', skillIds: ['skill-test']
  });
  assert.equal(created.accepted, true);
  const sent = host.commands.get(__testing.commands.send).handler({
    sessionId: created.sessionId,
    text: 'Inspect src/example.js and report its state.',
    mode: 'goal',
    reasoningEffort: 'high',
    modelRef: 'chat:test',
    skillIds: ['skill-test']
  });
  assert.equal(sent.accepted, true);
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'completed'));
  assert.equal(completed.activeSession.goal.status, 'completed');
  assert.equal(completed.activeSession.messages.at(-1).content, 'The file was inspected and no change was needed.');
  assert.equal(host.toolCalls[0].tool, 'workspace_read');
  assert.equal(host.modelCalls[0].reasoningEffort, 'high');
  assert.equal(host.modelCalls[0].maxTokens, 12288);
  assert.equal(host.modelCalls[0].requestId, host.modelCalls[1].requestId, 'one run must keep one cancellable request id');
  assert.match(host.modelCalls[0].messages[0].content, /Always inspect the target before editing/);
  assert.equal(completed.activeSession.timeline.some((item) => item.kind === 'skill'), true);
  const thought = completed.activeSession.timeline.find((item) => item.kind === 'thought');
  assert.match(thought.detail, /inspect the requested file first/);
  assert.match(thought.title, /^Thought for \d+s$/);
  assert.equal(JSON.stringify(host.writes).includes('I should inspect the requested file first.'), false);
  assert.equal(host.writes.length > 0, true);
  await deactivate();
});

test('pauses a write for approval and resumes the same model run after approval', async () => {
  await deactivate();
  const approval = {
    id: 'approval-test',
    tool: 'workspace_write',
    summary: 'Replace src/example.js',
    risk: 'write',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const host = harness({
    modelResponses: [
      {
        content: 'I prepared the requested edit.',
        toolCalls: [{
          id: 'call-write',
          name: 'workspace_write',
          arguments: JSON.stringify({ path: 'src/example.js', content: 'export const value = 2;\n', expectedSha256: 'a'.repeat(64) })
        }]
      },
      { content: 'The approved edit was applied.', toolCalls: [] }
    ],
    invoke(tool) {
      assert.equal(tool, 'workspace_write');
      return { approvalRequired: true, approval };
    }
  });
  await activate(host.context);
  const sent = host.commands.get(__testing.commands.send).handler({
    text: 'Update the exported value.', mode: 'goal', reasoningEffort: 'medium', accessMode: 'full', modelRef: 'chat:test', skillIds: []
  });
  const waiting = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'waiting-approval'));
  assert.equal(waiting.activeSession.accessMode, 'full');
  assert.match(host.modelCalls[0].messages[0].content, /display-only policy context, not authority/);
  assert.deepEqual(waiting.activeSession.approval, { id: approval.id }, 'the Worker publishes only the opaque approval id');
  assert.deepEqual(Object.keys(host.context.tools), ['invoke'], 'the Worker must receive invoke-only tools');
  assert.equal(host.commands.get(__testing.commands.approve).handler({ approvalId: approval.id }).accepted, false);
  assert.equal(host.commands.get(__testing.commands.approve).handler({
    approvalId: approval.id,
    approvalResult: { approved: true, tool: 'process_run', exitCode: 0 }
  }).accepted, false, 'a result for another tool must not resume the run');
  const accepted = host.commands.get(__testing.commands.approve).handler({
    approvalId: approval.id,
    approvalResult: { approved: true, path: 'src/example.js', sha256: 'b'.repeat(64) }
  });
  assert.equal(accepted.accepted, true);
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'completed'));
  assert.equal(completed.activeSession.messages.at(-1).content, 'The approved edit was applied.');
  assert.equal(host.modelCalls[0].requestId, host.modelCalls[1].requestId);
  assert.equal(sent.sessionId, completed.activeSession.id);
  await deactivate();
});

test('passes xhigh reasoning to the host with its bounded output budget', async () => {
  await deactivate();
  const host = harness();
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({
    text: 'Inspect this request carefully.', reasoningEffort: 'xhigh', accessMode: 'auto', modelRef: 'chat:test'
  });
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'completed'));
  assert.equal(completed.activeSession.reasoningEffort, 'xhigh');
  assert.equal(completed.activeSession.accessMode, 'auto');
  assert.equal(host.modelCalls[0].reasoningEffort, 'xhigh');
  assert.equal(host.modelCalls[0].maxTokens, 16384);
  assert.match(host.modelCalls[0].messages[0].content, /trusted host may approve policy-permitted operations/);
  await deactivate();
});

test('plans compaction by whole turns and strips private message metadata', () => {
  const messages = [
    { role: 'system', content: 'System policy.' },
    { role: 'user', content: 'old request ' + 'x'.repeat(200), sessionMessageId: 'message-old-user' },
    {
      role: 'assistant',
      content: 'I will inspect it.',
      sessionMessageId: 'message-old-assistant',
      tool_calls: [{ id: 'call-old', type: 'function', function: { name: 'workspace_read', arguments: '{"path":"src/a.js"}' } }]
    },
    { role: 'tool', name: 'workspace_read', tool_call_id: 'call-old', content: '{"path":"src/a.js","content":"ok"}' },
    { role: 'user', content: 'current request', sessionMessageId: 'message-current-user' },
    { role: 'assistant', content: 'current answer', sessionMessageId: 'message-current-assistant' }
  ];
  const plan = __testing.compactionPlan(messages, {
    thresholdTokens: 1,
    targetTokens: 1,
    minimumSourceTokens: 1,
    recentTurns: 1,
    maximumSourceCharacters: 10_000
  });
  assert.deepEqual(plan.source.map((message) => message.role), ['user', 'assistant', 'tool']);
  assert.deepEqual(plan.retained.map((message) => message.role), ['user', 'assistant']);
  assert.equal(plan.retained.some((message) => message.content === 'current request'), true);
  assert.equal(plan.source.some((message) => message.tool_call_id === 'call-old'), true, 'tool calls and results remain in one compacted turn');
  assert.equal(__testing.modelMessages(messages).some((message) => Object.hasOwn(message, 'sessionMessageId')), false);
});

test('compacts repeatedly without recursive summaries and restores durable compaction state', async () => {
  await deactivate();
  const large = (label) => label + ':' + ' context'.repeat(3500);
  const history = [];
  for (let turn = 0; turn < 5; turn += 1) {
    history.push({ role: 'user', content: large('user-' + turn) });
    history.push({ role: 'assistant', content: large('assistant-' + turn) });
  }
  const stored = storedSession(history, {
    skillIds: ['skill-test'],
    compaction: {
      summary: '### Compaction 2026-08-24T00:00:00.000Z\nExisting durable fact.',
      count: 1,
      compactedMessages: 4,
      estimatedTokensBefore: 60000,
      estimatedTokensAfter: 20000,
      compactedAt: '2026-08-24T00:00:00.000Z'
    }
  });
  const host = harness({
    stored,
    modelResponses: [
      { content: 'First new durable summary.', toolCalls: [] },
      { content: 'First compacted answer.', toolCalls: [] },
      { content: 'Second new durable summary.', toolCalls: [] },
      { content: 'Second compacted answer.', toolCalls: [] }
    ]
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({
    sessionId: 'session-stored', text: 'Continue from the stored history.', skillIds: ['skill-test'], modelRef: 'chat:test'
  });
  await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.messages.at(-1)?.content === 'First compacted answer.'));
  host.commands.get(__testing.commands.send).handler({
    sessionId: 'session-stored', text: 'A'.repeat(220_000), skillIds: ['skill-test'], modelRef: 'chat:test'
  });
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.messages.at(-1)?.content === 'Second compacted answer.'));

  assert.equal(host.modelCalls.length, 4, 'each run compacts once, then performs one normal generation');
  const [firstCompact, firstNormal, secondCompact, secondNormal] = host.modelCalls;
  assert.equal(firstCompact.requestId.startsWith('compact-'), true);
  assert.equal(Object.hasOwn(firstCompact, 'tools'), false, 'the summarizer cannot call tools');
  assert.match(firstCompact.messages[0].content, /stay under 1200 words/);
  assert.match(firstCompact.messages[0].content, /current progress/);
  assert.doesNotMatch(firstCompact.messages[1].content, /Existing durable fact/, 'prior summaries are not recursively summarized');
  assert.equal(secondCompact.requestId.startsWith('compact-'), true);
  assert.doesNotMatch(secondCompact.messages[1].content, /First new durable summary/, 'new summary segments remain immutable');
  assert.equal(Array.isArray(firstNormal.tools), true);
  assert.equal(Array.isArray(secondNormal.tools), true);
  const firstSystem = firstNormal.messages[0].content;
  assert.equal(firstSystem.indexOf('official BOBOCLOUD local workspace agent') < firstSystem.indexOf('Existing durable fact.'), true);
  assert.equal(firstSystem.indexOf('Existing durable fact.') < firstSystem.indexOf('First new durable summary.'), true);
  assert.equal(firstSystem.indexOf('First new durable summary.') < firstSystem.indexOf('## Skill: Test Skill'), true);
  assert.match(secondNormal.messages[0].content, /Second new durable summary/);
  assert.equal(firstNormal.messages.some((message) => Object.hasOwn(message, 'sessionMessageId')), false);
  assert.equal(completed.activeSession.compaction.count, 3);
  assert.equal(completed.activeSession.compacting, false);
  assert.equal(completed.activeSession.timeline.filter((item) => item.kind === 'compaction' && item.status === 'completed').length, 2);
  assert.equal(host.states.some((state) => state.activeSession?.compacting === true && state.message === messages['state.compacting']), true);

  const persisted = await waitFor(() => [...host.writes].reverse().find((value) => value.sessions?.[0]?.compaction?.count === 3));
  assert.equal(persisted.schemaVersion, 2);
  assert.match(persisted.sessions[0].compaction.summary, /Existing durable fact/);
  assert.match(persisted.sessions[0].compaction.summary, /First new durable summary/);
  assert.match(persisted.sessions[0].compaction.summary, /Second new durable summary/);

  await deactivate();
  const restoredHost = harness({ stored: persisted });
  await activate(restoredHost.context);
  const restored = await waitFor(() => [...restoredHost.states].reverse().find((state) => state.activeSession?.id === 'session-stored'));
  assert.equal(restored.activeSession.compaction.count, 3);
  assert.equal(restored.activeSession.compacting, false);
  assert.equal(restored.activeSession.accessMode, 'ask');
  await deactivate();
});

test('compacts an oversized single-user tool loop without splitting recent tool interactions', async () => {
  await deactivate();
  const toolRound = (index) => ({
    content: 'Completed inspection step ' + index + '.',
    toolCalls: [{
      id: 'call-mid-' + index,
      name: 'workspace_read',
      arguments: JSON.stringify({ path: 'src/file-' + index + '.js' })
    }]
  });
  const host = harness({
    modelResponses: [
      toolRound(1),
      toolRound(2),
      toolRound(3),
      toolRound(4),
      { content: 'Mid-turn durable summary.', toolCalls: [] },
      { content: 'The long inspection completed.', toolCalls: [] }
    ],
    invoke(tool, input) {
      assert.equal(tool, 'workspace_read');
      return { path: input.path, content: 'R'.repeat(70_000), sha256: 'a'.repeat(64), size: 70_000 };
    }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({
    text: 'Inspect the project through one long sequence of tool calls.', modelRef: 'chat:test'
  });
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.messages.at(-1)?.content === 'The long inspection completed.'));

  const compactCalls = host.modelCalls.filter((call) => !Object.hasOwn(call, 'tools'));
  assert.equal(compactCalls.length, 1, 'one run must not compact repeatedly on every later round');
  assert.match(compactCalls[0].messages[1].content, /Inspect the project through one long sequence/, 'the last real user request anchors a mid-turn summary');
  assert.match(compactCalls[0].messages[1].content, /call-mid-1/);
  const finalCall = host.modelCalls.at(-1);
  const finalWire = JSON.stringify(finalCall.messages);
  assert.doesNotMatch(finalWire, /call-mid-1/, 'the older complete interaction was replaced by its recovery summary');
  assert.match(finalWire, /call-mid-2/);
  assert.match(finalWire, /call-mid-3/);
  assert.match(finalWire, /call-mid-4/);
  assert.equal(completed.activeSession.messages.some((message) => message.role === 'user' && message.content.startsWith('Inspect the project')), true, 'the latest user message remains in persistent UI history');
  assert.equal(completed.activeSession.timeline.some((item) => item.kind === 'compaction' && item.status === 'completed'), true);
  await deactivate();
});

test('cancels an active session before switching access-policy context', async () => {
  await deactivate();
  let releaseFirst;
  const host = harness({
    modelResponses: [
      () => new Promise((resolve) => { releaseFirst = resolve; }),
      { content: 'The ask-mode session completed.', toolCalls: [] }
    ]
  });
  await activate(host.context);
  const first = host.commands.get(__testing.commands.create).handler({ accessMode: 'full', modelRef: 'chat:test' });
  host.commands.get(__testing.commands.send).handler({
    sessionId: first.sessionId, text: 'Keep working in full mode.', accessMode: 'full', modelRef: 'chat:test'
  });
  await waitFor(() => host.modelCalls.length === 1);

  const second = host.commands.get(__testing.commands.create).handler({ accessMode: 'ask', modelRef: 'chat:test' });
  await waitFor(() => host.cancellations.length === 1);
  assert.equal(host.cancellations[0], host.modelCalls[0].requestId);
  host.commands.get(__testing.commands.send).handler({
    sessionId: second.sessionId, text: 'Continue without changing this session policy.', modelRef: 'chat:test'
  });
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.id === second.sessionId && state.activeSession.status === 'completed'));
  assert.equal(completed.activeSession.accessMode, 'ask', 'missing payload fields must not inherit another session policy');
  assert.match(host.modelCalls[1].messages[0].content, /Host access mode is ask/);

  releaseFirst({
    content: '',
    toolCalls: [{ id: 'late-call', name: 'workspace_read', arguments: JSON.stringify({ path: 'late.js' }) }]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.toolCalls.length, 0, 'a late response from the old session cannot invoke a tool under the new active policy');
  const firstState = host.states.at(-1).sessions.find((session) => session.id === first.sessionId);
  assert.equal(firstState.status, 'cancelled');
  await deactivate();
});

test('cancels the active compaction request and does not publish a late summary', async () => {
  await deactivate();
  const history = [];
  for (let turn = 0; turn < 5; turn += 1) {
    history.push({ role: 'user', content: 'U'.repeat(28_000) });
    history.push({ role: 'assistant', content: 'A'.repeat(28_000) });
  }
  let release;
  const host = harness({
    stored: storedSession(history, { schemaVersion: 1 }),
    modelResponses: [() => new Promise((resolve) => { release = resolve; })]
  });
  await activate(host.context);
  const sent = host.commands.get(__testing.commands.send).handler({
    sessionId: 'session-stored', text: 'Continue.', modelRef: 'chat:test'
  });
  await waitFor(() => host.modelCalls.length === 1 && host.modelCalls[0].requestId.startsWith('compact-'));
  const cancelled = host.commands.get(__testing.commands.cancel).handler({ sessionId: sent.sessionId });
  assert.equal(cancelled.accepted, true);
  await waitFor(() => host.cancellations.length === 1);
  assert.equal(host.cancellations[0], host.modelCalls[0].requestId);
  release({ content: 'Late summary must be ignored.', toolCalls: [] });
  const state = await waitFor(() => [...host.states].reverse().find((value) => value.activeSession?.status === 'cancelled'));
  assert.equal(state.activeSession.compaction.count, 0);
  assert.equal(state.activeSession.compacting, false);
  assert.equal(state.activeSession.messages.some((message) => message.content === 'Late summary must be ignored.'), false);
  await deactivate();
});

test('cancels an active model request with the run request id', async () => {
  await deactivate();
  let release;
  const host = harness({
    modelResponses: [() => new Promise((resolve) => { release = resolve; })]
  });
  await activate(host.context);
  const sent = host.commands.get(__testing.commands.send).handler({ text: 'Wait for cancellation.', modelRef: 'chat:test' });
  await waitFor(() => host.modelCalls.length === 1);
  const cancelled = host.commands.get(__testing.commands.cancel).handler({ sessionId: sent.sessionId });
  assert.equal(cancelled.accepted, true);
  await waitFor(() => host.cancellations.length === 1);
  assert.equal(host.cancellations[0], host.modelCalls[0].requestId);
  release({ content: 'late response', toolCalls: [] });
  const state = await waitFor(() => [...host.states].reverse().find((value) => value.activeSession?.status === 'cancelled'));
  assert.equal(state.activeSession.messages.some((message) => message.content === 'late response'), false);
  await deactivate();
});

test('cancels a pending approval without any Worker approval capability', async () => {
  await deactivate();
  const approval = {
    id: 'approval-process',
    tool: 'process_run',
    summary: 'npm test',
    risk: 'execute',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const host = harness({
    modelResponses: [{
      content: '',
      toolCalls: [{ id: 'call-process', name: 'process_run', arguments: JSON.stringify({ command: 'npm', args: ['test'], cwd: '.' }) }]
    }],
    invoke() { return { approvalRequired: true, approval }; }
  });
  await activate(host.context);
  const sent = host.commands.get(__testing.commands.send).handler({ text: 'Run the tests.', modelRef: 'chat:test' });
  await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'waiting-approval'));
  const cancelled = host.commands.get(__testing.commands.cancel).handler({ sessionId: sent.sessionId });
  assert.equal(cancelled.accepted, true);
  const state = await waitFor(() => [...host.states].reverse().find((value) => value.activeSession?.status === 'cancelled'));
  assert.equal(state.activeSession.status, 'cancelled');
  assert.equal(host.cancellations.length, 0, 'no model request remains active while approval is pending');
  assert.deepEqual(Object.keys(host.context.tools), ['invoke']);
  await deactivate();
});

test('consumes a trusted rejection result and resumes with a blocked goal', async () => {
  await deactivate();
  const approval = {
    id: 'approval-reject',
    tool: 'workspace_write',
    summary: 'Replace src/example.js',
    risk: 'write',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const host = harness({
    modelResponses: [
      {
        content: '',
        toolCalls: [{ id: 'call-reject', name: 'workspace_write', arguments: JSON.stringify({ path: 'src/example.js', content: 'new' }) }]
      },
      { content: 'The requested write was not applied.', toolCalls: [] }
    ],
    invoke() { return { approvalRequired: true, approval }; }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Update the file.', mode: 'goal', modelRef: 'chat:test' });
  await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'waiting-approval'));
  const rejected = host.commands.get(__testing.commands.reject).handler({
    approvalId: approval.id,
    approvalResult: { rejected: true, tool: 'workspace_write' }
  });
  assert.equal(rejected.accepted, true);
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'completed'));
  assert.equal(completed.activeSession.goal.status, 'blocked');
  assert.equal(completed.activeSession.messages.at(-1).content, 'The requested write was not applied.');
  await deactivate();
});

test('consumes an approved host execution failure without reporting a user rejection', async () => {
  await deactivate();
  const approval = {
    id: 'approval-write-conflict',
    tool: 'workspace_write',
    summary: 'Replace src/example.js',
    risk: 'write',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const host = harness({
    modelResponses: [
      {
        content: '',
        toolCalls: [{ id: 'call-conflict', name: 'workspace_write', arguments: JSON.stringify({ path: 'src/example.js', content: 'new' }) }]
      },
      { content: 'The file changed, so I did not overwrite it.', toolCalls: [] }
    ],
    invoke() { return { approvalRequired: true, approval }; }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Update the file.', mode: 'goal', modelRef: 'chat:test' });
  await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'waiting-approval'));
  assert.equal(host.commands.get(__testing.commands.reject).handler({
    approvalId: approval.id,
    approvalResult: { rejected: true, failed: true, tool: 'workspace_write' }
  }).accepted, false, 'a failed result without a host error code must not consume plugin state');
  const resumed = host.commands.get(__testing.commands.reject).handler({
    approvalId: approval.id,
    approvalResult: {
      approved: false,
      rejected: true,
      failed: true,
      tool: 'workspace_write',
      errorCode: 'AGENT_FILE_CHANGED',
      errorMessage: 'The file changed while approval was pending.',
      outcome: 'not-started',
      mayHaveExecuted: false
    }
  });
  assert.equal(resumed.accepted, true);
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'completed'));
  const failedTool = completed.activeSession.timeline.find((item) => item.kind === 'tool');
  assert.equal(failedTool.status, 'failed');
  assert.equal(failedTool.detail, 'The file changed after it was read. Read it again before writing.');
  assert.equal(completed.activeSession.goal.status, 'blocked');
  const delivered = host.modelCalls[1].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call-conflict');
  const result = JSON.parse(delivered.content);
  assert.equal(result.failed, true);
  assert.equal(result.errorCode, 'AGENT_FILE_CHANGED');
  assert.equal(result.outcome, 'not-started');
  assert.equal(result.mayHaveExecuted, false);
  assert.equal(Object.hasOwn(result, 'reason'), false);
  await deactivate();
});

test('blocks automatic process retries after an unknown approved outcome', async () => {
  await deactivate();
  const approval = {
    id: 'approval-process-unknown',
    tool: 'process_run',
    summary: 'Run npm test',
    risk: 'execute',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const host = harness({
    modelResponses: [
      {
        content: '',
        toolCalls: [{ id: 'call-process-unknown', name: 'process_run', arguments: JSON.stringify({ command: 'npm', args: ['test'] }) }]
      },
      {
        content: '',
        toolCalls: [{ id: 'call-process-retry', name: 'process_run', arguments: JSON.stringify({ command: 'npm', args: ['test'] }) }]
      },
      { content: 'The process outcome is uncertain, so I will verify before another attempt.', toolCalls: [] }
    ],
    invoke() { return { approvalRequired: true, approval }; }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Run the tests.', mode: 'goal', modelRef: 'chat:test' });
  await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'waiting-approval'));
  const resumed = host.commands.get(__testing.commands.reject).handler({
    approvalId: approval.id,
    approvalResult: {
      approved: false,
      rejected: true,
      failed: true,
      tool: 'process_run',
      errorCode: 'AGENT_STALE_WORKSPACE',
      errorMessage: 'The active workspace changed before the approved Agent operation completed.',
      outcome: 'unknown',
      mayHaveExecuted: true
    }
  });
  assert.equal(resumed.accepted, true);
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'completed'));

  assert.equal(host.toolCalls.length, 1, 'the retry must be blocked before reaching the host tool broker');
  assert.match(host.modelCalls[0].messages[0].content, /do not retry process_run automatically/i);
  const unknownResult = host.modelCalls[1].messages.find((message) => message.tool_call_id === 'call-process-unknown');
  assert.match(JSON.parse(unknownResult.content).retryGuidance, /Do not automatically retry process_run/);
  const blockedResult = host.modelCalls[2].messages.find((message) => message.tool_call_id === 'call-process-retry');
  assert.equal(JSON.parse(blockedResult.content).retryBlocked, true);
  assert.equal(completed.activeSession.timeline.filter((item) => item.kind === 'tool' && item.status === 'failed').length, 2);
  assert.equal(completed.activeSession.goal.status, 'blocked');
  await deactivate();
});

test('treats a host-cancelled approved process as a blocked goal result', async () => {
  await deactivate();
  const approval = {
    id: 'approval-cancelled-process',
    tool: 'process_run',
    summary: 'npm test',
    risk: 'execute',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const host = harness({
    modelResponses: [
      {
        content: '',
        toolCalls: [{ id: 'call-cancelled-process', name: 'process_run', arguments: JSON.stringify({ command: 'npm', args: ['test'], cwd: '.' }) }]
      },
      { content: 'The test process was cancelled by the user.', toolCalls: [] }
    ],
    invoke() { return { approvalRequired: true, approval }; }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Run the tests.', mode: 'goal', modelRef: 'chat:test' });
  await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'waiting-approval'));
  const resumed = host.commands.get(__testing.commands.approve).handler({
    approvalId: approval.id,
    approvalResult: {
      approved: true,
      tool: 'process_run',
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      cancelled: true
    }
  });
  assert.equal(resumed.accepted, true);
  const completed = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'completed'));
  assert.equal(completed.activeSession.goal.status, 'blocked');
  assert.equal(completed.activeSession.timeline.some((item) => item.kind === 'tool' && item.status === 'rejected'), true);
  await deactivate();
});

test('serializes every tool result as bounded valid JSON', () => {
  const encoded = __testing.resultForModel({ stdout: 'x'.repeat(__testing.maxToolResultChars * 2), stderr: 'tail-marker' });
  assert.equal(encoded.length <= __testing.maxToolResultChars, true);
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.originalCharacters > __testing.maxToolResultChars, true);
  assert.match(parsed.tail, /tail-marker/);
  assert.equal(__testing.resultForModel(undefined), 'null');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.match(JSON.parse(__testing.resultForModel(cyclic)).error, /could not be serialized/i);
});

test('rewrites duplicate model tool-call ids before returning results', async () => {
  await deactivate();
  const host = harness({
    modelResponses: [
      {
        content: '',
        toolCalls: [
          { id: 'duplicate-call', name: 'workspace_read', arguments: JSON.stringify({ path: 'src/a.js' }) },
          { id: 'duplicate-call', name: 'workspace_read', arguments: JSON.stringify({ path: 'src/b.js' }) }
        ]
      },
      { content: 'Both files were read.', toolCalls: [] }
    ]
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Read both files.', modelRef: 'chat:test' });
  await waitFor(() => __testing.getState().activeSession?.status === 'completed');
  const toolMessages = host.modelCalls[1].messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.equal(new Set(toolMessages.map((message) => message.tool_call_id)).size, 2);
  await deactivate();
});

test('does not execute sibling tool calls after a rejected approval', async () => {
  await deactivate();
  const approval = { id: 'approval-stop-siblings', tool: 'workspace_write', summary: 'Write file', risk: 'write', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const host = harness({
    modelResponses: [
      {
        content: '',
        toolCalls: [
          { id: 'call-write-first', name: 'workspace_write', arguments: JSON.stringify({ path: 'src/a.js', content: 'a' }) },
          { id: 'call-process-second', name: 'process_run', arguments: JSON.stringify({ command: 'npm', args: ['test'] }) }
        ]
      },
      { content: 'The rejected change was not attempted again.', toolCalls: [] }
    ],
    invoke(tool) {
      if (tool === 'workspace_write') return { approvalRequired: true, approval };
      throw new Error('A sibling tool call must not execute after rejection.');
    }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Change and test the file.', modelRef: 'chat:test' });
  await waitFor(() => __testing.getState().activeSession?.status === 'waiting-approval');
  host.commands.get(__testing.commands.reject).handler({
    approvalId: approval.id,
    approvalResult: { rejected: true, tool: 'workspace_write' }
  });
  await waitFor(() => __testing.getState().activeSession?.status === 'completed');
  assert.deepEqual(host.toolCalls.map((call) => call.tool), ['workspace_write']);
  await deactivate();
});

test('short-circuits sibling calls when a process fails', async () => {
  await deactivate();
  const host = harness({
    modelResponses: [
      {
        content: '',
        toolCalls: [
          { id: 'call-test-fails', name: 'process_run', arguments: JSON.stringify({ command: 'npm', args: ['test'] }) },
          { id: 'call-write-after-failure', name: 'workspace_write', arguments: JSON.stringify({ path: 'src/a.js', content: 'a' }) }
        ]
      },
      { content: 'The failing test stopped this action batch.', toolCalls: [] }
    ],
    invoke(tool) {
      if (tool === 'process_run') return { approved: true, exitCode: 1, stdout: '', stderr: 'failed', truncated: false, timedOut: false, cancelled: false };
      throw new Error('A sibling mutation must not execute after process failure.');
    }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Test before changing the file.', mode: 'goal', modelRef: 'chat:test' });
  const completed = await waitFor(() => {
    const session = __testing.getState().activeSession;
    return session?.status === 'completed' ? session : null;
  });
  assert.deepEqual(host.toolCalls.map((call) => call.tool), ['process_run']);
  assert.equal(completed.timeline.some((item) => item.kind === 'tool' && item.status === 'failed'), true);
  assert.equal(completed.goal.status, 'blocked');
  await deactivate();
});

test('stops a run that repeats an identical tool call without progress', async () => {
  await deactivate();
  const repeated = (index) => ({
    content: '',
    toolCalls: [{ id: 'call-repeat-' + index, name: 'workspace_read', arguments: JSON.stringify({ path: 'src/repeat.js' }) }]
  });
  const host = harness({ modelResponses: [repeated(1), repeated(2), repeated(3), repeated(4)] });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Inspect the repeated file.', modelRef: 'chat:test' });
  const failed = await waitFor(() => {
    const session = __testing.getState().activeSession;
    return session?.status === 'failed' ? session : null;
  });
  assert.equal(host.toolCalls.length, 3);
  assert.equal(failed.timeline.some((item) => item.kind === 'error' && /repeating the same tool call/i.test(item.detail)), true);
  await deactivate();
});

test('keeps partial output but fails a response that reaches the model limit', async () => {
  await deactivate();
  const host = harness({ modelResponses: [{ content: 'Partial answer', finishReason: 'length', toolCalls: [] }] });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({ text: 'Summarize', modelRef: 'chat:test' });
  const failed = await waitFor(() => {
    const session = __testing.getState().activeSession;
    return session?.status === 'failed' ? session : null;
  });
  assert.equal(failed.messages.at(-1).content, 'Partial answer');
  assert.equal(failed.timeline.some((item) => item.kind === 'error' && /output limit/i.test(item.detail)), true);
  await deactivate();
});

test('coalesces queued storage snapshots and persists the latest state', async () => {
  await deactivate();
  const gate = deferred();
  const host = harness({ storageWrite(_value, call) { return call === 2 ? gate.promise : { saved: true }; } });
  await activate(host.context);
  host.commands.get(__testing.commands.create).handler({ modelRef: 'chat:test' });
  await waitFor(() => host.writes.length >= 2);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    host.commands.get(__testing.commands.preferences).handler({ reasoningEffort: effort });
  }
  gate.resolve({ saved: true });
  await waitFor(() => host.writes.at(-1)?.preferences?.reasoningEffort === 'max');
  assert.equal(host.writes.length <= 3, true, 'queued writes should collapse to the newest snapshot');
  await deactivate();
});

test('coalesces queued host state publications', async () => {
  await deactivate();
  const gate = deferred();
  const host = harness({ stateWrite(_value, call) { return call === 2 ? gate.promise : undefined; } });
  await activate(host.context);
  host.commands.get(__testing.commands.create).handler({ modelRef: 'chat:test' });
  await waitFor(() => host.states.length >= 2);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    host.commands.get(__testing.commands.preferences).handler({ reasoningEffort: effort });
  }
  gate.resolve();
  await waitFor(() => host.states.at(-1)?.activeSession?.reasoningEffort === 'max');
  assert.equal(host.states.length <= 3, true, 'queued publications should collapse to the newest snapshot');
  await deactivate();
});

test('ignores stale catalog refreshes that finish out of order', async () => {
  await deactivate();
  const slow = deferred();
  const model = (id) => ({ ref: 'chat:' + id, purpose: 'chat', name: id, provider: 'test', modelId: id, configured: true });
  const host = harness({
    modelsList(call) {
      if (call === 1) return { models: [model('initial')] };
      if (call === 2) return slow.promise;
      return { models: [model('latest')] };
    }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.configure).handler({});
  host.commands.get(__testing.commands.configure).handler({});
  await waitFor(() => __testing.getState().models.some((item) => item.ref === 'chat:latest'));
  slow.resolve({ models: [model('stale')] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(__testing.getState().models.map((item) => item.ref), ['chat:latest']);
  await deactivate();
});

test('cancels a pending title refinement during deactivation', async () => {
  await deactivate();
  const title = deferred();
  const host = harness({
    modelResponses: [{ content: 'Done.', toolCalls: [] }],
    titleResponse() { return title.promise; }
  });
  await activate(host.context);
  host.commands.get(__testing.commands.send).handler({
    text: 'Analyze a long request with several clauses, validate the result, and produce a concise report.',
    modelRef: 'chat:test'
  });
  await waitFor(() => host.titleCalls.length === 1);
  const requestId = host.titleCalls[0].requestId;
  await deactivate();
  assert.equal(host.cancellations.includes(requestId), true);
  title.resolve({ content: 'Late title', toolCalls: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(__testing.getState(), null);
});

test('rejects late Skill reads after a run is cancelled', async () => {
  await deactivate();
  const skill = deferred();
  let readStarted = false;
  const host = harness({
    skillRead() {
      readStarted = true;
      return skill.promise;
    }
  });
  await activate(host.context);
  const sent = host.commands.get(__testing.commands.send).handler({
    text: 'Use the selected Skill.',
    modelRef: 'chat:test',
    skillIds: ['skill-test']
  });
  await waitFor(() => readStarted);
  host.commands.get(__testing.commands.cancel).handler({ sessionId: sent.sessionId });
  skill.resolve({ id: 'skill-test', name: 'Test Skill', content: 'Late Skill content.' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const session = __testing.getState().activeSession;
  assert.equal(session.status, 'cancelled');
  assert.equal(session.timeline.some((item) => item.kind === 'skill'), false);
  assert.equal(host.modelCalls.length, 0);
  await deactivate();
});

test('sanitizes restored titles and removes persisted raw reasoning', async () => {
  await deactivate();
  const stored = storedSession([{ role: 'assistant', content: 'Stored answer' }]);
  stored.sessions[0].title = '\u202eUnsafe\u200b ' + 'x'.repeat(220);
  stored.sessions[0].messages[0].reasoning = 'private-message-reasoning';
  stored.sessions[0].messages.push({ ...stored.sessions[0].messages[0], content: 'Latest duplicate message' });
  stored.sessions[0].goal = {
    title: '',
    status: 'pending',
    steps: [
      { id: 'duplicate-step', titleKey: 'goal.step.understand', status: 'completed' },
      { id: 'duplicate-step', titleKey: 'goal.step.inspect', status: 'pending' }
    ]
  };
  stored.sessions[0].timeline = [{
    id: 'event-old-thought',
    kind: 'thought',
    titleKey: 'timeline.thought',
    titleValues: { seconds: 3, ignored: { nested: true } },
    detail: 'private-timeline-reasoning',
    status: 'completed',
    createdAt: '2026-08-25T00:00:00.000Z'
  }];
  stored.sessions.push(structuredClone(stored.sessions[0]));
  const host = harness({ stored });
  await activate(host.context);
  const session = __testing.getState().activeSession;
  assert.equal(session.title.includes('\u202e'), false);
  assert.equal(session.title.includes('\u200b'), false);
  assert.equal(session.title.length <= __testing.maxSessionTitleCodeUnits, true);
  assert.equal(__testing.getState().sessions.length, 1);
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].content, 'Latest duplicate message');
  assert.equal(session.messages[0].reasoning, '');
  assert.equal(session.timeline[0].detail, '');
  assert.equal(session.goal.title, 'Complete the requested goal');
  assert.equal(new Set(session.goal.steps.map((step) => step.id)).size, 2);
  await waitFor(() => host.writes.length > 0);
  assert.equal(JSON.stringify(host.writes).includes('private-message-reasoning'), false);
  assert.equal(JSON.stringify(host.writes).includes('private-timeline-reasoning'), false);
  await deactivate();
});

test('cleans registrations that finish after deactivation', async () => {
  await deactivate();
  const gate = deferred();
  let lateRegistrationStarted = false;
  const host = harness({
    registerCommand(_commandId, call) {
      if (call === 10) {
        lateRegistrationStarted = true;
        return gate.promise;
      }
      return undefined;
    }
  });
  await activate(host.context);
  const localeSubscription = host.subscriptions.find((item) => typeof item.listener === 'function');
  localeSubscription.listener();
  await waitFor(() => lateRegistrationStarted);
  await deactivate();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.commands.size, 0);
  assert.equal(__testing.getState(), null);
});
