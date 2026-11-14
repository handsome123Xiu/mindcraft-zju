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
const removal = { expectedBlock: string, coordinateSpace };
const row = { start: vector, end: vector };
const rectangle = { min: vector, max: vector };
const cube = { origin: vector, size: { ...integer, minimum: 1, maximum: 32 } };

export const TOOL_SCHEMAS = Object.freeze({
    send_message: object({ text: string, recipient: string }, ['text']),
    observe_environment: object({ region, blocks: array(string, 32), excludeBlocks: array(string, 32), ...paging }),
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
step.properties.evidence = { type: 'string', maxLength: 1000 };
export const ACTION_SCHEMAS = Object.freeze({
    update_plan: object({ action: { const: 'update_plan' }, requirements: array(object({ id: string, description: string }, ['id', 'description']), 200),
        steps: { ...array(step, 200), minItems: 1 }, patch: { type: 'boolean' } }, ['action', 'steps']),
    tool: object({ action: { const: 'tool' }, name: { enum: Object.keys(TOOL_SCHEMAS) }, args: { type: 'object' } }, ['action', 'name', 'args']),
    batch: object({ action: { const: 'batch' }, description: { ...string, maxLength: 200 },
        steps: array(object({ name: { enum: Object.keys(TOOL_SCHEMAS) }, args: { type: 'object' } }, ['name']), 32) },
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
    if (action.action === 'tool') validateToolArgs(action.name, action.args);
    return action;
}
