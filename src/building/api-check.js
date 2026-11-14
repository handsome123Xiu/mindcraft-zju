import { randomUUID } from 'node:crypto';
import { addTokenUsage, emptyTokenUsage, formatTokenUsage } from './token-usage.js';

class ApiCheckTimeout extends Error {}
class InvalidCheckReply extends Error {}

function failureReason(error, timeoutMs) {
    if (error instanceof ApiCheckTimeout) return '请求超时（' + timeoutMs / 1000 + ' 秒），请检查服务或网络';
    if (error instanceof InvalidCheckReply) return '接口已响应，但没有返回预期的测试结果';
    const message = String(error?.message ?? '');
    const status = message.match(/^Course API: HTTP (\d{3})$/)?.[1];
    if (status === '401' || status === '403') return '鉴权失败（HTTP ' + status + '），请检查 API Key 和访问权限';
    if (status === '400' || status === '422') return '请求配置不被接受（HTTP ' + status + '），请检查模型名和 params（包括 thinking 参数）';
    if (status === '404') return '接口或模型不存在（HTTP 404），请检查 API 地址和模型名';
    if (status === '429') return '请求限流或额度不足（HTTP 429）';
    if (status) return '服务请求失败（HTTP ' + status + '），请查看 logs/api-usage.jsonl';
    if (/API key "COURSE_API_KEY" not found/.test(message)) return '缺少 COURSE_API_KEY，请检查 keys.json 或环境变量';
    if (/需要 course_responses/.test(message)) return '请将模型 api 配置为 course_responses';
    if (/Configure model and API base URL/.test(message)) return '缺少模型名或 API 地址，请检查 andy.json';
    // Do not publish arbitrary exception text, response bodies or credentials in chat.
    return '网络异常或接口未返回完整回复，请查看 logs/api-usage.jsonl';
}

export async function checkApiConnection({ model, report, signal, timeoutMs = 60000 }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('API 检测时限无效');
    const started = Date.now();
    const runId = 'startup-api-' + randomUUID();
    const tokenUsage = emptyTokenUsage();
    const abort = new AbortController();
    const checkSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    let rejectOnAbort;
    let usageReceived = false;
    let requestStarted = false;
    let finished = false;
    let timer;
    let result;
    try {
        checkSignal.throwIfAborted();
        report('已连接游戏，正在检测模型 API（最多 ' + timeoutMs / 1000 + ' 秒）……');
        timer = setTimeout(() => abort.abort(new ApiCheckTimeout()), timeoutMs);
        const cancelled = new Promise((_, reject) => {
            rejectOnAbort = () => reject(checkSignal.reason);
            checkSignal.addEventListener('abort', rejectOnAbort, { once: true });
            if (checkSignal.aborted) rejectOnAbort();
        });
        const response = await Promise.race([
            Promise.resolve().then(() => {
                checkSignal.throwIfAborted();
                requestStarted = true;
                return model.sendRequest([{ role: 'user', content: 'Test the API connection. Reply exactly with {"status":"ok"}.' }],
                    'This is a connection test, not a Minecraft task. Output only the JSON object {"status":"ok"}. Do not use tools or add explanations.',
                    null, { signal: checkSignal, runId, purpose: 'startup', onUsage(usage) {
                        if (finished || usageReceived) return;
                        usageReceived = true;
                        addTokenUsage(tokenUsage, usage);
                    } });
            }),
            cancelled
        ]);
        checkSignal.throwIfAborted();
        let reply;
        try {
            reply = JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
        } catch { throw new InvalidCheckReply(); }
        if (reply?.status !== 'ok') throw new InvalidCheckReply();
        result = { ok: true, status: 'passed' };
    } catch (error) {
        result = signal?.aborted ? { ok: false, status: 'cancelled' } :
            { ok: false, status: 'failed', reason: failureReason(checkSignal.aborted ? checkSignal.reason : error, timeoutMs) };
    } finally {
        finished = true;
        clearTimeout(timer);
        if (rejectOnAbort) checkSignal.removeEventListener('abort', rejectOnAbort);
        if (requestStarted && !usageReceived) tokenUsage.unreportedRequests++;
    }
    result = { ...result, runId, elapsedMs: Date.now() - started, tokenUsage };
    if (result.status !== 'cancelled') {
        const elapsed = (result.elapsedMs / 1000).toFixed(1);
        report(result.ok ? 'API 检测通过：' + (model.modelName ?? '当前模型') + '，耗时 ' + elapsed + ' 秒。' :
            'API 检测失败：' + result.reason + '。耗时 ' + elapsed + ' 秒。');
        if (usageReceived) report('API 检测用量（独立于任务）：' + formatTokenUsage(tokenUsage));
    }
    return result;
}
