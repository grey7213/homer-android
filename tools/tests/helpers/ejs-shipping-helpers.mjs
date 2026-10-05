import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const require = createRequire(import.meta.url);
const acorn = require(resolve(root, 'sillytavern-runtime/node_modules/acorn'));

export function nodesOf(rootNode, predicate) {
    const result = [];
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (typeof node.type === 'string' && predicate(node)) result.push(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') walk(value);
        }
    }
    walk(rootNode);
    return result;
}

// Locate actual shipping expressions by their syntax and literal contract, not
// minifier variable/function names. No replacement implementation lives here.
export function extractShippingHelpers(bundle) {
    const ast = acorn.parse(bundle, { ecmaVersion: 'latest', sourceType: 'module' });
    const text = node => bundle.slice(node.start, node.end);
    const declarations = nodesOf(ast, node => node.type === 'FunctionDeclaration');
    const escape = declarations.find(node => text(node).includes('.replace(/%/g,') && text(node).includes('\\x25'));
    const wrapper = declarations.find(node => text(node).includes('"escape-ejs"')
        && text(node).includes('"thinking"') && text(node).includes('"reasoning"'));
    assert.ok(escape && wrapper, 'actual escape/reasoning helpers found');
    const wrap = nodesOf(wrapper, node => node.type === 'FunctionExpression'
        && text(node).includes('__append') && text(node).includes('.map('))[0];
    assert.ok(wrap, 'actual wrap helper found');
    const standalone = nodesOf(ast, node => node.type === 'FunctionExpression'
        && node.params.length === 1 && text(node).includes('/&lt;%|%&gt;/g') && text(node).includes('_.unescape'));
    const inline = nodesOf(ast, node => node.type === 'ConditionalExpression'
        && node.consequent.type === 'Identifier' && node.test.type === 'UnaryExpression'
        && text(node.test).includes('.includes("&lt;%")') && text(node.alternate).includes('_.unescape'));
    assert.equal(standalone.length + inline.length, 1, 'exact actual unescape expression found');
    const unescape = standalone[0] || inline[0];
    const split = nodesOf(standalone[0] || unescape.alternate, node => node.type === 'FunctionExpression'
        && node.params.length >= 2 && text(node).includes('"open"') && text(node).includes('"close"'))[0];
    assert.ok(split, 'actual generic split helper found');
    return {
        code: `${text(escape)}\n${text(wrapper)}\nglobalThis.testFunctions = {
            wrapEscapeBlocks: ${text(wrap)},
            escapeReasoningBlocks: ${wrapper.id.name},
            splitNested: ${text(split)},
            unescapeHtmlEntities: ${standalone[0] ? text(unescape) : `function(${unescape.consequent.name}) { return ${text(unescape)}; }`}
        };`,
        positions: { escape, wrapper, wrap, unescape, split },
    };
}
