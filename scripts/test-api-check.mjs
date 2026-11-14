import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CourseResponses } from '../src/models/course_responses.js';
import { checkApiConnection } from '../src/building/api-check.js';

const originalFetch = globalThis.fetch;
const originalDirectory = process.cwd();
const directory = await mkdtemp(join(tmpdir(), 'mindcraft-api-check-'));
const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25 };
const model = Object.assign(Object.create(CourseResponses.prototype), {
    modelName: 'glm-offline-test', url: 'https://example.invalid/responses',
    params: { max_output_tokens: 4096, reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } }, key: 'not-a-real-secret'
});
const response = data => ({ ok: true, status: 200, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const messages = [];
const run = options => checkApiConnection({ model, report: text => messages.push(text), ...options });

try {
    process.chdir(directory);
    // Exercise the real adapter and the real request parameters, without a live API.
    let payload;
    let requestSignal;
    const pending = deferred();
    globalThis.fetch = async (url, options) => {
        assert.equal(url, model.url);
        payload = JSON.parse(options.body);
        requestSignal = options.signal;
        return pending.promise;
    };
    const checking = run();
    assert.match(messages[0], /正在检测/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.length, 1, 'do not report success before receiving the final reply');
    assert.equal(payload.model, model.modelName);
    assert.deepEqual(payload.reasoning, { effort: 'low' });
    assert.deepEqual(payload.text, { format: { type: 'json_object' } });
    assert.equal(payload.max_output_tokens, 4096);
    assert.equal(payload.stream, false);
    assert.equal(payload.store, false);
    assert.equal(requestSignal.aborted, false);
    pending.resolve(response({ status: 'completed', output_text: '{"status":"ok"}', usage }));
    const passed = await checking;
    assert.equal(passed.ok, true);
    assert.equal(passed.status, 'passed');
    assert.match(passed.runId, /^startup-api-/);
    assert.equal(passed.tokenUsage.totalTokens, 25);
    assert(messages.some(text => /检测通过.*glm-offline-test.*耗时/.test(text)));
    assert(messages.some(text => /独立于任务.*25/.test(text)));

    for (const [status, reason] of [[401, /鉴权失败/], [403, /访问权限/],
        [400, /请求配置不被接受/], [422, /thinking/], [404, /接口或模型不存在/],
        [429, /限流或额度/], [503, /HTTP 503/]]) {
        messages.length = 0;
        globalThis.fetch = async () => ({ ok: false, status, json() { throw new Error('must not echo server body'); } });
        const result = await run();
        assert.equal(result.ok, false);
        assert.match(result.reason, reason);
        assert(messages.some(text => /检测失败/.test(text)));
        assert(!messages.some(text => /检测通过/.test(text)));
    }

    // HTTP 200 alone cannot pass: require a completed, usable reply.
    for (const data of [
        { status: 'completed', output_text: '{"status":"failed"}', usage },
        { status: 'completed', output_text: 'not JSON', usage },
        { status: 'incomplete', usage },
        { status: 'completed', output: [], usage }
    ]) {
        globalThis.fetch = async () => response(data);
        const result = await run();
        assert.equal(result.status, 'failed');
        assert.equal(result.tokenUsage.totalTokens, 25, 'failed billed replies still record usage');
    }

    // A timeout returns promptly and aborts the actual request.
    globalThis.fetch = async (_, options) => new Promise((_, reject) => {
        requestSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const timeout = await run({ timeoutMs: 25 });
    assert.equal(timeout.status, 'failed');
    assert.match(timeout.reason, /请求超时/);
    assert.equal(requestSignal.aborted, true);
    await new Promise(resolve => setImmediate(resolve));

    // Disconnects cancel the startup test without reporting a misleading API failure.
    const disconnected = new AbortController();
    const started = deferred();
    globalThis.fetch = async (_, options) => new Promise((_, reject) => {
        started.resolve();
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    messages.length = 0;
    const stopped = run({ signal: disconnected.signal });
    await started.promise;
    disconnected.abort(new Error('Minecraft disconnected'));
    assert.equal((await stopped).status, 'cancelled');
    assert.equal(messages.length, 1);
    await new Promise(resolve => setImmediate(resolve));

    // An already-disconnected bot cannot initiate a request or invent usage.
    const before = await run({ signal: disconnected.signal });
    assert.equal(before.status, 'cancelled');
    assert.equal(before.tokenUsage.unreportedRequests, 0);

    // Config/transport exceptions are converted to useful, safe chat messages.
    for (const [message, expected] of [
        ['API key "COURSE_API_KEY" not found in keys.json or environment variables!', /缺少 COURSE_API_KEY/],
        ['建筑 Agent 需要 course_responses 模型配置', /配置为 course_responses/],
        ['Configure model and API base URL in andy.json', /缺少模型名或 API 地址/],
        ['unexpected error containing not-a-real-secret and https://private.invalid', /网络异常/]
    ]) {
        const result = await run({ model: { async sendRequest() { throw new Error(message); } } });
        assert.match(result.reason, expected);
        assert(!result.reason.includes('not-a-real-secret'));
        assert(!result.reason.includes('private.invalid'));
    }
    const records = (await readFile(join(directory, 'logs/api-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert(records.every(record => record.run_id.startsWith('startup-api-')));
    assert(records.some(record => record.ok === true && record.usage.total_tokens === 25));
} finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalDirectory);
    const temporaryPath = relative(resolve(tmpdir()), resolve(directory));
    assert(!isAbsolute(temporaryPath) && !temporaryPath.startsWith('..') && temporaryPath.startsWith('mindcraft-api-check-'));
    await rm(directory, { recursive: true, force: true });
}
console.log('Startup API checks passed: real adapter/params, progress reports, valid replies, HTTP errors, timeout, disconnect, independent usage and safe failure messages.');
