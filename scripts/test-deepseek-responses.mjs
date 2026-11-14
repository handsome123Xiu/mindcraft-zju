import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekResponses } from '../src/models/deepseek_responses.js';
import { checkApiConnection } from '../src/building/api-check.js';
import { parseAction } from '../src/building/action-protocol.js';
import { nativeFunctions, extractNativeActions } from '../src/building/native-actions.js';

const previousFetch = globalThis.fetch, previousCwd = process.cwd();
const directory = await mkdtemp(join(tmpdir(), 'mindcraft-deepseek-'));
const model = Object.assign(Object.create(DeepSeekResponses.prototype), {
    modelName: 'deepseek-flash', provider: 'DeepSeek', key: 'fake-deepseek-credential',
    url: 'https://api.deepseek.com/responses', params: { reasoning: { effort: 'high' }, text: { format: { type: 'json_object' } }, max_output_tokens: 4096 }
});
const usage = { input_tokens: 90, output_tokens: 20, total_tokens: 110 };
try {
    process.chdir(directory);
    globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://api.deepseek.com/responses');
        assert.equal(options.headers.Authorization, 'Bearer fake-deepseek-credential');
        assert.equal(options.headers['x-openai-actor-authorization'], undefined);
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'deepseek-flash');
        assert.equal(body.max_output_tokens, 4096);
        assert.equal(body.text.format.type, 'json_object');
        assert.equal(body.reasoning.effort, 'high');
        assert.equal(body.stream, false);
        return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [
            { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'private reasoning' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"status":"ok"}' }] }
        ], usage }) };
    };
    const reports = [];
    const passed = await checkApiConnection({ model, report: message => reports.push(message) });
    assert.equal(passed.ok, true);
    assert.equal(passed.tokenUsage.totalTokens, 110);
    const functions = nativeFunctions(['tool', 'batch', 'update_plan', 'wait_for_team'], ['delegate_task', 'send_message']);
    const action = { action: 'tool', name: 'send_message', args: { text: 'hello' } };
    const call = { type: 'function_call', name: 'send_message', arguments: JSON.stringify(action.args) };
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.reasoning.effort, 'none', 'forced tool_choice is rejected in DeepSeek thinking mode');
        assert.equal(body.text, undefined, 'do not combine text JSON mode and native calls');
        assert.equal(body.tool_choice, 'required');
        assert.deepEqual(body.tools, functions);
        assert(!body.tools.some(tool => ['submit_action', 'batch', 'tool'].includes(tool.name)));
        return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [call], usage }) };
    };
    assert.deepEqual(parseAction(await model.sendRequest([{ role: 'user', content: 'test' }], 'JSON action', null,
        { purpose: 'decision', nativeFunctions: functions })), action);
    assert.equal(model.params.reasoning.effort, 'high', 'blueprint/startup parameters remain independent');
    assert.equal(model.params.text.format.type, 'json_object');
    assert.equal(JSON.parse(extractNativeActions({ output: [call, call] }, functions)).steps.length, 2);
    assert.throws(() => extractNativeActions({ status: 'incomplete', output: [call] }, functions));
    assert.throws(() => extractNativeActions({ output: [{ ...call, name: 'invented_tool' }] }, functions));
    const update = { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ steps: [{ id: 's1', title: 'Build', success: 'verified' }] }) };
    const dispatch = { type: 'function_call', name: 'delegate_task', arguments: JSON.stringify({ key: 'a', recipient: 'builder_1', partIds: ['part-1'], description: 'build', success: 'verified' }) };
    const mixed = JSON.parse(extractNativeActions({ output: [update, dispatch] }, functions));
    assert.deepEqual(mixed.steps.map(step => step.name), ['update_plan', 'delegate_task']);
    assert.deepEqual(JSON.parse(extractNativeActions({ output: [dispatch, update] }, functions)).steps.map(step => step.name), ['delegate_task', 'update_plan'], 'preserve returned order');
    assert.throws(() => extractNativeActions({ output: [dispatch, { ...update, arguments: '{' }] }, functions), error => !!error.rawResponse && error.field === 'calls[1].arguments');
    assert.throws(() => extractNativeActions({ output: [dispatch, { type: 'function_call', name: 'wait_for_team', arguments: '{"reason":"wait"}' }] }, functions), /单独调用/);
    assert.throws(() => extractNativeActions({ output: [{ ...call, arguments: '{"text":"hello","invented":true}' }] }, functions), error => error.code === 'INVALID_ARGUMENT');
    assert.throws(() => extractNativeActions({ output: [{ ...call, name: 'submit_action' }] }, functions));
    // Real failure pattern: native-looking DSML in the text channel is not an
    // actual function call, and argument-only text never grants an operation.
    const dsml = '[{"name":"delegate_task","args":{}}]</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
    assert.throws(() => extractNativeActions({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: dsml }] }] }, functions));
    assert.throws(() => parseAction(dsml));
    assert.throws(() => parseAction('{"recipient":"builder_1","partIds":["part-1"]}'));
    for (const [status, expected] of [[401, /鉴权失败/], [402, /余额不足/], [404, /模型不存在/], [429, /限流/]]) {
        globalThis.fetch = async () => ({ ok: false, status });
        const failed = await checkApiConnection({ model, report: message => reports.push(message) });
        assert.equal(failed.ok, false); assert.match(failed.reason, expected);
    }
    const logs = await readFile(join(directory, 'logs/api-usage.jsonl'), 'utf8');
    assert(!logs.includes(model.key));
    assert(!logs.includes('private reasoning'));
    assert(!reports.join().includes(model.key));
    console.log('DeepSeek Responses checks passed: request protocol, final JSON, usage, safe errors and credential-free logs.');
} finally {
    globalThis.fetch = previousFetch; process.chdir(previousCwd); await rm(directory, { recursive: true, force: true });
}
