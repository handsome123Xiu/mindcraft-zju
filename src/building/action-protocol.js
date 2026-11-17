// One schema source for prompts and validation. Normalization only translates
// unambiguous envelopes; it never invents coordinates, materials or operations.
const string = { type: 'string', minLength: 1, maxLength: 1000 };
const integer = { type: 'integer' };
const vector = { type: 'array', items: integer, minItems: 3, maxItems: 3 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, maxItems = 128) => ({ type: 'array', items, maxItems });
const region = object({ min: vector, max: vector }, ['min', 'max']);
const paging = { offset: { ...integer, minimum: 0 }, limit: { ...integer, minimum: 1, maximum: 128 } };
const coordinateSpace = { enum: ['world', 'blueprint'] };
const placement = { block: string, coordinateSpace, preview: { type: 'boolean' }, partId: string,
    assignmentVersion: { ...integer, minimum: 1 } };
const removal = { expectedBlock: string, coordinateSpace, partId: string, assignmentVersion: { ...integer, minimum: 1 } };
const row = { start: vector, end: vector };
const rectangle = { min: vector, max: vector };
const cube = { origin: vector, size: { ...integer, minimum: 1, maximum: 32 } };
const taskScope = object({ region, positions: { ...array(vector, 4096), minItems: 1 } });

export const TOOL_SCHEMAS = Object.freeze({
    get_tool_help: object({ name: string }, ['name']),
    delegate_site: object({ recipient: string, origin: vector, region }, ['recipient', 'origin', 'region']),
    prepare_parallel_build: object({ axis: { enum: ['auto', 'x', 'z'] } }),
    delegate_task: object({ key: string, recipient: string, partIds: { ...array(string, 512), minItems: 1 },
        description: string, success: string, dependsOn: array(string, 200), scope: taskScope, coordinateSpace }, ['key', 'recipient', 'partIds', 'description', 'success']),
    propose_task_share: object({ key: string, recipient: string, partIds: { ...array(string, 512), minItems: 1 },
        scope: taskScope, coordinateSpace, description: string, success: string }, ['key', 'recipient', 'partIds', 'scope', 'description', 'success']),
    respond_task_share: object({ proposalId: string, accept: { type: 'boolean' } }, ['proposalId', 'accept']),
    commit_task_share: object({ proposalId: string }, ['proposalId']),
    list_tasks: object({}),
    reassign_task: object({ taskId: string, recipient: string }, ['taskId', 'recipient']),
    send_message: object({ text: string, recipient: string }, ['text']),
    broadcast: object({ text: string }, ['text']),
    list_peers: object({}),
    claim_part: object({ partId: string }, ['partId']),
    release_part: object({ partId: string }, ['partId']),
    query_claims: object({}),
    observe_environment: object({ region, blocks: array(string, 32), excludeBlocks: array(string, 32), ...paging }, ['region']),
    observe_cells: object({ positions: array(vector, 256), coordinateSpace }, ['positions']),
    inspect_block: object({ position: vector, coordinateSpace }, ['position']),
    look_at: object({ position: vector, coordinateSpace }, ['position']),
    move_to: object({ position: vector, coordinateSpace }, ['position']),
    fly_to: object({ position: vector, coordinateSpace }, ['position']),
    land_at: object({ position: vector, coordinateSpace }, ['position']),
    inspect_build: object({}),
    inspect_part: object({ partId: string, ...paging }, ['partId']),
    get_build_checklist: object({}),
    list_materials: object({ query: { type: 'string', maxLength: 100 }, ...paging }),
    inspect_blueprint: object({ block: string, layer: integer, ...paging }),
    set_demolition_target: object({ region, blocks: array(string, 32) }, ['region']),
    place_block: object({ position: vector, ...placement }, ['position', 'block']),
    place_row: object({ ...row, ...placement }, ['start', 'end', 'block']),
    place_rectangle: object({ ...rectangle, ...placement }, ['min', 'max', 'block']),
    place_cube: object({ ...cube, ...placement }, ['origin', 'size', 'block']),
    dig_block: object({ position: vector, ...removal }, ['position', 'expectedBlock']),
    dig_row: object({ ...row, ...removal }, ['start', 'end', 'expectedBlock']),
    dig_rectangle: object({ ...rectangle, ...removal }, ['min', 'max', 'expectedBlock']),
    dig_cube: object({ ...cube, ...removal }, ['origin', 'size', 'expectedBlock'])
});

const step = object({ id: string, title: { ...string, maxLength: 200 }, success: { ...string, maxLength: 500 },
    depends_on: array(string, 200), status: { enum: ['pending', 'running', 'done', 'blocked'] }, evidence: string }, ['id']);
// Empty evidence is valid for unfinished steps; updatePlan checks done evidence.
// title/success stay schema-optional because patch=true merges them from the
// stored step; validatePlanSubmission enforces them for full submissions.
// Empty evidence is valid for unfinished steps; updatePlan checks done evidence.
step.properties.evidence = { type: 'string', maxLength: 1000 };
export const ACTION_SCHEMAS = Object.freeze({
    complete_task: object({ action: { const: 'complete_task' }, summary: string }, ['action', 'summary']),
    // reason 可选：glm-low 曾三次原样重发 {"action":"wait_for_team"} 缺 reason
    // 触发熔断，把 454 格的施工任务连带取消。等待意图本身无歧义，无需仪式性字段。
    wait_for_team: object({ action: { const: 'wait_for_team' }, reason: { ...string, maxLength: 500 } }, ['action']),
    update_plan: object({ action: { const: 'update_plan' }, requirements: array(object({ id: string, description: string }, ['id', 'description']), 200),
        steps: { ...array(step, 200), minItems: 1 }, patch: { type: 'boolean' } }, ['action', 'steps']),
    tool: object({ action: { const: 'tool' }, name: { enum: Object.keys(TOOL_SCHEMAS) }, args: { type: 'object' } }, ['action', 'name', 'args']),
    batch: object({ action: { const: 'batch' }, description: { ...string, maxLength: 200 },
        steps: array(object({ name: { enum: [...Object.keys(TOOL_SCHEMAS), 'update_plan'] }, args: { type: 'object' } }, ['name']), 32) },
        ['action', 'steps']),
    skill: object({ action: { const: 'skill' }, name: { const: 'design_blueprint' },
        args: object({ brief: string, origin: vector }) }, ['action', 'name', 'args']),
    finish: object({ action: { const: 'finish' }, summary: string,
        requirementReview: array(object({ requirementId: string, satisfied: { type: 'boolean' }, evidence: string },
            ['requirementId', 'satisfied', 'evidence']), 200) }, ['action', 'summary', 'requirementReview']),
    blocked: object({ action: { const: 'blocked' }, reason: string }, ['action', 'reason']),
    end_turn: object({ action: { const: 'end_turn' } }, ['action']),
    wait_for_user: object({ action: { const: 'wait_for_user' }, reason: string }, ['action', 'reason'])
});

// Compact, schema-derived prompt signatures avoid repeating large JSON Schemas
// on every decision. The complete schemas above still validate every action.
export function describeSchema(schema) {
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.join('|');
    if (schema.type === 'object' && schema.properties) return Object.fromEntries(Object.entries(schema.properties)
        .map(([key, value]) => [key + ((schema.required ?? []).includes(key) ? '' : '?'), describeSchema(value)]));
    if (schema.type === 'array') {
        if (schema.minItems === 3 && schema.maxItems === 3 && schema.items.type === 'integer') return '[integer,integer,integer]';
        return { arrayOf: describeSchema(schema.items), maxItems: schema.maxItems };
    }
    return schema.type + (schema.minimum != null || schema.maximum != null ? `(${schema.minimum ?? ''}..${schema.maximum ?? ''})` : '');
}

export function protocolError(field, message, expected, code = 'INVALID_DECISION') {
    const error = new Error(`${field}: ${message}`);
    Object.assign(error, { code, field, expected });
    return error;
}

export function validateSchema(value, schema, path = '$', code = 'INVALID_DECISION') {
    const fail = message => { throw protocolError(path, message, schema, code); };
    if (schema.const !== undefined && value !== schema.const) fail('必须为 ' + JSON.stringify(schema.const));
    if (schema.enum && !schema.enum.includes(value)) fail('请选择 ' + schema.enum.join(' / '));
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('必须是对象');
        for (const key of schema.required ?? []) if (value[key] === undefined) {
            throw protocolError(path + '.' + key, '缺少必填字段', schema.properties[key], code);
        }
        for (const [key, entry] of Object.entries(value)) {
            if (schema.properties && Object.hasOwn(schema.properties, key)) validateSchema(entry, schema.properties[key], path + '.' + key, code);
            else if (schema.additionalProperties === false) throw protocolError(path + '.' + key, '未知字段', Object.keys(schema.properties), code);
        }
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value)) fail('必须是数组');
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('数组长度超出范围');
        value.forEach((entry, i) => validateSchema(entry, schema.items, `${path}[${i}]`, code));
    }
    if (schema.type === 'string' && (typeof value !== 'string' || value.trim().length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) fail('文本不能为空或超出长度限制');
    if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < (schema.minimum ?? -30000000) || value > (schema.maximum ?? 30000000))) fail('需要范围内的整数');
    if (schema.type === 'boolean' && typeof value !== 'boolean') fail('需要 true 或 false');
}

export function validateToolArgs(name, args) {
    if (!Object.hasOwn(TOOL_SCHEMAS, name)) throw protocolError('name',
        '未知 tool：' + name + '。可用 tool 只有：' + Object.keys(TOOL_SCHEMAS).join(', '), Object.keys(TOOL_SCHEMAS));
    validateSchema(args, TOOL_SCHEMAS[name], 'args', 'INVALID_ARGUMENT');
}

export function validateBatchStep(name, args) {
    if (name !== 'update_plan') return validateToolArgs(name, args);
    const schema = structuredClone(ACTION_SCHEMAS.update_plan);
    delete schema.properties.action;
    schema.required = schema.required.filter(field => field !== 'action');
    validateSchema(args, schema, 'args', 'INVALID_ARGUMENT');
    validatePlanSubmission(args);
}

// Full plan submissions must be complete at parse time. A missing title/success
// used to surface only at execution as INVALID_PLAN, which the protocol-failure
// counter ignored — logs show the same broken plan retried up to 9 times.
// patch=true steps merge their stored counterparts, so only id is required here;
// appended new IDs are checked against the stored plan inside updatePlan.
export function validatePlanSubmission(args) {
    if (args?.patch === true) return;
    (args?.steps ?? []).forEach((step, index) => {
        for (const field of ['title', 'success']) {
            const value = step?.[field];
            if (typeof value !== 'string' || !value.trim() || value.length > (field === 'title' ? 200 : 500))
                throw protocolError(`steps[${index}].${field}`,
                    '新步骤必须包含 ' + field + '；success 是可观察的完成标准，evidence 不能替代它',
                    { id: step?.id, title: '拆除并验收目标区域', success: '登记目标全部为空气', status: 'running' }, 'INVALID_ARGUMENT');
        }
    });
}

export function parseAction(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 24000) throw protocolError('$', '决策响应为空或超出长度限制', 'ONE JSON action object');
    let action;
    try { action = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')); }
    catch { throw protocolError('$', '只接受一个完整 JSON 对象，不能追加第二个动作', { action: 'tool', name: 'inspect_build', args: {} }); }
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw protocolError('$', '需要单个动作对象', Object.keys(ACTION_SCHEMAS));
    action = { ...action };
    // Ignore only known explanatory metadata, never executable arguments such
    // as hollow, region, material, or an extra action. Keep the raw audit answer.
    const stripMetadata = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const copy = { ...value };
        for (const key of ['note', 'notes', 'comment', 'explanation', 'reasoning']) {
            if (typeof copy[key] === 'string' || (Array.isArray(copy[key]) && copy[key].every(item => typeof item === 'string'))) delete copy[key];
        }
        return copy;
    };
    const alias = (target, canonical, alternatives) => {
        for (const key of alternatives) {
            if (!Object.hasOwn(target, key)) continue;
            if (Object.hasOwn(target, canonical)) throw protocolError(canonical, canonical + ' 与 ' + key + ' 不能同时出现', canonical);
            target[canonical] = target[key];
            delete target[key];
        }
    };
    action = stripMetadata(action);
    alias(action, 'action', ['type']);
    // 单键信封兜底：模型偶尔输出 {"update_plan":{...}}（函数名作顶层键、缺
    // action 字段，形似 native function calling）。仅当顶层恰好一个键且键名为
    // 已知 action 名时解包——语义完全确定；多键/未知键/数组体仍按原样报错。
    if (action.action === undefined) {
        const keys = Object.keys(action);
        if (keys.length === 1 && Object.hasOwn(ACTION_SCHEMAS, keys[0]) &&
            action[keys[0]] && typeof action[keys[0]] === 'object' && !Array.isArray(action[keys[0]])) {
            const { [keys[0]]: body } = action;
            action = { action: keys[0], ...body };
        }
    }
    alias(action, 'args', ['arguments', 'parameters']);
    if (Object.hasOwn(TOOL_SCHEMAS, action.action) || action.action === 'design_blueprint') {
        const { action: name, args, ...inline } = action;
        if (args !== undefined && Object.keys(inline).length) throw protocolError('args', '动作参数不能同时出现在 args 和顶层', 'args');
        action = { action: name === 'design_blueprint' ? 'skill' : 'tool', name, args: args === undefined ? inline : args };
    } else if (action.action === 'tool_call') {
        action.action = 'tool';
    }
    if (['tool', 'skill'].includes(action.action)) {
        alias(action, 'name', [action.action]);
        if (action.args === undefined) action.args = {};
        action.args = stripMetadata(action.args);
        if (action.action === 'tool' && !Object.hasOwn(TOOL_SCHEMAS, action.name)) throw protocolError('name',
            '未知 tool：' + action.name + '。可用 tool 只有：' + Object.keys(TOOL_SCHEMAS).join(', '), Object.keys(TOOL_SCHEMAS));
    }
    if (action.action === 'update_plan' && Array.isArray(action.steps)) action.steps = action.steps.map(stripMetadata);
    const schema = Object.hasOwn(ACTION_SCHEMAS, action.action) && ACTION_SCHEMAS[action.action];
    if (!schema) throw protocolError('action', '未知决策 action：' + String(action.action), Object.keys(ACTION_SCHEMAS));
    validateSchema(action, schema);
    if (action.action === 'update_plan') validatePlanSubmission(action);
    if (action.action === 'tool') validateToolArgs(action.name, action.args);
    // Validate the WHOLE batch before executing its first step. A malformed
    // later step must not leave earlier side effects behind.
    if (action.action === 'batch') action.steps.forEach((step, index) => {
        try { validateBatchStep(step.name, step.args ?? {}); }
        catch (error) { error.field = `steps[${index}].${error.field}`; throw error; }
    });
    return action;
}

export function decisionContract(actionNames, toolNames) {
    // Reuse identical leaf schemas instead of paying for the same coordinate
    // and text constraints in every tool. Validation still uses full schemas.
    const common = { Text: string, Position: vector, Region: region };
    const shared = new Map(Object.entries(common).map(([name, schema]) => [JSON.stringify(schema), name]));
    function compact(value, root = false) {
        if (!value || typeof value !== 'object') return value;
        const ref = !root && shared.get(JSON.stringify(value));
        if (ref) return { $ref: '#/$defs/' + ref };
        return Array.isArray(value) ? value.map(item => compact(item)) :
            Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
    }
    const variants = toolNames.map(name => ({ properties: { name: { const: name }, args: { $ref: '#/$defs/' + name } } }));
    const schemas = actionNames.map(name => {
        const schema = structuredClone(ACTION_SCHEMAS[name]);
        if (name === 'tool') { schema.properties.name.enum = toolNames; schema.oneOf = variants; }
        if (name === 'batch') {
            const plan = structuredClone(ACTION_SCHEMAS.update_plan);
            delete plan.properties.action;
            plan.required = plan.required.filter(field => field !== 'action');
            const canPlan = actionNames.includes('update_plan');
            schema.properties.steps.items.properties.name.enum = [...toolNames, ...(canPlan ? ['update_plan'] : [])];
            schema.properties.steps.items.oneOf = [...variants, ...(canPlan ? [{ properties: { name: { const: 'update_plan' }, args: plan } }] : [])];
        }
        return schema;
    });
    return { type: 'object', anyOf: schemas.map(schema => compact(schema)), $defs: {
        ...Object.fromEntries(Object.entries(common).map(([name, schema]) => [name, compact(schema, true)])),
        ...Object.fromEntries(toolNames.map(name => [name, compact(TOOL_SCHEMAS[name], true)]))
    } };
}
