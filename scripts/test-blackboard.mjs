import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { TEAM_PRESETS, validateTeamSpec, actionAllowed } from '../src/building/team-state.js';
import { createTeamClient } from '../src/building/team-client.js';
import { createBuildingTools } from '../src/building/tools.js';
import { createBuildingLoop, createDecisionRequest } from '../src/building/loop-agent.js';
import { decisionInstructions } from '../src/building/decision-context.js';
import { createBlackboardBlueprintDesigner } from '../src/building/blueprint-blackboard.js';
import { createProgressTracker } from '../src/building/progress.js';

const spec=TEAM_PRESETS.blackboard();
const shape=(n=2)=>[{kind:'box',part:'floor',min:[0,0,0],max:[n-1,0,0],block:'stone'}];
const draft=(n=2)=>({origin:[0,0,0],shapes:shape(n),summary:'石头平台',coverage:[{requirementId:'goal',evidence:'按要求铺设石头平台'}]});
function fixture(config=spec,path=':memory:',open=true){
 const runtime=createTeamRuntime({spec:config,path});
 const sessions=Object.fromEntries(Object.keys(config.agents).map(n=>[n,runtime.connect(n)]));
 const requests=[];
 const call=(name,method,args={})=>{requests.push({name,method});return runtime.request(name,sessions[name],method,args)};
 for(const name of Object.keys(config.agents))call(name,'heartbeat',{status:'idle',canAcceptTask:true});
 if(open)call(config.entryAgent,'open_run',{id:'run',request:'建造两格石头平台',owner:'tester',origin:[0,0,0],dimension:'overworld'});
 return {runtime,sessions,call,requests};
}
assert(validateTeamSpec(spec).ok);
assert.deepEqual(Object.keys(spec.agents),['designer1','designer2','designer3','designer4','designer5','builder']);
assert.equal(spec.edges.length,0);
const disabled=structuredClone(spec);disabled.modules.blackboard.enabled=false;
assert(validateTeamSpec(disabled).ok,'users can disable the resource without a preset-name gate');
assert(!actionAllowed(disabled,'designer1','read_blackboard').allowed);
assert(!actionAllowed(TEAM_PRESETS.centralized(),'lead','blueprint_blackboard').allowed);
const wildcard=TEAM_PRESETS.centralized();wildcard.modules={blackboard:{enabled:true}};
assert(!actionAllowed(wildcard,'lead','blueprint_blackboard').allowed,'wildcard does not silently grant new tools');
const jobView={events:[],plan:{steps:[]},teamCoordination:true};
{
 const track=createProgressTracker({plan:{steps:[]},teamContext:{blackboard:{}},events:[]},{snapshot:()=>({})});
 const lease={status:'claimed',partId:'part-1',blueprintVersion:1,owner:'builder',token:'lease',expiresAt:1};
 assert(track({name:'claim_part'},lease).progressed,'first ownership acquisition enables construction');
 assert(!track({name:'claim_part'},{...lease,expiresAt:2}).progressed,'renewals do not manufacture progress');
}
assert(!decisionInstructions(jobView,{runtime:true,self:'designer1',spec:()=>disabled},'designer1').nativeFunctions.some(f=>f.name==='read_blackboard'));
assert(!decisionInstructions({events:[],plan:{steps:[]}},null,'solo').nativeFunctions.some(f=>['read_blackboard','write_blackboard','wait_for_blackboard','blueprint_blackboard'].includes(f.name)), 'solo agents never see optional resource tools');
assert(decisionInstructions(jobView,{runtime:true,self:'designer1',spec:()=>spec},'designer1').nativeFunctions.some(f=>f.name==='blueprint_blackboard'));
assert(decisionInstructions(jobView,{runtime:true,self:'designer1',spec:()=>spec},'designer1').nativeFunctions.some(f=>f.name==='list_materials'));

// Regression for the live deadlock: real decision contexts must not tell an
// authorized designer to wait for construction work or prohibit shared writes.
{
 const job={request:'三层金字塔',origin:[0,0,0],events:[],messages:[],placed:{},removed:{},plan:{requirements:[],steps:[]},
  teamCoordination:true,teamContext:{blackboard:{revision:0,currentDraft:null}}};
 const request=createDecisionRequest(job,{}, {},'designer1',{runtime:true,self:'designer1',spec:()=>spec});
 const context=JSON.parse(request.turns[0].content);
 assert.equal(context.blueprintTool,'blueprint_blackboard');
 assert(!context.nextStep.includes('no writes'));
 assert(!request.nativeInstructions.includes('Wait for a runtime task before planning'));
 assert(!request.nativeInstructions.includes('To enqueue independent tasks'));
 assert(request.nativeInstructions.includes(spec.agents.designer1.instructions));
 assert(request.nativeFunctions.find(f=>f.name==='blueprint_blackboard').description.includes('without a construction task'));
 const ordinary=decisionInstructions(jobView,{runtime:true,self:'arch_2',spec:()=>TEAM_PRESETS.peers()},'arch_2');
 assert(ordinary.nativeInstructions.includes('Wait for a runtime task before planning'),'ordinary coordination remains unchanged');
 job.teamCoordination=false;job.plan.steps=[{id:'build',title:'建造',success:'核验通过'}];
 const builder=createDecisionRequest(job,{}, {},'builder',{runtime:true,self:'builder',spec:()=>spec});
 assert(JSON.parse(builder.turns[0].content).nextStep.includes('review conditions'));
 // Exactly the live end-state: zero remaining cells but the acceptance plan
 // step is still running. Hints must advance through inspection/plan/finish.
 job.assignment={blueprint:{bounds:{min:[0,0,0],max:[1,0,0]},blocks:[{pos:[0,0,0],block:'stone'},{pos:[1,0,0],block:'stone'}]}};
 job.assignmentVersion=1;job.checklist={assignmentVersion:1,remainingCells:0,totalParts:1,verifiedParts:1};
 const view=()=>JSON.parse(createDecisionRequest(job,{}, {},'builder',{runtime:true,self:'builder',spec:()=>spec}).turns[0].content);
 assert(view().nextStep.includes('inspect_build once'),'fresh full inspection precedes closing');
 job.lastInspection={status:'completed',total:2,verified:2,differences:[],assignmentVersion:1};
 assert(view().nextStep.includes('Next use update_plan'),'an unfinished acceptance step needs an evidence update');
 assert.equal(job.plan.steps[0].status,undefined,'hints never silently mark a plan done');
 job.plan.steps[0]={...job.plan.steps[0],status:'done',evidence:'现场两格核验通过'};
 assert(view().nextStep.includes('next action is finish'));
 job.lastInspection.assignmentVersion=0;
 assert(view().nextStep.includes('inspect_build once'),'old-version inspection is not completion evidence');
 job.lastInspection.assignmentVersion=1;job.lastInspection.differences=[{pos:[0,0,0],actual:'air'}];
 assert(!view().nextStep.includes('next action is finish'),'a difference still prevents finish guidance');
 job.lastInspection.differences=[];
 job.teamContext.blackboard.revisionRequest={reason:'待返修'};
 assert(!view().nextStep.includes('next action is finish'),'pending design revision prevents closing');
}

// The independent drafting request validates and repairs geometry itself. Air
// clearances use the compiler's opening shape, never an invalid air material.
{
 let attempts=0;
 const design=createBlackboardBlueprintDesigner({async sendRequest(turns,prompt,_unused,options){
  assert.equal(options.purpose,'blueprint_blackboard');
  assert(prompt.includes('kind:"opening"'));
  return ++attempts===1 ? 'invalid JSON' : JSON.stringify({...draft(),shapes:[...shape(),{kind:'opening',min:[0,1,0],max:[0,1,0]}]});
 }});
 const generated=await design({origin:[0,0,0],run:{origin:[0,0,0],spec:{}},ORIGINAL_GOAL:'两格平台',protectedCells:{}});
 assert.equal(attempts,2);assert.equal(generated.blueprint.blocks.length,2);
}

// Atomic versions, non-message resource access, immutable artifacts and persistence.
const dir=await mkdtemp(join(tmpdir(),'mindcraft-blackboard-'));
try{
 const f=fixture(spec,join(dir,'runtime.sqlite'));
 try{
  assert(f.call('designer1','inbox').some(e=>e.kind==='blackboard_update'&&!e.payload.text),'startup has only a resource notification');
  assert.throws(()=>f.call('designer1','message',{runId:'run',recipient:'designer2',text:'private'}),/权限|连线/);
  const written=f.call('designer1','blackboard_write',{runId:'run',key:'observation/site',content:'平坦地面'});
  assert.equal(written.revision,1);
  assert.equal(f.call('designer2','blackboard_read',{runId:'run'}).entries[0].content,'平坦地面');
  assert.throws(()=>f.call('designer2','blackboard_write',{runId:'run',key:'observation/site',content:'覆盖旧结果',expectedRevision:0}),/版本冲突/);
  assert.equal(f.call('designer1','blackboard_write',{runId:'run',key:'observation/site',content:'平坦地面'}).status,'unchanged');
  assert.throws(()=>f.call('designer1','blackboard_write',{runId:'run',key:'system/fake',content:'fake'}),/运行时/);
  const saved=f.call('designer1','blackboard_save_draft',{runId:'run',baseDraftId:null,draft:draft()});
  assert(!f.runtime.snapshot().runs[0].assignment,'a draft is not a construction assignment');
  assert.throws(()=>f.call('designer2','blackboard_save_draft',{runId:'run',baseDraftId:null,draft:draft(3)}),/版本冲突/);
  const revised=f.call('designer2','blackboard_save_draft',{runId:'run',baseDraftId:saved.draftId,draft:draft(3)});
  assert.equal(f.call('designer3','blackboard_read',{runId:'run',draftId:saved.draftId}).draft.shapes[0].max[0],1,'old artifact remains unchanged');
  assert.throws(()=>f.call('builder','blackboard_publish',{runId:'run',draftId:saved.draftId,previousVersion:0}),/版本冲突/);
  assert.throws(()=>f.call('designer3','blackboard_publish',{runId:'run',draftId:revised.draftId,previousVersion:0}),/入口/);
  assert.throws(()=>f.call('designer1','blackboard_read',{runId:'another'}),/不存在/);
  const revision=f.call('designer1','blackboard_read',{runId:'run'}).revision;
  assert.equal(f.call('designer1','blackboard_wait',{runId:'run',sinceRevision:revision}).status,'waiting_blackboard');
  f.call('designer2','blackboard_write',{runId:'run',key:'review/'+revised.draftId+'/designer2',content:'approve=true'});
  assert.equal(f.call('designer1','blackboard_wait',{runId:'run',sinceRevision:revision}).status,'changed');
 }finally{f.runtime.close()}
 const restored=fixture(spec,join(dir,'runtime.sqlite'),false);
 try{assert.equal(restored.call('designer1','blackboard_read',{runId:'run'}).entries.find(e=>e.key==='observation/site').content,'平坦地面')}
 finally{restored.runtime.close()}
}finally{await rm(dir,{recursive:true,force:true})}

// Exact-artifact publication, live conflict checks and pause/revise/resume with built cells.
{
 const f=fixture();
 const blocks=new Map();
 const world={snapshot:()=>({dimension:'overworld',position:[0,2,2],gameMode:'creative'}),read:p=>blocks.get(p.join(','))??(p[1]<0?'stone':'air'),async prepare(){},async place(cell){blocks.set(cell.pos.join(','),cell.block);return 'placed'}};
 const job={id:'builder-job',teamRunId:'run',assignmentVersion:0,origin:[0,0,0],dimension:'overworld',owner:'tester',placed:{},removed:{},plan:{requirements:[{id:'goal',description:'建造两格石头平台'}],steps:[{id:'build',title:'施工平台',success:'现场核验'}]},events:[]};
 const team={runtime:true,self:'builder',spec:()=>spec,blackboard:(j,op,args)=>f.call('builder','blackboard_'+op,{runId:j.teamRunId,blueprintVersion:j.assignmentVersion,...args}),
  assertWrite:(j,partId,positions)=>f.call('builder','assert_write',{runId:'run',blueprintVersion:j.assignmentVersion,partId,positions}),
  queryClaims:()=>f.call('builder','claims',{runId:'run'}),claim:(partId,v)=>f.call('builder','claim',{runId:'run',blueprintVersion:v,partId})};
 const tools=createBuildingTools({world,job,team,checkpoint:async()=>{}});
 try{
  const d=f.call('designer1','blackboard_save_draft',{runId:'run',draft:draft(),baseDraftId:null});
  const read=await tools.call('read_blackboard',{draftId:d.draftId,limit:1});
  assert.equal(read.draft.readProgress.complete,true);
  assert.equal(job.blackboardDraftReads[d.draftId].indices.length,1);
  await tools.call('read_blackboard',{draftId:d.draftId,limit:1});
  assert.equal(job.blackboardDraftReads[d.draftId].indices.length,1,'reading the same shape does not inflate coverage');
  blocks.set('0,0,0','dirt');
  await assert.rejects(tools.call('blueprint_blackboard',{operation:'publish',draftId:d.draftId}),/冲突/);
  blocks.delete('0,0,0');
  await tools.call('blueprint_blackboard',{operation:'publish',draftId:d.draftId});
  assert.deepEqual(job.assignment.blueprint.blocks.map(c=>c.pos),[[0,0,0],[1,0,0]]);
  const version=job.assignmentVersion;
  await tools.call('blueprint_blackboard',{operation:'publish',draftId:d.draftId});
  assert.equal(job.assignmentVersion,version,'retry does not republish');
  // A runtime commit can succeed just before a job checkpoint is interrupted.
  // Republishing the exact artifact must rehydrate that local job, not strand it.
  job.assignment=null;job.assignmentVersion=0;
  await tools.call('blueprint_blackboard',{operation:'publish',draftId:d.draftId});
  assert.equal(job.assignmentVersion,version);assert.equal(job.assignment.blueprint.blocks.length,2);
  await team.claim('part-1',version);
  await tools.call('place_block',{position:[0,0,0],block:'stone',partId:'part-1',assignmentVersion:version});
  await tools.call('blueprint_blackboard',{operation:'request_revision',brief:'增加一格平台，保留首格'});
  assert.equal(f.call('builder','claims',{runId:'run'}).leases.length,0);
  assert.deepEqual(f.call('designer1','blackboard_read',{runId:'run'}).protected.cells,[{pos:[0,0,0],block:'stone'}]);
  assert.throws(()=>f.call('builder','assert_write',{runId:'run',blueprintVersion:version,partId:'part-1',positions:[[1,0,0]]}),/返修/);
  assert.throws(()=>f.call('builder','finish_run',{runId:'run'}),/返修/);
  const bad=draft();bad.shapes[0].min=[1,0,0];
  assert.throws(()=>f.call('designer2','blackboard_save_draft',{runId:'run',draft:bad,baseDraftId:d.draftId}),/保留/);
  const fixed=f.call('designer2','blackboard_save_draft',{runId:'run',draft:draft(3),baseDraftId:d.draftId});
  await tools.call('blueprint_blackboard',{operation:'publish',draftId:fixed.draftId});
  assert.equal(job.assignmentVersion,version+1);
  assert.equal(blocks.get('0,0,0'),'stone');assert.equal(job.placed['0,0,0'],'stone');
  assert.equal(tools.refreshChecklist().remainingCells,2,'resume from actual partial work');
 }finally{f.runtime.close()}
}

// An entry polling for peer reviews must wait rather than fail the entire run.
{
 const f=fixture(spec,':memory:',false),channel=new EventEmitter();channel.connected=true;
 channel.send=(message,callback)=>{let response;try{response={result:f.call('builder',message.method,message.args)}}catch(e){response={error:e.message}}queueMicrotask(()=>channel.emit('message',{type:'team_response',id:message.id,...response}));callback?.()};
 const team=createTeamClient({name:'builder',spec,channel});
 let requests=0;
 const model={async sendRequest(turns){
  const c=JSON.parse(turns[0].content);assert(++requests<=8,'polling must be suspended promptly');
  return JSON.stringify(c.plan.steps.length ? {action:'tool',name:'read_blackboard',args:{}} : {action:'update_plan',steps:[{id:'build',title:'施工',success:'核验'}]});
 }};
 const world={snapshot:()=>({dimension:'overworld',position:[0,0,0]}),read:()=> 'air'};
 const controller=createBuildingLoop({world,model,team,agentName:'builder',save:async()=>{},sendMessage:async()=>{}});team.attach(controller);
 try{
  const result=await controller.start({request:'测试审查等待',owner:'tester',origin:[0,0,0],dimension:'overworld'});
  assert.equal(result.status,'waiting_team');assert.equal(f.runtime.snapshot().runs[0].status,'active');
 }finally{team.close();await controller.stop('paused');f.runtime.close()}
}

// Six real controllers/clients: fake models read, draft, review, wait and finish.
// The policy is in the model fixture, not in runtime approval-count logic.
{
 const f=fixture(spec,':memory:',false),clients=[],controllers=[],errors=[],results=[];
 const blocks=new Map();
 const world={snapshot:()=>({dimension:'overworld',position:[0,2,2],gameMode:'creative'}),read:p=>blocks.get(p.join(','))??(p[1]<0?'stone':'air'),async prepare(){},async place(cell){blocks.set(cell.pos.join(','),cell.block);return 'placed'}};
 for(const name of Object.keys(spec.agents)){
  const channel=new EventEmitter();channel.connected=true;
  channel.send=(message,callback)=>{let response;try{response={result:f.call(name,message.method,message.args)}}catch(error){response={error:error.message}}queueMicrotask(()=>channel.emit('message',{type:'team_response',id:message.id,...response}));callback?.()};
  const team=createTeamClient({name,spec,channel,onError:e=>errors.push(e)});clients.push(team);
  let board,claimed=false,inspected=false;
  const tool=(name,args={})=>({action:'tool',name,args});
  const model={modelName:'offline-blackboard-fixture',async sendRequest(turns,instructions){
   if(instructions.startsWith('Design a Minecraft blueprint draft.'))return JSON.stringify(draft());
   const c=JSON.parse(turns[0].content),last=c.recentEvents?.findLast(e=>e.kind==='feedback');
   if(last?.name==='read_blackboard')board=last.output;
   if(last?.name==='claim_part')claimed=true;
   if(last?.name==='inspect_build')inspected=true;
   let action;
   if(name!=='builder'){
    if(!board||c.blackboard?.revision>board.revision)action=tool('read_blackboard');
    else if(!board.currentDraft)action=name==='designer1'?tool('blueprint_blackboard',{operation:'draft'}):tool('wait_for_blackboard');
    else if(board.publishedDraftId===board.currentDraft.id&&!board.revisionRequest)action={action:'end_turn'};
    else if(!board.draft||board.draft.id!==board.currentDraft.id)action=tool('read_blackboard',{draftId:board.currentDraft.id});
    else if(!board.entries.some(e=>e.key==='review/'+board.currentDraft.id+'/'+name))action=tool('write_blackboard',{key:'review/'+board.currentDraft.id+'/'+name,content:JSON.stringify({draftId:board.currentDraft.id,approve:true,evidence:'已审阅完整几何，满足两格平台'})});
    else action=tool('wait_for_blackboard');
   }else if(!c.plan.steps.length)action={action:'update_plan',steps:[{id:'build',title:'施工验收平台',success:'两格石头匹配'}]};
   else if(!c.blueprint){
    if(!board||c.blackboard?.revision>board.revision)action=tool('read_blackboard');
    else if(board.currentDraft&&['designer1','designer2','designer3','designer4','designer5'].every(n=>board.entries.some(e=>e.key==='review/'+board.currentDraft.id+'/'+n&&JSON.parse(e.content).approve)))action=tool('blueprint_blackboard',{operation:'publish',draftId:board.currentDraft.id});
    else action=tool('wait_for_blackboard');
   }else if(c.constructionChecklist.remainingCells){
    action=!claimed?tool('claim_part',{partId:'part-1'}):tool('place_rectangle',{min:[0,0,0],max:[1,0,0],block:'stone',partId:'part-1',assignmentVersion:c.blueprint.version});
   }else if(!inspected){assert(c.nextStep.includes('inspect_build once'));action=tool('inspect_build');}
   else if(c.plan.steps.some(s=>s.status!=='done')){assert(c.nextStep.includes('Next use update_plan'));action={action:'update_plan',patch:true,steps:[{id:'build',status:'done',evidence:'现场两格核验通过'}]};}
   else {assert(c.nextStep.includes('next action is finish'));action={action:'finish',summary:'黑板协作完成',requirementReview:[{requirementId:'goal',satisfied:true,evidence:'两格平台现场核验通过'}]};}
   return JSON.stringify(action);
  }};
  const controller=createBuildingLoop({world,model,team,agentName:name,peers:team.peers,save:async()=>{},sendMessage:async()=>{},maxModelRequests:100,timeLimitMs:20000,report:(event,data)=>{if(event==='result')results.push({name,...data})}});
  controllers.push(controller);team.attach(controller);
 }
 try{
  controllers.at(-1).start({request:'建造两格石头平台',origin:[0,0,0],dimension:'overworld',owner:'tester'}).catch(e=>errors.push(e));
  const until=Date.now()+18000;
  while(!f.runtime.snapshot().runs.some(r=>r.status==='completed')){
   if(Date.now()>until)throw new Error('Real loop board flow timed out: '+JSON.stringify({errors:errors.map(e=>e.message),states:controllers.map(c=>c.status()),results}));
   await new Promise(r=>setTimeout(r,30));
  }
  assert.equal(blocks.size,2);
  const run=f.runtime.snapshot().runs[0];
  assert.equal(Object.keys(run.blackboard.entries).filter(k=>k.startsWith('review/')).length,5);
  assert(!f.requests.some(r=>r.method==='message'||r.method==='delegate'),'business exchange only uses shared resource');
  assert.equal(run.blueprintVersion,1);
  assert(results.some(r=>r.name==='builder'&&r.status==='completed'));
 }finally{for(const c of clients)c.close();for(const c of controllers)await c.stop('paused');f.runtime.close()}
}
console.log('Blackboard passed: optional permissions, shared-resource access, CAS/persistence, exact drafts, preserved-cell revisions, and six real agent loops without peer messaging.');
