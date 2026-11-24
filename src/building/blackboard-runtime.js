import { randomUUID } from 'node:crypto';
import { boardFor, boardDigest, putBoard, readBoard, blackboardPermission } from './blackboard.js';
import { checkedDraft } from './blueprint-blackboard.js';

export function handleBlackboardRequest({state,run,name,method,args,notify,now}) {
    const tool = method==='blackboard_read'||method==='blackboard_draft_context' ? 'read_blackboard' :
        method==='blackboard_write' ? 'write_blackboard' : method==='blackboard_wait' ? 'wait_for_blackboard' : 'blueprint_blackboard';
    if(!blackboardPermission(run.spec,name,tool)) throw new Error('黑板模块未启用或成员未显式获得 '+tool+' 权限');
    const changed=() => {
        for(const to of Object.keys(run.spec.agents)) if(to!==name&&blackboardPermission(run.spec,to,'read_blackboard'))
            notify(state,run,'blackboard',to,'blackboard_update',{revision:boardFor(run).revision,
                context:{owner:run.owner,origin:run.origin,dimension:run.dimension,request:run.request}});
    };
    const log=(key,content)=>{
        const result=putBoard(run,'system',{key,content,expectedRevision:boardFor(run).entries[key]?.revision??0},now());
        changed();return result;
    };
    if(method==='blackboard_read')return readBoard(run,args);
    if(method==='blackboard_wait')return {status:boardFor(run).revision>(args.sinceRevision??0)?'changed':'waiting_blackboard',revision:boardFor(run).revision};
    if(method==='blackboard_write'){
        if(args.key.startsWith('system/'))throw new Error('system/ 条目由运行时维护');
        const result=putBoard(run,name,args,now());
        if(result.status==='written')changed();
        return result;
    }
    if(method==='blackboard_draft_context')return {
        latest:run.blueprintDrafts?.latest??null,
        items:Object.fromEntries([...new Set([run.blueprintDrafts?.latest,args.draftId])].filter(id=>run.blueprintDrafts?.items?.[id]).map(id=>{
            const {blueprint,...item}=run.blueprintDrafts.items[id];return [id,item];
        })),publishedDraftId:run.publishedDraftId,
        run:{id:run.id,request:run.request,origin:run.origin,dimension:run.dimension,blueprintVersion:run.blueprintVersion,spec:{blockLimit:run.spec.blockLimit},
            blackboardProtected:run.blackboardProtected??{},designRevisionRequest:run.designRevisionRequest??null}};
    if(method==='blackboard_save_draft'){
        const draft=checkedDraft(args.draft,run);
        const drafts=run.blueprintDrafts??={items:{},latest:null};
        const before=drafts.items[drafts.latest];
        if(before?.author===name&&JSON.stringify(before.shapes)===JSON.stringify(draft.shapes)&&before.summary===draft.summary&&JSON.stringify(before.coverage)===JSON.stringify(draft.coverage))
            return {status:'unchanged',draftId:before.id,...boardDigest(run)};
        if((args.baseDraftId??null)!==drafts.latest)throw new Error('草稿版本冲突，请读取最新草稿后修订');
        if(Object.keys(drafts.items).length>=32)throw new Error('本轮草稿已达到 32 版上限，已保留全部版本，请报告未收敛问题');
        const id=randomUUID();drafts.items[id]={...draft,id,author:name,at:now(),baseDraftId:drafts.latest};drafts.latest=id;
        log('system/draft/'+id,JSON.stringify({draftId:id,baseDraftId:args.baseDraftId??null,author:name,summary:draft.summary,blocks:draft.blueprint.blocks.length}));
        return {status:'drafted',draftId:id,...boardDigest(run)};
    }
    if(name!==run.root)throw new Error('发布或申请施工返修需由工程入口执行；设计成员只编辑和审查草稿');
    const tasks=Object.values(state.tasks).filter(t=>t.runId===run.id&&!['completed','cancelled','superseded'].includes(t.status));
    if(tasks.length)throw new Error('请先结算现有施工子任务；黑板发布不能绕过任务范围');
    if(method==='blackboard_request_revision'){
        if(!run.assignment||args.blueprintVersion!==run.blueprintVersion)throw new Error('施工蓝图版本已变化');
        if(typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>1000)throw new Error('返修需填写具体原因');
        const existing=new Map(run.assignment.blueprint.blocks.map(c=>[c.pos.join(','),c.block]));
        for(const [key,block] of Object.entries(args.protectedCells??{}))if(existing.get(key)!==block||block==='air')throw new Error('保留坐标不属于当前蓝图');
        for(const [key,claim]of Object.entries(state.claims))if(claim.runId===run.id){
            if(claim.owner!==name)throw new Error('其他成员仍持施工租约');
            delete state.claims[key];
        }
        run.blackboardProtected={...(run.blackboardProtected??{}),...args.protectedCells};
        run.designRevisionRequest={version:run.blueprintVersion,reason:args.reason,at:now()};
        log('system/revision/'+run.blueprintVersion,JSON.stringify({...run.designRevisionRequest,preserved:Object.keys(run.blackboardProtected).length}));
        return {status:'revision_requested',...boardDigest(run)};
    }
    if(method==='blackboard_publish'){
        const draft=run.blueprintDrafts?.items?.[args.draftId];
        if(!draft)throw new Error('未知草稿');
        if(run.publishedDraftId===draft.id&&!run.designRevisionRequest)return {status:'unchanged',draftId:draft.id,assignmentVersion:run.blueprintVersion};
        if(draft.id!==run.blueprintDrafts.latest)throw new Error('草稿版本冲突：请重新读取并审查最新草稿');
        if(args.previousVersion!==run.blueprintVersion)throw new Error('施工蓝图版本已变化');
        if(run.designRevisionRequest&&run.publishedDraftId===draft.id)throw new Error('返修需要审查并发布新的草稿版本');
        if(Object.values(state.claims).some(c=>c.runId===run.id))throw new Error('请先释放施工租约，再发布草稿');
        const validated=checkedDraft(draft,run);
        run.assignment={version:1,dimension:run.dimension,blueprint:validated.blueprint};
        run.design={origin:validated.origin,summary:validated.summary,shapes:validated.shapes,coverage:validated.coverage};
        run.blueprintVersion++;run.publishedDraftId=draft.id;delete run.designRevisionRequest;
        log('system/published/'+run.blueprintVersion,JSON.stringify({draftId:draft.id,blueprintVersion:run.blueprintVersion,author:name}));
        return {status:'published',draftId:draft.id,assignmentVersion:run.blueprintVersion};
    }
    throw new Error('未知黑板操作');
}
