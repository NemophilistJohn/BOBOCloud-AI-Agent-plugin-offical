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
  const toolCalls = [];
  const cancellations = [];
  const writes = [];
  const subscriptions = [];
  let descriptor = null;
  const modelResponses = [...(options.modelResponses || [{ content: 'Done.', toolCalls: [] }])];
  const context = {
    subscriptions: {
      add(value) { subscriptions.push(value); return value; }
    },
    commands: {
      async register(commandId, handler, metadata) {
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
          async setState(state) { if (active) states.push(structuredClone(state)); },
          clearState() {},
          dispose() { active = false; }
        };
      }
    },
    models: {
      async list() {
        return { models: [{ ref: 'chat:test', purpose: 'chat', name: 'Test', provider: 'test', modelId: 'test-1', configured: true }] };
      },
      async generate(args) {
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
        return { skills: [{ id: 'skill-test', name: 'Test Skill', description: 'Testing instructions', source: 'workspace' }] };
      },
      async read(skillId) {
        assert.equal(skillId, 'skill-test');
        return { id: skillId, name: 'Test Skill', description: 'Testing instructions', source: 'workspace', content: 'Always inspect the target before editing.' };
      }
    },
    storage: {
      async read() { return { value: options.stored || {} }; },
      async write(value) { writes.push(structuredClone(value)); return { saved: true }; }
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
    toolCalls,
    cancellations,
    writes,
    subscriptions,
    get descriptor() { return descriptor; }
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
  assert.deepEqual(host.descriptor.capabilities.reasoningEfforts, ['low', 'medium', 'high', 'max']);

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
  assert.equal(host.modelCalls[0].requestId, host.modelCalls[1].requestId, 'one run must keep one cancellable request id');
  assert.match(host.modelCalls[0].messages[0].content, /Always inspect the target before editing/);
  assert.equal(completed.activeSession.timeline.some((item) => item.kind === 'skill'), true);
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
    text: 'Update the exported value.', mode: 'goal', reasoningEffort: 'medium', modelRef: 'chat:test', skillIds: []
  });
  const waiting = await waitFor(() => [...host.states].reverse().find((state) => state.activeSession?.status === 'waiting-approval'));
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
