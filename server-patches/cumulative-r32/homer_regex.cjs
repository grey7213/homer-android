// Isolated JavaScript regex worker. No eval, network, filesystem, or logging of inputs.
'use strict';
function compile(pattern) {
    const text = String(pattern || '');
    if (!text) throw Error('empty-pattern');
    if (text.startsWith('/')) {
        for (let i = text.length - 1; i > 0; i--) {
            if (text[i] !== '/') continue;
            let n = 0; for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++;
            if (n % 2 === 0 && /^[dgimsuvy]*$/.test(text.slice(i + 1))) {
                return new RegExp(text.slice(1, i), text.slice(i + 1));
            }
        }
    }
    return new RegExp(text);
}
function macro(text, data, escape = false) {
    return String(text || '').replace(/\{\{(user|char)\}\}/gi, (_, key) => {
        const value = String(data[key.toLowerCase()] || '');
        return escape ? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : value;
    });
}
function run(data) {
    const errors = [];
    const rules = [...(data.scripts || [])].sort((a, b) => (a.order || 0) - (b.order || 0)).filter(r => !r.disabled);
    // Validate even if no message currently matches its placement/depth.
    const compiled = rules.map(r => {
        try { return compile(Number(r.substituteRegex) ? macro(r.findRegex, data, Number(r.substituteRegex) === 2) : r.findRegex); }
        catch { errors.push(String(r.id || 'unknown')); return null; }
    });
    const conversational = data.messages.filter(m => ['user', 'assistant'].includes(m.role));
    let position = 0;
    const messages = data.messages.map(m => {
        if (!['user', 'assistant'].includes(m.role)) return m;
        const depth = conversational.length - 1 - position++;
        let text = String(m.content || '');
        rules.forEach((r, i) => {
            if (!compiled[i] || (r.markdownOnly && !r.promptOnly)) return;
            if (!(r.placement || [2]).includes(m.role === 'user' ? 1 : 2)) return;
            if (r.minDepth != null && Number(r.minDepth) >= 0 && depth < Number(r.minDepth)) return;
            if (r.maxDepth != null && Number(r.maxDepth) >= 0 && depth > Number(r.maxDepth)) return;
            compiled[i].lastIndex = 0;
            text = text.replace(compiled[i], (...args) => {
                const named = typeof args.at(-1) === 'object' ? args.at(-1) : {};
                const captures = args.slice(0, typeof args.at(-1) === 'object' ? -3 : -2);
                // ST supports $n/$<name>/{{match}} with trimStrings applied to captures.
                const trim = value => (r.trimStrings || []).reduce((s, t) => s.split(macro(t, data)).join(''), String(value || ''));
                const replacement = String(r.replaceString || '').replace(/\{\{match\}\}/gi, '$0')
                    .replace(/\$(\d+)|\$<([^>]+)>/g, (_, n, name) => trim(name ? named[name] : captures[Number(n)]));
                return macro(replacement, data);
            });
            if (text.length > 240000) throw Error('regex-output-limit');
        });
        return { ...m, content: text };
    });
    return { messages, errors };
}
module.exports = { compile, run };
if (require.main === module) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => { input += data; if (input.length > 8000000) process.exit(2); });
    process.stdin.on('end', () => { try { process.stdout.write(JSON.stringify(run(JSON.parse(input)))); } catch { process.exitCode = 2; } });
}
