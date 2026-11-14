import { appendFileSync, mkdirSync } from 'node:fs';
import { getKey } from '../utils/keys.js';

export function extractFinalText(response, stop = '***') {
    if (response.status && response.status !== 'completed') throw new Error('Incomplete model response');
    let text = response.output_text ?? (response.output ?? [])
        .filter(item => item.type === 'message' && item.role === 'assistant')
        .flatMap(item => item.content ?? [])
        .filter(part => part.type === 'output_text')
        .map(part => part.text ?? '').join('\n');
    text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
    if (/<\/?think\b/i.test(text)) throw new Error('Unfinished reasoning section');
    if (stop && text.includes(stop)) text = text.slice(0, text.indexOf(stop));
    text = text.trim();
    if (!text) throw new Error('Model returned no final answer');
    return text;
}

// Mindcraft memory/decision prompts put the whole task in instructions.
// The course gateway nevertheless requires at least one input message.
export function buildCourseInput(turns) {
    if (turns.length === 0) return [{role: 'user', content: 'Complete the task described in the instructions.'}];
    return turns.map(turn => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: (turn.role === 'system' ? 'Game feedback: ' : '') + String(turn.content)
    }));
}

export class CourseApiError extends Error {
    constructor(reason, code, details = {}) {
        super('Course API: ' + reason);
        this.name = 'CourseApiError';
        this.code = code;
        Object.assign(this, details);
    }
}

export class CourseResponses {
    static prefix = 'course_responses';
    constructor(modelName, url, params) {
        if (!modelName || !url) throw new Error('Configure model and API base URL in andy.json');
        this.modelName = modelName;
        this.url = url.replace(/\/+$/, '') + '/responses';
        this.params = params || {};
        this.key = getKey('COURSE_API_KEY');
    }
    async sendRequest(turns, systemMessage, stop = '***', { signal, runId, onUsage, purpose } = {}) {
        const started = Date.now();
        const record = { timestamp: new Date().toISOString(), model: this.modelName, run_id: runId };
        // This is a local transport option, never a parameter sent to the gateway.
        const { request_timeout_ms: timeoutMs = 120000, ...params } = this.params;
        let timeout;
        record.timeout_ms = timeoutMs;
        record.phase = 'preparing_request';
        if (['decision', 'blueprint', 'startup', 'diagnostic'].includes(purpose)) record.purpose = purpose;
        try {
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) {
                throw new CourseApiError('request_timeout_ms must be an integer in 1..600000', 'API_CONFIG');
            }
            timeout = AbortSignal.timeout(timeoutMs);
            const input = buildCourseInput(turns);
            const body = JSON.stringify({ ...params, model: this.modelName,
                instructions: systemMessage, input, store: false, stream: false });
            record.request_bytes = Buffer.byteLength(body, 'utf8');
            record.instructions_chars = systemMessage?.length ?? 0;
            record.input_chars = input.reduce((sum, turn) => sum + turn.content.length, 0);
            record.max_output_tokens = params.max_output_tokens ?? null;
            record.reasoning_effort = params.reasoning?.effort ?? null;
            record.phase = 'awaiting_headers';
            console.log(`[Course API] requesting ${this.modelName}: bytes=${record.request_bytes} timeout=${timeoutMs / 1000}s reasoning=${record.reasoning_effort ?? 'default'}`);
            const response = await fetch(this.url, {
                method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.key}`,
                    'x-openai-actor-authorization': 'local-image-extension'
                },
                body
            });
            record.http_status = response.status;
            record.response_headers_ms = Date.now() - started;
            if (!response.ok) throw new CourseApiError('HTTP ' + response.status, 'API_HTTP_ERROR');
            record.phase = 'reading_body';
            let data;
            try { data = await response.json(); }
            catch (error) {
                if (timeout?.aborted || signal?.aborted) throw error;
                if (error instanceof SyntaxError) throw new CourseApiError('invalid JSON response', 'API_INVALID_RESPONSE');
                throw error;
            }
            record.phase = 'validating_response';
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CourseApiError('invalid JSON response', 'API_INVALID_RESPONSE');
            record.usage = data.usage ?? null;
            record.response_status = data.status ?? null;
            // Account for billed responses even when their answer is incomplete or invalid.
            onUsage?.(record.usage);
            let answer;
            try { answer = extractFinalText(data, stop); }
            catch {
                throw new CourseApiError(data.status && data.status !== 'completed' ? 'incomplete model response' : 'invalid or empty final answer',
                    data.status && data.status !== 'completed' ? 'API_INCOMPLETE' : 'API_INVALID_RESPONSE');
            }
            record.ok = true;
            record.phase = 'completed';
            console.log(`[Course API] ${this.modelName}: input=${data.usage?.input_tokens ?? '?'} output=${data.usage?.output_tokens ?? '?'}`);
            return answer;
        } catch (error) {
            record.ok = false;
            if (signal?.aborted) {
                record.error_code = 'ABORTED';
                signal.throwIfAborted();
            }
            const failure = timeout?.aborted || error?.name === 'TimeoutError' ?
                new CourseApiError('request timed out', 'API_TIMEOUT') :
                error instanceof CourseApiError ? error : new CourseApiError('network error', 'API_NETWORK_ERROR');
            record.error_code = failure.code;
            const causeCode = error?.cause?.code;
            if (typeof causeCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(causeCode)) record.cause_code = causeCode;
            console.error(`[Course API] ${failure.message} (${record.phase}, ${(Date.now() - started) / 1000}s). See ./logs/api-usage.jsonl.`);
            throw Object.assign(failure, { phase: record.phase, timeoutMs, elapsedMs: Date.now() - started, httpStatus: record.http_status });
        } finally {
            record.elapsed_ms = Date.now() - started;
            try {
                mkdirSync('./logs', { recursive: true });
                appendFileSync('./logs/api-usage.jsonl', JSON.stringify(record) + '\n');
            } catch { console.warn('[Course API] Could not write usage log.'); }
        }
    }
    async sendVisionRequest() { throw new Error('Vision is disabled for this profile.'); }
    async embed() { throw new Error('Use embedding: false for the course profile.'); }
}
