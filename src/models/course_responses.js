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

export class CourseResponses {
    static prefix = 'course_responses';
    constructor(modelName, url, params) {
        if (!modelName || !url) throw new Error('Configure model and API base URL in andy.json');
        this.modelName = modelName;
        this.url = url.replace(/\/+$/, '') + '/responses';
        this.params = params || {};
        this.key = getKey('COURSE_API_KEY');
    }
    async sendRequest(turns, systemMessage, stop = '***', { signal, runId } = {}) {
        const started = Date.now();
        const record = { timestamp: new Date().toISOString(), model: this.modelName, run_id: runId };
        const timeout = AbortSignal.timeout(120000);
        try {
            const response = await fetch(this.url, {
                method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.key}`,
                    'x-openai-actor-authorization': 'local-image-extension'
                },
                body: JSON.stringify({
                    ...this.params,
                    model: this.modelName,
                    instructions: systemMessage,
                    input: buildCourseInput(turns),
                    store: false, stream: false
                })
            });
            record.http_status = response.status;
            if (!response.ok) throw new Error('Course API HTTP error');
            const data = await response.json();
            record.usage = data.usage ?? null;
            record.response_status = data.status ?? null;
            const answer = extractFinalText(data, stop);
            record.ok = true;
            console.log(`[Course API] ${this.modelName}: input=${data.usage?.input_tokens ?? '?'} output=${data.usage?.output_tokens ?? '?'}`);
            return answer;
        } catch (error) {
            record.ok = false;
            signal?.throwIfAborted();
            const reason = error?.name === 'TimeoutError' ? 'request timed out' :
                record.http_status && record.http_status !== 200 ? `HTTP ${record.http_status}` :
                'network error or invalid/incomplete response';
            console.error(`[Course API] ${reason}. See ./logs/api-usage.jsonl.`);
            throw new Error(`Course API: ${reason}`);
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
