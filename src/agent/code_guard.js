import { parse } from 'espree';

// Cooperative limits, not an OS security boundary. The live bot is still exposed.
export function instrumentCode(source) {
    if (source.length > 20000) throw new Error('Generated code exceeds 20000 characters');
    const prefix = '(async (bot) => {\n';
    const ast = parse(prefix + source + '\n})', {ecmaVersion: 2022, range: true});
    const edits = [];
    const add = (at, text) => edits.push({at: at - prefix.length, text});
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'Identifier' && node.name.startsWith('__mc')) throw new Error('Reserved guard identifier');
        if (node.type === 'ImportExpression') throw new Error('Dynamic imports are not allowed');
        if (['ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement'].includes(node.type)) {
            if (node.body.type === 'BlockStatement') add(node.body.range[0] + 1, '__mcGuard();');
            else {add(node.body.range[0], '{__mcGuard();'); add(node.body.range[1], '}');}
        }
        if (['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)) {
            if (node.body.type === 'BlockStatement') add(node.body.range[0] + 1, '__mcGuard();');
            else {add(node.body.range[0], '(__mcGuard(),'); add(node.body.range[1], ')');}
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === 'range') continue;
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') walk(value);
        }
    }
    // Walk user statements only, not the synthetic wrapper.
    ast.body[0].expression.body.body.forEach(walk);
    for (const edit of edits.sort((a,b) => b.at-a.at)) source = source.slice(0,edit.at) + edit.text + source.slice(edit.at);
    return '__mcGuard();\n' + source;
}

export function makeCodeGuard(bot, timeoutMs = 120000, limit = 100000) {
    let started = null, checks = 0;
    return () => {
        started ??= Date.now();
        if (bot.interrupt_code) throw new Error('Code interrupted');
        if (++checks > limit || Date.now()-started > timeoutMs) throw new Error('Code execution budget exceeded');
    };
}
