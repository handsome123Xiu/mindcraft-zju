import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CourseResponses } from '../src/models/course_responses.js';

// Exercise the real adapter without sending requests or recording test usage in the project.
const originalFetch = globalThis.fetch;
const originalDirectory = process.cwd();
const directory = await mkdtemp(join(tmpdir(), 'mindcraft-token-usage-'));
const model = Object.assign(Object.create(CourseResponses.prototype), {
    modelName: 'offline-test', url: 'https://example.invalid/responses', params: {}, key: 'test-only'
});
const usage = { input_tokens: 200, output_tokens: 50, total_tokens: 250 };
const reports = [];
const options = { runId: 'token-test', onUsage: value => reports.push(value) };
try {
    process.chdir(directory);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
        status: 'completed', output_text: '{"action":"blocked"}', usage
    }) });
    assert.equal(await model.sendRequest([], 'test', null, options), '{"action":"blocked"}');
    assert.deepEqual(reports, [usage]);

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
        status: 'incomplete', usage
    }) });
    await assert.rejects(model.sendRequest([], 'test', null, options), /Course API/);
    assert.deepEqual(reports, [usage, usage], 'incomplete responses still report billed usage');

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
        status: 'completed', output_text: '{}'
    }) });
    await model.sendRequest([], 'test', null, options);
    assert.equal(reports.at(-1), null);

    globalThis.fetch = async () => { throw new Error('simulated network failure'); };
    await assert.rejects(model.sendRequest([], 'test', null, options), /Course API/);
    assert.equal(reports.length, 3, 'network failures cannot invent usage');
    const records = (await readFile(join(directory, 'logs/api-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 4);
    assert.deepEqual(records[1].usage, usage);
    assert.equal(records[1].ok, false);
    assert.equal(records[1].error_code, 'API_INCOMPLETE');
    assert.equal(records[1].phase, 'validating_response');
    assert.equal(records[3].error_code, 'API_NETWORK_ERROR');
    assert.equal(records[3].phase, 'awaiting_headers');
    assert(records[0].request_bytes > records[0].instructions_chars);

    // Configured local deadlines must abort a hung request, be classified by stage,
    // and stay out of the gateway payload. No error text or credentials are logged.
    model.params = { request_timeout_ms: 25, reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } };
    let payload;
    globalThis.fetch = async (_, request) => new Promise((resolve, reject) => {
        payload = JSON.parse(request.body);
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(model.sendRequest([], 'test', null, { runId: 'headers-timeout' }),
            error => error.code === 'API_TIMEOUT' && error.phase === 'awaiting_headers' && error.timeoutMs === 25);
        assert.equal(payload.request_timeout_ms, undefined);
        assert.deepEqual(payload.reasoning, { effort: 'low' });
        assert.deepEqual(payload.text, { format: { type: 'json_object' } });
        globalThis.fetch = async (_, request) => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        }) });
        await assert.rejects(model.sendRequest([], 'test', null, { runId: 'body-timeout' }),
            error => error.code === 'API_TIMEOUT' && error.phase === 'reading_body');
    } finally { clearTimeout(keepAlive); }
    const all = (await readFile(join(directory, 'logs/api-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(all.at(-1).http_status, 200);
    assert.equal(all.at(-1).phase, 'reading_body');
    assert.equal(all.at(-2).http_status, undefined);
    assert.equal(all.at(-2).reasoning_effort, 'low');
    assert(!JSON.stringify(all).includes('test-only'));
} finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalDirectory);
    const temporaryPath = relative(resolve(tmpdir()), resolve(directory));
    assert(!isAbsolute(temporaryPath) && !temporaryPath.startsWith('..') &&
        temporaryPath.startsWith('mindcraft-token-usage-'), 'cleanup must stay within the test temporary directory');
    await rm(directory, { recursive: true, force: true });
}
console.log('Token usage adapter checks passed: successful, incomplete, missing usage and failed requests.');
