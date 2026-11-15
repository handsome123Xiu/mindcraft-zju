import { ACTION_SCHEMAS, TOOL_SCHEMAS, parseAction, protocolError, validateSchema } from './action-protocol.js';

const descriptions = {
    observe_environment: 'Observe an explicit world-coordinate region chosen from the task footprint, height and current facts. region.min/max are required; no default scan. Expand or page when needed; unloaded/omitted cells are not air.',
    update_plan: 'Create/replace the complete step list with patch=false. patch=true updates existing IDs (title/success merge from the stored step) and appends submitted new IDs in order. New steps need id,title,success. Omit immutable requirements on progress updates.',
    design_blueprint: 'Design or revise after planning. Reuse sufficient observations/block inspections; choose extra reads only for missing or uncertain facts. Publication independently checks the actual site.',
    delegate_task: 'Queue a scoped construction task for a worker. Dispatch independent tasks before waiting. dependsOn uses returned task IDs.',
    inspect_part: 'Inspect your scoped part and get exact executable suggestions for missing cells.',
    get_tool_help: 'Retrieve exact usage for a tool and make it available in the next decision.',
    wait_for_team: 'Suspend requests until a team event. Call by itself, after dispatch results are known.',
    complete_task: 'Verify and complete your assigned task. All plan steps and helper tasks must be done. Call by itself.',
    finish: 'Verify the whole project and all requirements. Call by itself after all work and plan steps are done.',
    send_message: 'Send text to the user by default, or to an explicitly named permitted teammate.'
};

// The API sees individual flat functions, not a function containing a second
// tool protocol or a large discriminated union. Local execution stays canonical.
export function nativeFunctions(actionNames, toolNames) {
    const functions = toolNames.map(name => ({ type: 'function', name, description: descriptions[name] ?? name.replaceAll('_', ' '),
        parameters: TOOL_SCHEMAS[name] }));
    for (const action of actionNames) {
        if (['tool', 'batch'].includes(action)) continue;
        const name = action === 'skill' ? 'design_blueprint' : action;
        const schema = structuredClone(action === 'skill' ? ACTION_SCHEMAS.skill.properties.args : ACTION_SCHEMAS[action]);
        delete schema.properties.action;
        schema.required = (schema.required ?? []).filter(field => field !== 'action');
        functions.push({ type: 'function', name, description: descriptions[name] ?? name.replaceAll('_', ' '), parameters: schema });
    }
    return functions;
}

export function extractNativeActions(response, functions) {
    const calls = (response.output ?? []).filter(item => item.type === 'function_call');
    const rawResponse = JSON.stringify(calls.map(({ name, arguments: args }) => ({ name, arguments: args })));
    try {
        if (response.status && response.status !== 'completed') throw protocolError('$', '原生函数响应尚未完成', 'completed response');
        if (!calls.length || calls.length > 32 || (response.output ?? []).some(item => item.type === 'custom_tool_call')) {
            throw protocolError('$', '需要 1–32 个已提供的原生函数调用；文本不是函数调用', functions.map(fn => fn.name));
        }
        const actions = calls.map((call, index) => {
            const fn = functions.find(fn => fn.name === call.name);
            if (!fn) throw protocolError(`calls[${index}].name`, '当前角色或阶段没有此函数', functions.map(fn => fn.name));
            if (call.status && call.status !== 'completed') throw protocolError(`calls[${index}]`, '函数调用尚未完成', 'completed');
            let args;
            try { args = JSON.parse(call.arguments); }
            catch { throw protocolError(`calls[${index}].arguments`, '函数参数必须是一个完整 JSON 对象', fn.parameters); }
            validateSchema(args, fn.parameters, `calls[${index}].arguments`, 'INVALID_ARGUMENT');
            if (Object.hasOwn(TOOL_SCHEMAS, call.name)) return { action: 'tool', name: call.name, args };
            if (call.name === 'design_blueprint') return { action: 'skill', name: call.name, args };
            return { ...args, action: call.name };
        });
        let decision = actions[0];
        if (actions.length > 1) {
            if (actions.some(action => !['tool', 'update_plan'].includes(action.action))) {
                throw protocolError('$', '设计、等待、结束及验收函数必须单独调用；先读取本轮操作结果', 'One terminal/skill call OR ordered tool/update_plan calls');
            }
            decision = { action: 'batch', steps: actions.map(action => {
                if (action.action === 'tool') return { name: action.name, args: action.args };
                const { action: name, ...args } = action;
                return { name, args };
            }) };
        }
        // Validate the complete response before any member action can execute.
        return JSON.stringify(parseAction(JSON.stringify(decision)));
    } catch (error) { error.rawResponse = rawResponse; throw error; }
}
