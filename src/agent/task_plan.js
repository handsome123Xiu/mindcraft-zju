import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';

const clip = (value, n = 500) => String(value ?? '').slice(0, n);
const terminal = new Set(['completed', 'cancelled']);

export function parsePlanResponse(text) {
    const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const data = JSON.parse(raw);
    if (!['task', 'chat', 'continue', 'pause', 'cancel', 'status', 'clarify'].includes(data.intent)) throw new Error('Invalid planner intent');
    if (data.intent !== 'task') return data;
    if (!data.goal || !Array.isArray(data.steps) || !data.steps.length || data.steps.length > 12) throw new Error('Plan needs a goal and 1-12 steps');
    const ids = new Set();
    data.steps = data.steps.map((step, i) => {
        if (typeof step.id !== 'string' || !step.id || step.id.length > 30 || ids.has(step.id) || !step.title) throw new Error('Invalid step ID/title');
        const deps = step.depends_on ?? (i ? [data.steps[i - 1].id] : []);
        if (!Array.isArray(deps) || deps.some(id => !ids.has(id))) throw new Error('Dependencies must refer to earlier steps');
        ids.add(step.id);
        const c = step.success;
        if (!c || !['inventory', 'position', 'near_player', 'block', 'manual'].includes(c.type)) throw new Error('Invalid success criterion');
        if (c.type === 'inventory' && (!c.item || !Number.isInteger(c.count) || c.count < 1)) throw new Error('Invalid inventory criterion');
        if (['position', 'block'].includes(c.type) && !['x', 'y', 'z'].every(k => Number.isFinite(c[k]))) throw new Error('Invalid coordinates');
        if (c.type === 'position' || c.type === 'near_player') {
            if (!Number.isFinite(c.radius) || c.radius <= 0 || c.radius > 32) throw new Error('Invalid radius');
        }
        if (c.type === 'near_player' && !c.player) throw new Error('Missing player');
        if (c.type === 'block' && !c.block) throw new Error('Missing block name');
        if (c.type === 'manual' && !c.description) throw new Error('Missing observable success description');
        if (!['skill', 'code'].includes(step.execution)) throw new Error('Invalid execution mode');
        if (step.execution === 'code' && !step.code_reason?.trim()) throw new Error('Code requires a capability-gap explanation');
        return { id: clip(step.id, 30), title: clip(step.title, 180), depends_on: deps,
            preconditions: (Array.isArray(step.preconditions) ? step.preconditions : []).map(x => clip(x, 160)).slice(0, 8),
            success: c, execution: step.execution, code_reason: clip(step.code_reason), status: 'pending', attempts: 0, evidence: '' };
    });
    return data;
}

export function checkCriterion(bot, criterion) {
    if (criterion.type === 'inventory') {
        const count = (bot.inventory?.items() ?? []).filter(x => x.name === criterion.item).reduce((n, x) => n + x.count, 0);
        return { ok: count >= criterion.count, evidence: `${criterion.item}: ${count}/${criterion.count}` };
    }
    if (criterion.type === 'position' || criterion.type === 'near_player') {
        const target = criterion.type === 'position' ? criterion : bot.players?.[criterion.player]?.entity?.position;
        const pos = bot.entity?.position;
        if (!target || !pos) return { ok: false, evidence: 'Target position/entity is not loaded; do not invent coordinates.' };
        const distance = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
        return { ok: distance <= criterion.radius, evidence: `distance=${distance.toFixed(2)}, radius=${criterion.radius}` };
    }
    if (criterion.type === 'block') {
        const block = bot.blockAt(new Vec3(criterion.x, criterion.y, criterion.z));
        return { ok: block?.name === criterion.block, evidence: `block at ${criterion.x},${criterion.y},${criterion.z}: ${block?.name ?? 'unloaded'}` };
    }
    return { ok: false, evidence: 'Requires !finishStep with observable evidence; completion will be marked model_reported, not machine_verified.' };
}

export class TaskPlan {
    constructor(agent, directory = `./bots/${agent.name}`) {
        this.agent = agent;
        this.directory = directory;
        mkdirSync(directory, { recursive: true });
        this.file = path.join(directory, 'task-plan.json');
        this.plan = null;
        this.epoch = 0;
        this.timer = null;
        this.busy = 0;
        this.stalls = 0;
        if (existsSync(this.file)) {
            try {
                this.plan = JSON.parse(readFileSync(this.file, 'utf8'));
                if (!Array.isArray(this.plan.steps)) throw new Error('Invalid saved plan');
                if (!terminal.has(this.plan.status)) {
                    this.plan.status = 'paused';
                    this.plan.note = 'Restarted: confirm the world/port and say continue to resume.';
                    this.save();
                }
            } catch { this.plan = null; console.warn('Could not load task plan; saved file left untouched.'); }
        }
    }
    save() {
        if (!this.plan) return;
        this.plan.updated_at = new Date().toISOString();
        writeFileSync(this.file + '.tmp', JSON.stringify(this.plan, null, 2));
        renameSync(this.file + '.tmp', this.file);
    }
    current() { return this.plan?.steps.find(s => s.status !== 'done'); }
    active() { return this.plan?.status === 'active'; }
    pause(reason = 'Paused by user', status = 'paused') {
        this.epoch++;
        this.agent.actions?.cancelResume?.();
        clearTimeout(this.timer); this.timer = null;
        if (this.plan && !terminal.has(this.plan.status)) {
            this.plan.status = status; this.plan.note = clip(reason); this.save();
        }
        return this.summary();
    }
    resume() {
        if (!this.plan || terminal.has(this.plan.status)) return '没有待继续的计划，请给一个新任务。';
        this.epoch++;
        this.plan.status = 'active'; this.plan.decisions = 0; this.plan.failures = 0;
        this.plan.note = ''; this.stalls = 0; this.save();
        return this.summary();
    }
    install(data, owner) {
        if (this.plan) {
            mkdirSync(path.join(this.directory, 'plans'), { recursive: true });
            writeFileSync(path.join(this.directory, 'plans', `${Date.now()}.json`), JSON.stringify(this.plan, null, 2));
        }
        this.epoch++;
        this.plan = { goal: clip(data.goal, 600), owner, status: 'active', steps: data.steps,
            decisions: 0, failures: 0, created_at: new Date().toISOString(), note: '' };
        this.stalls = 0; this.refresh(); this.save();
    }
    refresh() {
        if (!this.active()) return;
        for (const step of this.plan.steps) {
            if (step.status === 'done') continue;
            if (step.depends_on.some(id => this.plan.steps.find(s => s.id === id)?.status !== 'done')) break;
            step.status = 'running';
            const result = checkCriterion(this.agent.bot, step.success);
            if (!result.ok) break;
            step.status = 'done'; step.evidence = result.evidence; step.verification = 'machine_verified';
            this.stalls = 0;
        }
        if (this.plan.steps.every(s => s.status === 'done')) {
            this.plan.status = 'completed';
            this.plan.note = this.plan.steps.some(s => s.verification === 'model_reported') ? 'Some results are model-reported; inspect evidence.' : 'All criteria verified from game state.';
        }
        this.save();
    }
    finish(evidence) {
        if (!this.active()) return '没有正在执行的计划。';
        const step = this.current();
        if (!step) return this.summary();
        if (step.success.type !== 'manual') {
            const result = checkCriterion(this.agent.bot, step.success);
            if (!result.ok) return `不能标记完成：${result.evidence}`;
        } else {
            if (!evidence || evidence.trim().length < 8) return '请提供具体可观察的证据，不能只说“完成了”。';
            step.status = 'done'; step.evidence = clip(evidence); step.verification = 'model_reported';
        }
        this.stalls = 0; this.refresh(); return this.summary();
    }
    allowCode(reason) {
        if (!this.active()) return '先建立并激活任务计划，再申请自定义代码。';
        if (!reason || reason.trim().length < 20) return '说明现有指令或指令组合缺少什么能力；普通参数错误、缺材料和寻路失败不构成理由。';
        const step = this.current(); step.execution = 'code'; step.code_reason = clip(reason); this.save();
        return '已记录代码补充原因。可以用 !newAction 实现当前子目标；仍须检查完成标准。';
    }
    guard(command) {
        if (['!goal', '!endGoal'].includes(command)) return 'Use the persistent task plan and !resumePlan/!pausePlan instead.';
        if (command === '!newAction' && (!this.active() || this.current()?.execution !== 'code' || !this.current()?.code_reason)) {
            return 'Custom code is not approved for the current step. First use !requestCode with a specific capability-gap reason, or create a plan.';
        }
        return null;
    }
    observe(command, result) {
        if (!this.active()) return;
        const step = this.current();
        if (step && !['!plan', '!finishStep', '!requestCode'].includes(command)) step.attempts++;
        const failed = /!!Code threw exception!!|Error:|failed|unable to|not found|Code generation failed|Error generating code|Could not find|cannot find|no path|timed out/i.test(String(result ?? ''));
        if (failed) { this.plan.failures++; this.plan.note = clip(result, 700); }
        else if (!command.startsWith('!plan')) this.plan.failures = 0;
        if (this.plan.failures >= 3) this.pause('连续三次执行失败。请检查条件、修改任务后继续。', 'blocked');
        else this.refresh();
    }
    summary() {
        if (!this.plan) return '目前没有任务计划。';
        const names = { active: '执行中', paused: '已暂停', blocked: '受阻', completed: '已结束', cancelled: '已取消' };
        return `计划：${this.plan.goal}\n状态：${names[this.plan.status] ?? this.plan.status}\n` +
            this.plan.steps.map(s => `${s.status === 'done' ? '✓' : s === this.current() ? '→' : '○'} ${s.id} ${s.title} [${s.execution}]`).join('\n') +
            (this.plan.note ? `\n说明：${this.plan.note}` : '');
    }
    context() {
        return `\nPERSISTENT TASK PLAN (authoritative progress, separate from chat memory):\n${JSON.stringify(this.plan)}\n` +
            'Execute only the first unfinished step whose dependencies are satisfied. Check its preconditions before acting. Prefer existing commands and combinations of them. Do not invent player names/coordinates. Use exact observed names.\n' +
            'Inventory, position, near_player and block criteria are checked by the program. For manual criteria use !finishStep("specific observed evidence"); these remain model-reported. Use !blockStep when prerequisites cannot be obtained.\n' +
            'Use !requestCode("specific missing capability") only when existing commands cannot express the operation, not merely after a typo/pathfinding/material error. If the current step already has execution=code and code_reason, call !newAction directly without repeating !requestCode. Then !newAction may compose existing helpers and direct Mineflayer APIs. Never claim generated code is a learned reusable skill.\n' +
            'Do not use !goal/!endGoal; the plan scheduler continues automatically. If a plan is paused/blocked/cancelled, do not execute it until the user resumes or replaces it. Reply in Chinese unless requested otherwise.\n';
    }
    async prepare(owner, message, docs) {
        const epoch = this.epoch;
        const bot = this.agent.bot;
        const inventory = Object.fromEntries((bot.inventory?.items() ?? []).map(x => [x.name, 0]));
        for (const item of bot.inventory?.items() ?? []) inventory[item.name] += item.count;
        const snapshot = { position: bot.entity?.position, inventory, players: Object.keys(bot.players ?? {}), health: bot.health, food: bot.food };
        const prompt = `You are the task planner for a Minecraft assistant. Output ONLY one JSON object, no commands or code fences.
Classify the latest HUMAN message as intent task/chat/continue/pause/cancel/status/clarify. A request to perform gameplay is task even if only one step. A pure question or greeting is chat. Resume the existing plan for continue. For a modification to an existing goal, task must produce a revised plan grounded in CURRENT state. If an essential location/design/target is unknown, clarify with one question; use modest stated defaults for nonessential details. Never invent the player's location or materials.
Schema: {"intent":"task","reply":"short Chinese plan explanation and assumptions","goal":"...","steps":[{"id":"s1","title":"...","depends_on":[],"preconditions":["..."],"success":{"type":"inventory","item":"oak_log","count":4},"execution":"skill","code_reason":""}]}
For non-task intents only intent/reply are required. Use 1-12 ordered steps. IDs unique, dependencies only earlier IDs. Each step must have a verifiable outcome, not merely 'try'. Include gathering/crafting prerequisites when absent. Completion inventory counts are totals, not deltas; account for materials consumed by later steps.
Allowed success types: inventory {item,count positive integer}; position {x,y,z,radius 0<radius<=32}; near_player {player EXACT name,radius}; block {x,y,z,block exact name}; manual {description: specific observable criterion}. Prefer machine-checkable criteria. Use manual only when others cannot express it.
execution is skill by default. code is allowed only for a genuine missing capability such as geometric batch placement/conditional custom interaction, with a specific code_reason explaining why available commands/command sequences cannot express it. Do not choose code merely for missing materials, name mismatch or failed pathfinding.
COMMANDS:\n${docs}\nCURRENT_STATE:\n${JSON.stringify(snapshot)}\nEXISTING_PLAN:\n${JSON.stringify(this.plan)}\nRECENT_CHAT:\n${JSON.stringify(this.agent.history.getHistory().slice(-6))}`;
        await this.agent.prompter.checkCooldown?.();
        const response = await this.agent.prompter.chat_model.sendRequest([{role: 'user', content: `${owner}: ${message}`}], prompt);
        if (epoch !== this.epoch) return { handled: true, reply: '计划请求已被停止指令中断。' };
        const data = parsePlanResponse(response);
        mkdirSync(path.join(this.directory, 'plans'), {recursive:true});
        writeFileSync(path.join(this.directory, 'plans', `${Date.now()}-proposal.json`), JSON.stringify({owner, message, snapshot, response:data}, null, 2));
        if (data.intent === 'chat') return { handled: false };
        if (data.intent === 'status') return { handled: true, reply: this.summary() };
        if (data.intent === 'clarify') { this.pause('等待补充任务信息'); return { handled: true, reply: clip(data.reply) }; }
        if (data.intent === 'pause' || data.intent === 'cancel') {
            this.pause(data.reply || 'User request', data.intent === 'cancel' ? 'cancelled' : 'paused');
            await this.agent.actions.stop();
            return { handled: true, reply: this.summary() };
        }
        if (data.intent === 'continue') return { handled: true, reply: this.resume() };
        await this.agent.self_prompter.stop(false);
        await this.agent.actions.stop();
        this.install(data, owner);
        return { handled: true, reply: `${clip(data.reply)}\n${this.summary()}` };
    }
    schedule() {
        if (this.timer || this.busy || !this.active()) return;
        this.timer = setTimeout(async () => {
            this.timer = null;
            if (!this.active() || this.busy) { this.schedule(); return; }
            try {
                if (this.plan.decisions >= 40) {
                    this.pause('已达到本轮 40 次决策上限。检查进度后可说“继续任务”。');
                    this.agent.openChat(this.summary()); return;
                }
                this.plan.decisions++; this.save();
                const used = await this.agent.handleMessage('system', 'Continue the active persistent task plan. Execute one appropriate command or explicitly block the step.');
                this.stalls = used ? 0 : this.stalls + 1;
                if (this.stalls >= 3 && this.active()) {
                    this.pause('连续三轮未执行指令，请检查计划或补充信息。', 'blocked');
                    this.agent.openChat(this.summary());
                }
            } catch {
                this.pause('任务执行出现异常，已保留进度。请检查日志后继续。', 'blocked');
                this.agent.openChat(this.summary());
            } finally { this.schedule(); }
        }, 1500);
        this.timer.unref?.();
    }
}
