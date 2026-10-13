import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {deferRemoteFontStylesheets as defer} from '../../sillytavern-runtime/public/scripts/homer-async-fonts.mjs';
const doc=body=>'<!doctype html><html><head>'+body+'</head><body><button onclick="this.textContent=\'ready\'">Play</button></body></html>';
const url='https://fonts.googleapis.com/css2?family=Noto+Sans+SC&display=swap';
test('font href is deferred, not removed, and original link handlers/media are preserved',()=>{
    const source=doc('<link rel="stylesheet" href="'+url+'" media="screen" onload="window.fontReady=true">');
    const output=defer(source,true);
    assert.ok(output.includes('data-homer-font-href="'+url+'"'));
    assert.ok(output.includes('media="screen" onload="window.fontReady=true"'));
    assert.ok(output.includes('window.addEventListener("load"'));
    assert.ok(output.startsWith('<!doctype html>'));
    assert.equal(defer(output,true),output,'Idempotent: one loader per display document');
    assert.equal(defer(source,false),source,'Non-embedded behavior is byte-identical');
});
test('unqualified font CSS imports move without changing remaining author CSS or scripts',()=>{
    const source=doc('<style>@import url("'+url+'"); body{color:red}</style><script>const html=\'<link rel="stylesheet" href="'+url+'">\';</script>');
    const output=defer(source,true);
    assert.ok(output.includes('body{color:red}'));
    assert.ok(output.includes('<script>const html=\'<link rel="stylesheet" href="'+url+'">\';</script>'));
    assert.ok(output.includes('data-homer-font-href="'+url.replaceAll('&','&amp;')+'"'));
});
for(const [name,html] of Object.entries({
    ordinary:doc('<link rel="stylesheet" href="https://example.test/ui.css">'),
    lookalike:doc('<link rel="stylesheet" href="https://fonts.googleapis.com.evil.test/css2">'),
    credentials:doc('<link rel="stylesheet" href="https://secret@fonts.googleapis.com/css2">'),
    port:doc('<link rel="stylesheet" href="https://fonts.googleapis.com:123/css2">'),
    comment:doc('<!-- <link rel="stylesheet" href="'+url+'"> -->'),
    textarea:doc('<textarea><link rel="stylesheet" href="'+url+'"></textarea>'),
    csp:doc('<meta http-equiv="Content-Security-Policy" content="script-src none"><link rel="stylesheet" href="'+url+'">'),
    duplicate:doc('<link rel="stylesheet" href="'+url+'" href="https://example.test/other.css">'),
    cssComment:doc('<style>/* @import url("'+url+'"); */ body{content:"@import url('+url+');"}</style>'),
    cssMedia:doc('<style>@import url("'+url+'") print;</style>'),
    fragment:'<link rel="stylesheet" href="'+url+'">',
}))test(`${name} stays byte-identical`,()=>assert.equal(defer(html,true),html));
test('shipping adapter changes only two message components, not script iframe initialization',()=>{
    const bundle=fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/third-party/js-slash-runner/dist/index.js',import.meta.url),'utf8');
    assert.equal(bundle.split('let t=deferRemoteFontStylesheets(b1(').length-1,2);
    assert.ok(bundle.includes('function b1(e,t){return e=y1(e)'),'Original shared/script document builder untouched');
});
