import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { createTeamClient } from '../src/building/team-client.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { TEAM_PRESETS } from '../src/building/team-state.js';

// Production loop/client/runtime; no model API or Minecraft. Reproduce a leader
// polling while two workers still have useful, independently writable work.
for (const preset of ['centralized','peers']) for (const mode of ['polling', 'queued', 'request-budget', 'time-budget', 'event-race', 'manual-pause', 'blocked-dependency', 'blocked-peer-running', 'recover-blocked', 'paused-recipient', 'unclaimed']) {
    const spec = TEAM_PRESETS[preset](['lead', 'a', 'b']);
    let clock = Date.now();
    const runtime = createTeamRuntime({ spec, now: () => clock, leaseMs: 60000, taskClaimTimeoutMs: 1000 });
    const sessions = Object.fromEntries(Object.keys(spec.agents).map(name => [name, runtime.connect(name)]));
    const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
    for (const name of ['a', 'b']) call(name, 'heartbeat', {
        status: mode === 'paused-recipient' ? 'paused' : 'idle', canAcceptTask: mode !== 'paused-recipient' });
    const assignment = { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
        { kind: 'point', part: 'a', at: [0,0,0], block: 'white_wool' },
        { kind: 'point', part: 'b', at: [2,0,0], block: 'pink_concrete' }
    ] }, [0,0,0]) };
    call('lead', 'open_run', { id: 'wait-run', request: 'two cakes', owner: 'tester', origin: [0,0,0], dimension: 'overworld' });
    call('lead', 'publish', { runId: 'wait-run', previousVersion: 0, assignment, design: { origin: [0,0,0] } });
    let first;
    for (const [i, name] of ['a', 'b'].entries()) {
        const delegated = call('lead', 'delegate', { runId: 'wait-run', blueprintVersion: 1, key: name, recipient: name,
            partIds: ['part-' + (i + 1)], description: 'cake', success: 'verified',
            dependsOn: mode === 'blocked-dependency' && first ? [first.taskId] : [] });
        first ??= delegated;
    }
    const queued = ['queued', 'paused-recipient', 'unclaimed'].includes(mode);
    const taken = queued ? [] : [call('a', 'take_task'), call('b', 'take_task')].filter(Boolean);
    const scope = task => ({ runId: 'wait-run', taskId: task.id, token: task.token, blueprintVersion: 1 });
    if (['blocked-dependency','blocked-peer-running','recover-blocked'].includes(mode)) {
        call('a', 'task_result', { ...scope(taken[0].task), status: 'blocked', summary: 'support unavailable' });
        call('a','heartbeat',{status:'blocked',canAcceptTask:true});
        if(mode==='recover-blocked')taken.shift();
    }
    const channel = new EventEmitter(); channel.connected = true;
    const errors = [];
    channel.send = (message, callback) => {
        try { const result = call('lead', message.method, message.args); queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, result })); callback?.(); }
        catch (error) { queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, error: error.message })); callback?.(); }
    };
    const client = createTeamClient({ name: 'lead', spec, channel, onError: error => errors.push(error.message) });
    const blocks = new Map();
    let requests = 0, hold = ['time-budget', 'manual-pause'].includes(mode), reachedModel;
    const modelStarted = new Promise(resolve => { reachedModel = resolve; });
    const plan = done => ({ steps: [{ id: 'build', title: 'build cakes', success: 'both verified', status: done ? 'done' : 'running', evidence: done ? 'both cells observed' : '' }] });
    let raced = false, alerted = false, controller;
    const eventPromises = [];
    const finishWorkers = () => {
        for (const item of taken) {
            const task = item.task, partId = task.partIds[0];
            const cells = assignment.blueprint.blocks.filter(cell => assignment.blueprint.parts.find(p => p.id === partId).positions.some(pos => pos.join() === cell.pos.join()));
            call(task.to, 'assert_write', { ...scope(task), partId, positions: cells.map(cell => cell.pos) });
            for (const cell of cells) blocks.set(cell.pos.join(), cell.block);
            call(task.to, 'task_result', { ...scope(task), status: 'completed', summary: 'verified', evidence: [{ partId, total: cells.length, remaining: 0 }] });
            call(task.to, 'heartbeat', { status: 'completed', canAcceptTask: true });
        }
    };
    const deliverEvents = () => {
        const events = call('lead', 'inbox');
        call('lead', 'ack', { ids: events.map(event => event.id) });
        for (const event of events) eventPromises.push(controller.receiveTeamEvent(event));
    };
    controller = createBuildingLoop({ team: client, agentName: 'lead',
        // Closing now explicitly exercises inspect -> plan evidence -> finish.
        maxModelRequests: mode === 'request-budget' ? 3 : 30,
        timeLimitMs: mode === 'time-budget' ? 80 : 5000,
        world: { snapshot: () => ({ dimension: 'overworld', position: [0,0,4], gameMode: 'creative' }),
            read: pos => blocks.get(pos.join()) ?? (pos[1] < 0 ? 'stone' : 'air') },
        async save(id, type, data) {
            if (mode === 'event-race' && type === 'state' && data.status === 'waiting_team' && !raced) {
                raced = true; finishWorkers(); deliverEvents();
            }
        },
        model: { async sendRequest(turns, instructions, stop, { signal }) {
            requests++; reachedModel();
            if (hold) {
                hold = false;
                await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            }
            const context = JSON.parse(turns[0].content);
            if(mode==='recover-blocked') {
                const task=context.team.recoveryTasks?.[0];
                if(task){
                    assert(context.nextStep.includes(task.id),'blocked recovery takes priority over a running peer');
                    if(requests===1)return JSON.stringify({action:'wait_for_team',reason:'another peer is running'});
                    assert(context.recentEvents.some(e=>e.output?.status==='recovery_required'),'waiting did not hide the blocker');
                    return JSON.stringify({action:'tool',name:'reassign_task',args:{taskId:task.id,recipient:'a'}});
                }
                if(context.team.tasks.some(t=>t.to==='a'&&t.status==='queued')){
                    taken.push(call('a','take_task'));finishWorkers();deliverEvents();
                }
            }
            if (alerted && context.team.tasks.some(task => task.claimStalled)) {
                assert(context.team.feed.some(item => item.text.includes('task_unclaimed')), 'lifecycle notice arrives via team.feed');
                // A new decision is made with an actionable task ID. Reassign
                // through the real tool; the fixture worker then claims it.
                const task = context.team.tasks.find(task => task.claimStalled);
                return JSON.stringify({ action: 'tool', name: 'reassign_task', args: { taskId: task.id, recipient: 'b' } });
            }
            if (alerted && context.team.tasks.some(task => task.to === 'b' && task.status === 'queued')) {
                const item = call('b', 'take_task');
                if (item) { taken.push(item); finishWorkers(); taken.length = 0; deliverEvents(); }
            }
            if (context.team.tasks.every(task => task.status === 'completed')) {
                if(!context.lastInspection || context.lastInspection.assignmentVersion!==context.blueprint.version){
                    assert(context.nextStep.includes('inspect_build once'),'completed workers lead to a fresh whole-project inspection');
                    return JSON.stringify({action:'tool',name:'inspect_build',args:{}});
                }
                if (context.plan.steps.some(step => step.status !== 'done')) {assert(context.nextStep.includes('Next use update_plan'));return JSON.stringify({ action: 'update_plan', ...plan(true) });}
                assert(context.nextStep.includes('next action is finish'),'completed central entry must submit finish, not poll again');
                return JSON.stringify({ action: 'finish', summary: 'cakes verified', requirementReview: [{ requirementId: 'goal', satisfied: true, evidence: 'both cells observed' }] });
            }
            return JSON.stringify({ action: 'tool', name: 'list_tasks', args: {} });
        } }
    });
    controller.restore({ version: 1, kind: 'building-loop', id: 'wait-run', teamRunId: 'wait-run', request: 'two cakes', owner: 'tester',
        origin: [0,0,0], dimension: 'overworld', status: 'paused', assignment, assignmentVersion: 1, design: { origin: [0,0,0] },
        placed: {}, removed: {}, events: [], plan: { requirements: [{ id: 'goal', description: 'two cakes' }], ...plan(false) },
        modelRequests: 0, decisions: 0, elapsedMs: 0, placementAttempts: 0, demolitionAttempts: 0, removalCount: 0 });
    try {
        const round = controller.resume();
        if (mode === 'manual-pause') { await modelStarted; await controller.stop('paused'); }
        const result = await round;
        if (mode === 'manual-pause') {
            assert.equal(result.status, 'paused'); assert.equal(runtime.snapshot().runs[0].paused, true);
            assert(runtime.snapshot().tasks.every(task => task.status === 'running'));
        } else if(['blocked-dependency','blocked-peer-running'].includes(mode)) {
            const waitUntil=async status=>{
                const deadline=Date.now()+2500;
                while(controller.status()!==status && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
                assert.equal(controller.status(),status,preset+': '+mode);
            };
            assert.equal(result.status,mode==='blocked-peer-running'?'waiting_team':'waiting_user');
            assert.equal(runtime.snapshot().runs[0].status,'active');
            if(mode==='blocked-peer-running') {
                taken.splice(0,taken.length,...taken.filter(item=>runtime.snapshot().tasks.find(t=>t.id===item.task.id).status==='running'));
                finishWorkers();taken.length=0;deliverEvents();
                await waitUntil('waiting_user');
            } else taken.length=0;
            assert(controller.snapshot().result.teamRecovery,'automatic recovery wait is distinct from a user question');
            const before=requests;
            call('a','message',{runId:'wait-run',blueprintVersion:1,recipient:'lead',text:'收到，保持待命，无需回复'});
            deliverEvents();await Promise.all(eventPromises);
            await new Promise(r=>setTimeout(r,25));
            assert.equal(requests,before,'acknowledgements do not wake a blocked recovery');
            assert(!runtime.snapshot().tasks.some(t=>t.status==='cancelled'));
            const blocked=runtime.snapshot().tasks.find(t=>t.status==='blocked');
            call('lead','reassign',{runId:'wait-run',blueprintVersion:1,taskId:blocked.id,recipient:'a'});
            deliverEvents();
            // Actual task changes wake the saved run; no user message is needed.
            await waitUntil('waiting_team');
            const restored=call('a','take_task');assert(restored);taken.push(restored);
            finishWorkers();taken.length=0;
            const dependent=call('b','take_task');if(dependent){taken.push(dependent);finishWorkers();taken.length=0;}
            deliverEvents();await Promise.all(eventPromises);
            await waitUntil('completed');
            assert.equal(runtime.snapshot().runs[0].status,'completed');
        } else if(mode==='recover-blocked') {
            assert.equal(result.status,'completed');assert.equal(runtime.snapshot().runs[0].status,'completed');
            assert.equal(runtime.snapshot().tasks.find(t=>t.key==='a').attempt,2);
        } else if (mode==='paused-recipient') {
            assert.equal(result.status, 'failed', 'a queue blocked on failed support must not wait forever');
        } else {
            assert.equal(result.status, 'waiting_team', mode + ': ' + result.reason);
            assert(result.roundModelRequests <= 5, 'repeated polling must suspend quickly');
            if (mode !== 'event-race') {
                assert.equal(runtime.snapshot().runs[0].status, 'active');
                assert(runtime.snapshot().tasks.every(task => task.status === (queued ? 'queued' : 'running')));
                const before = requests;
                await new Promise(resolve => setTimeout(resolve, 25));
                assert.equal(requests, before, 'waiting must make no model requests');
                if (mode === 'unclaimed') {
                    runtime.sweep(); clock += 1001; runtime.sweep();
                    assert.equal(call('lead', 'inbox').filter(event => event.kind === 'task_unclaimed').length, 2);
                    alerted = true;
                    deliverEvents();
                } else {
                    if (mode === 'queued') taken.push(call('a', 'take_task'), call('b', 'take_task'));
                    finishWorkers(); deliverEvents();
                }
            }
            await Promise.all(eventPromises);
            const deadline = Date.now() + 2000;
            while (controller.status() !== 'completed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
            assert.equal(controller.status(), 'completed', mode + ': task result must wake leader for final verification');
            assert.equal(runtime.snapshot().runs[0].status, 'completed');
            assert(runtime.snapshot().tasks.every(task => task.status === 'completed'));
            assert.equal(blocks.size, 2);
        }
        assert.deepEqual(errors, []);
    } finally { client.close(); runtime.close(); }
}
console.log('Coordinator waiting checks passed (centralized and peers): polling and budgets preserve worker leases, event-race wakeup, manual pause and blocked dependency handling.');
