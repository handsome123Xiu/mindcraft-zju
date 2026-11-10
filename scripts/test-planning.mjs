import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setSettings } from '../src/agent/settings.js';
setSettings({minecraft_version:'1.21.6', code_timeout_mins:2});
const { TaskPlan, parsePlanResponse, checkCriterion } = await import('../src/agent/task_plan.js');
const { instrumentCode, makeCodeGuard } = await import('../src/agent/code_guard.js');
const { Coder } = await import('../src/agent/coder.js');
const { lockdown } = await import('../src/agent/library/lockdown.js');
const { Agent } = await import('../src/agent/agent.js');
const { Prompter } = await import('../src/models/prompter.js');

const directory = mkdtempSync(path.join(tmpdir(),'mindcraft-plan-test-'));
let inventory=[];
const bot={inventory:{items:()=>inventory}, entity:{position:{x:0,y:64,z:0}}, players:{}, blockAt:()=>({name:'stone'}), output:'', interrupt_code:false, modes:{pause:()=>{}}};
const agent={name:'planning-test', bot, history:{getHistory:()=>[]}, actions:{stop:async()=>{},cancelResume:()=>{},getBotOutputSummary:()=>bot.output}, self_prompter:{stop:async()=>{}}};
const data=()=>parsePlanResponse(JSON.stringify({intent:'task',goal:'Get wood and report',steps:[
 {id:'s1',title:'Get four logs',execution:'skill',success:{type:'inventory',item:'oak_log',count:4}},
 {id:'s2',title:'Report result',execution:'skill',success:{type:'manual',description:'Report observed count'}}]}));
try {
 const plan=new TaskPlan(agent,directory); agent.taskPlan=plan; plan.install(data(),'tester');
 assert.equal(plan.current().id,'s1'); assert.match(plan.finish('done'),/不能标记/);
 inventory=[{name:'oak_log',count:4}]; plan.refresh(); assert.equal(plan.current().id,'s2');
 assert.equal(plan.plan.steps[0].verification,'machine_verified');
 assert.match(plan.guard('!newAction'),/not approved/);
 plan.allowCode('Existing commands cannot compute the custom statistic requested by the player.'); assert.equal(plan.guard('!newAction'),null);
 assert.match(plan.guard('!goal'),/persistent/);
 plan.finish('Observed four oak logs in the actual inventory'); assert.equal(plan.plan.status,'completed');
 assert.equal(plan.plan.steps[1].verification,'model_reported');
 inventory=[]; plan.install(data(),'tester'); const reloaded=new TaskPlan(agent,directory); assert.equal(reloaded.plan.status,'paused');
 reloaded.resume(); for(let i=0;i<3;i++) reloaded.observe('!collectBlocks','Error: no path'); assert.equal(reloaded.plan.status,'blocked');
 assert.throws(()=>parsePlanResponse(JSON.stringify({intent:'task',goal:'bad',steps:[{...data().steps[0],depends_on:['missing']}]})),/Dependencies/);
 assert.equal(checkCriterion(bot,{type:'near_player',player:'missing',radius:2}).ok,false);
 assert.equal(checkCriterion(bot,{type:'position',x:1,y:64,z:0,radius:2}).ok,true);
 assert.equal(checkCriterion(bot,{type:'block',x:0,y:0,z:0,block:'stone'}).ok,true);
 let resolvePlan; agent.prompter={chat_model:{sendRequest:()=>new Promise(r=>resolvePlan=r)}};
 const pending=plan.prepare('tester','new task',''); await Promise.resolve(); plan.pause(); resolvePlan(JSON.stringify(data()));
 assert.equal((await pending).handled,true); assert.equal(plan.plan.status,'paused');
 // Live-message queue: stopping bypasses an in-flight LLM and invalidates queued system work.
 const qa=Object.create(Agent.prototype); qa.name='andy'; qa.taskPlan=plan; qa._messageQueue=Promise.resolve(); qa.actions=agent.actions; qa.self_prompter=agent.self_prompter; qa.routeResponse=async()=>{};
 let release, calls=0; qa._handleMessage=async()=>{calls++; await new Promise(r=>release=r);return true;};
 const old=qa.handleMessage('system','old decision'); await Promise.resolve();
 const queued=qa.handleMessage('system','stale queued decision'); await qa.handleMessage('tester','暂停'); release(); await old; await queued; assert.equal(calls,1);
 let apiCalls=0; const prompter=Object.create(Prompter.prototype); prompter.profile={coding:''}; prompter.checkCooldown=async()=>{}; prompter.replaceStrings=async()=>''; prompter.agent={}; prompter.code_model={sendRequest:async()=>{apiCalls++;throw new Error('test outage');}};
 await assert.rejects(prompter.promptCoding([]),/test outage/); assert.equal(prompter.awaiting_coding,false);
 await assert.rejects(prompter.promptCoding([]),/test outage/); assert.equal(apiCalls,2);
 console.log('PASS: criteria, dependencies, persistence, fallback gate, failure pause, stop/queue, API flag recovery');
 lockdown();
 const guard=makeCodeGuard(bot,120000,100);
 const run=code=>new Function('__mcGuard','bot',`return (async()=>{${instrumentCode(code)}})();`)(guard,bot);
 await run('let n=0; for(let i=0;i<3;i++) n++; if(n!==3) throw new Error("wrong");');
 await assert.rejects(run('while(true) {}'),/budget exceeded/);
 assert.throws(()=>instrumentCode('await import("fs");'),/imports/);
 assert.throws(()=>instrumentCode('const __mcGuard=()=>{};'),/Reserved/);
 agent.prompter={skill_libary:{getAllSkillDocs:async()=>[]},promptCoding:async()=> '```js\nawait Promise.resolve(); log(bot, "local code ok");\n```'};
 const coder=new Coder(agent); coder.fp=directory.replaceAll('\\','/')+'/';
 // _stageCode uses cwd-relative paths, so override the artifact writer for this unit test only.
 coder._writeFilePromise=async()=>{}; coder._audit=()=>{};
 const staged=await coder._stageCode('await Promise.resolve(); log(bot, "hello");'); await staged.func.main(bot); assert.match(bot.output,/hello/);
 await assert.rejects(coder._stageCode('await Promise.resolve(); process.exit(1);'),/not defined/);
 await assert.rejects(coder._stageCode('await Promise.resolve(); let n=0; while (true) { n++; }').then(s=>s.func.main(bot)),/budget exceeded/);
 bot.output=''; const result=await coder.generateCode(agent.history); assert.match(result,/local code ok/);
 console.log('PASS: SES execution, lint-before-evaluate, loop budget and actual Coder generation/execution');
} finally { rmSync(directory,{recursive:true,force:true}); }

