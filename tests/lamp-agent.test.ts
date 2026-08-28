import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAgentReply, withForcedName, runBuildAgent, summarizeBuildOutput, buildSystemPrompt, MAX_ROUNDS,
  type AgentDeps, type AgentInput, type ChatMessage, type BuildResult,
} from '../src/lib/lamp-agent.ts';
import { parseAgentStatus } from '../src/lib/lamp-pipeline.ts';

const REPLY_BOTH = `Här är förslaget.
### spec.md
\`\`\`markdown
# Kravspec — test
| Rad | Mått | Värde | Kommentar |
|---|---|---|---|
| 1 | Diameter | 160 | |
\`\`\`
### del.py
\`\`\`python
from build123d import *
DIAM = 160.0  # spec rad 1
with BuildPart() as b:
    Cylinder(DIAM / 2, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))
part = b.part
NAMN = "modellens_eget_namn"
\`\`\`
Klart.`;

test('parseAgentReply plockar båda blocken', () => {
  const r = parseAgentReply(REPLY_BOTH);
  assert.match(r.spec ?? '', /^# Kravspec — test/);
  assert.match(r.code ?? '', /Cylinder\(DIAM/);
  assert.ok(r.code!.endsWith('\n'));
});

test('parseAgentReply: bara del.py vid rättning, fallback på språk, tomt svar', () => {
  const only = parseAgentReply('### del.py\n```python\nx = 1\n```');
  assert.equal(only.spec, undefined);
  assert.equal(only.code, 'x = 1\n');
  const fallback = parseAgentReply('Kod:\n```py\ny = 2\n```\nSpec:\n```md\n# s\n```');
  assert.equal(fallback.code, 'y = 2\n');
  assert.equal(fallback.spec, '# s\n');
  assert.deepEqual(parseAgentReply('ingen kod här'), { spec: undefined, code: undefined });
});

test('withForcedName byter ut NAMN-raden', () => {
  const out = withForcedName('a = 1\nNAMN = "x"\nb = 2\n', 'agent_lampa-1');
  assert.equal(out, 'a = 1\nb = 2\n\nNAMN = "agent_lampa-1"\n');
  assert.equal(withForcedName('a = 1', 'n'), 'a = 1\n\nNAMN = "n"\n');
});

test('summarizeBuildOutput plockar valideringsraderna', () => {
  const lines = summarizeBuildOutput('  del: x\n  matt: 1 x 2 x 3 mm\n  volym: 5 cm3\n  FEL: Z=260 far inte plats\nTraceback (most recent call last):\n  File x\nNameError: name q is not defined');
  assert.deepEqual(lines, ['matt: 1 x 2 x 3 mm', 'volym: 5 cm3', 'FEL: Z=260 far inte plats', 'Traceback (most recent call last):', 'NameError: name q is not defined']);
});

test('systemprompten bär konventionerna och exemplen', () => {
  const p = buildSystemPrompt([{ name: 'demo_konsol.py', code: 'BREDD = 60.0' }]);
  assert.match(p, /E27/);
  assert.match(p, /### del\.py/);
  assert.match(p, /demo_konsol\.py/);
  assert.match(p, /BREDD = 60\.0/);
});

function harness(replies: string[], builds: BuildResult[]) {
  const calls: ChatMessage[][] = [];
  const buildCalls: { id: string; code: string; spec: string }[] = [];
  const statuses: string[] = [];
  let t = 0;
  const deps: AgentDeps = {
    model: 'test-modell',
    now: () => new Date(2026, 7, 28, 15, 0, t++),
    callModel: async (messages) => { calls.push(structuredClone(messages)); return { text: replies.shift() ?? '', usage: { input: 10, output: 5 } }; },
    runBuild: async (id, code, spec) => { buildCalls.push({ id, code, spec }); return builds.shift() ?? { ok: false, output: 'slut på svar' }; },
    writeStatus: async (_id, s) => { statuses.push(`${s.state}/${s.step}/${s.round}`); },
  };
  const input: AgentInput = { id: 'lampa-1', userPrompt: 'spjälor', image: { base64: 'AAAA', mimeType: 'image/jpeg' }, examples: [] };
  return { deps, input, calls, buildCalls, statuses };
}

test('loopen: lyckas i varv 1', async () => {
  const h = harness([REPLY_BOTH], [{ ok: true, output: '  matt: 160 x 160 x 10 mm\n  -> publicerad: /x' }]);
  const s = await runBuildAgent(h.input, h.deps);
  assert.equal(s.state, 'done');
  assert.equal(s.round, 1);
  assert.equal(h.buildCalls.length, 1);
  assert.match(h.buildCalls[0].code, /NAMN = "agent_lampa-1"/);
  assert.doesNotMatch(h.buildCalls[0].code, /modellens_eget_namn/);
  assert.match(h.buildCalls[0].spec, /Kravspec/);
  assert.deepEqual(s.usage, { input: 10, output: 5 });
  assert.equal(statusHas(h.statuses, 'done/klar/1'), true);
  // första anropet: system + user med bild
  const first = h.calls[0];
  assert.equal(first[0].role, 'system');
  assert.ok(Array.isArray(first[1].content) && first[1].content.some((p) => p.type === 'image_url'));
});

test('loopen: fel i varv 1 -> feedback med utskrift + rendering -> ok i varv 2', async () => {
  const fix = '### del.py\n```python\nfrom build123d import *\npart = Cylinder(1, 1)\n```';
  const h = harness([REPLY_BOTH, fix], [
    { ok: false, output: '  FEL: Z=260.0 mm far inte plats pa badden (220 mm)', previewB64: 'UFJFVklFVw==' },
    { ok: true, output: '  -> publicerad: /x' },
  ]);
  const s = await runBuildAgent(h.input, h.deps);
  assert.equal(s.state, 'done');
  assert.equal(s.round, 2);
  assert.equal(h.buildCalls.length, 2);
  // specen från varv 1 återanvänds när rättningen bara innehåller del.py
  assert.match(h.buildCalls[1].spec, /Kravspec — test/);
  const second = h.calls[1];
  const fb = second[second.length - 1];
  assert.equal(fb.role, 'user');
  assert.ok(Array.isArray(fb.content));
  const txt = (fb.content as { type: string; text?: string }[]).find((p) => p.type === 'text')?.text ?? '';
  assert.match(txt, /MISSLYCKADES/);
  assert.match(txt, /Z=260/);
  assert.ok((fb.content as { type: string }[]).some((p) => p.type === 'image_url'));
  assert.ok(s.log.some((e) => /FEL: Z=260/.test(e.msg)));
});

test('loopen: fel x3 -> failed, publish aldrig ok, exakt MAX_ROUNDS modellanrop', async () => {
  const h = harness([REPLY_BOTH, REPLY_BOTH, REPLY_BOTH], [
    { ok: false, output: 'Traceback\nNameError: x' }, { ok: false, output: 'Traceback\nNameError: y' }, { ok: false, output: 'Traceback\nNameError: z' },
  ]);
  const s = await runBuildAgent(h.input, h.deps);
  assert.equal(s.state, 'failed');
  assert.equal(s.round, MAX_ROUNDS);
  assert.equal(h.calls.length, MAX_ROUNDS);
  assert.equal(h.buildCalls.length, MAX_ROUNDS);
  assert.ok(s.finishedAt);
});

test('loopen: svar utan kod ber om formatet igen och räknar som ett varv', async () => {
  const h = harness(['bara prosa', REPLY_BOTH], [{ ok: true, output: '-> publicerad: /x' }]);
  const s = await runBuildAgent(h.input, h.deps);
  assert.equal(s.state, 'done');
  assert.equal(s.round, 2);
  assert.equal(h.buildCalls.length, 1);
  const nudge = h.calls[1][h.calls[1].length - 1];
  assert.match(String(nudge.content), /python-block/);
});

test('loopen: sparar råsvar per varv och loggar kapade svar', async () => {
  const h = harness([REPLY_BOTH], [{ ok: true, output: '-> publicerad: /x' }]);
  const saved: [number, string][] = [];
  h.deps.saveReply = async (_id, round, text) => { saved.push([round, text]); };
  const orig = h.deps.callModel;
  h.deps.callModel = async (m) => ({ ...(await orig(m)), finishReason: 'length' });
  const s = await runBuildAgent(h.input, h.deps);
  assert.equal(s.state, 'done');
  assert.deepEqual(saved.map(([r]) => r), [1]);
  assert.match(saved[0][1], /### del\.py/);
  assert.ok(s.log.some((e) => /max_tokens/.test(e.msg)));
});

test('loopen: modellanrop som kastar -> failed utan bygg', async () => {
  const h = harness([], []);
  h.deps.callModel = async () => { throw new Error('TensorX svarade 401'); };
  const s = await runBuildAgent(h.input, h.deps);
  assert.equal(s.state, 'failed');
  assert.equal(h.buildCalls.length, 0);
  assert.ok(s.log.some((e) => /401/.test(e.msg)));
});

test('parseAgentStatus är fail-closed', () => {
  assert.equal(parseAgentStatus(null), null);
  assert.equal(parseAgentStatus({ state: 'weird', startedAt: 'x' }), null);
  assert.equal(parseAgentStatus({ state: 'running' }), null);
  const ok = parseAgentStatus({ state: 'running', startedAt: '2026', log: [{ t: '1', msg: 'a' }, 'skräp', { msg: 'utan t' }], round: 'nej' });
  assert.equal(ok?.state, 'running');
  assert.deepEqual(ok?.log, [{ t: '1', msg: 'a' }]);
  assert.equal(ok?.round, 0);
});

function statusHas(list: string[], s: string) { return list.includes(s); }
