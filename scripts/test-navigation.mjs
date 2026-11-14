import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vec3 from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { createWalkingNavigation } from '../src/building/navigation.js';

const { Vec3 } = vec3;
const { GoalBlock } = pathfinder.goals;
function fixture(options = {}) {
    const bot = new EventEmitter();
    const events = [];
    let stopped = 0;
    bot.entity = { position: new Vec3(0.5, 0, 0.5) };
    bot.clearControlStates = () => { stopped++; };
    bot.pathfinder = { setGoal() {}, goto: options.goto ?? (() => new Promise(() => {})) };
    const walk = createWalkingNavigation(bot, { timeoutMs: 150, stuckMs: 15, pollMs: 2,
        report: info => events.push(info), ...options });
    return { bot, walk, events, stopped: () => stopped };
}

// A bot pushing against a wall leaves goto() even if the plugin emits no event.
{
    const f = fixture();
    assert.equal(await f.walk(new GoalBlock(3, 0, 0)), false);
    assert.equal(f.events.at(-1).reason, 'walk_stuck');
    assert(f.stopped() > 0);
    assert.equal(f.bot.listenerCount('path_reset'), 0);
}

// Empty/no-path plugin resolutions cannot be mistaken for reaching the target.
{
    const f = fixture({ goto: async () => {} });
    assert.equal(await f.walk(new GoalBlock(3, 0, 0)), false);
    assert.equal(f.events.at(-1).reason, 'no_ground_path');
}

// Actual arrival must satisfy both the goal and the full-body collision check.
{
    const f = fixture();
    f.bot.pathfinder.goto = async () => { f.bot.entity.position.set(3.5, 0, 0.5); };
    assert.equal(await f.walk(new GoalBlock(3, 0, 0)), true);
    const blocked = fixture({ canOccupy: () => false });
    blocked.bot.pathfinder.goto = async () => { blocked.bot.entity.position.set(3.5, 0, 0.5); };
    assert.equal(await blocked.walk(new GoalBlock(3, 0, 0)), false);
}

// A plugin stuck reset exits immediately, and pauses cannot start a flight fallback.
{
    const f = fixture();
    f.bot.pathfinder.goto = () => { f.bot.emit('path_reset', 'stuck'); return new Promise(() => {}); };
    assert.equal(await f.walk(new GoalBlock(3, 0, 0)), false);
    assert.equal(f.events.at(-1).reason, 'walk_stuck');
    const abort = new AbortController();
    const cancelled = fixture({ report() { abort.abort(new Error('用户暂停')); } });
    let called = false;
    cancelled.bot.pathfinder.goto = async () => { called = true; };
    await assert.rejects(cancelled.walk(new GoalBlock(3, 0, 0), abort.signal), /用户暂停/);
    assert.equal(called, false);
    assert(cancelled.stopped() > 0);
    assert.equal(cancelled.bot.listenerCount('path_reset'), 0);
}

// Continuous motion cannot avoid the total walking deadline indefinitely.
{
    const f = fixture({ timeoutMs: 60, stuckMs: 40 });
    const moving = setInterval(() => { f.bot.entity.position.x += 0.2; }, 5);
    try {
        assert.equal(await f.walk(new GoalBlock(1000, 0, 0)), false);
        assert.equal(f.events.at(-1).reason, 'walk_timeout');
    } finally { clearInterval(moving); }
}

console.log('Walking navigation checks passed: stuck detection, hard deadline, actual arrival, collision checks and cancellation.');
