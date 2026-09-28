import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generationFailure, beginDiagnostic, observeDiagnostic, finishDiagnostic, safeDiagnostic } from '../../sillytavern-runtime/public/scripts/homer-generation-diagnostics.mjs';
import { setOfficialDisplayRules, officialDisplayRules } from '../../sillytavern-runtime/public/scripts/homer-official-regex.mjs';
const require = createRequire(import.meta.url);
const {run, compile} = require(process.env.HOMER_REGEX_WORKER || '../../server-patches/r29/homer_regex.cjs');
const rule = {id:'one', findRegex:'/secret/g', replaceString:'safe', placement:[1,2], promptOnly:true};
test('global replacement and stage filtering', () => {
  const data=run({scripts:[rule,{...rule,id:'render',replaceString:'bad',markdownOnly:true,promptOnly:false}],messages:[{role:'user',content:'secret secret'}]});
  assert.deepEqual(data,{messages:[{role:'user',content:'safe safe'}],errors:[]});
});
test('non-global flags replace once',()=>assert.equal(run({scripts:[{...rule,findRegex:'/secret/'}],messages:[{role:'assistant',content:'secret secret'}]}).messages[0].content,'safe secret'));
test('named groups, trim strings, macros',()=>{
  const result=run({user:'Alice',scripts:[{...rule,findRegex:'/(?<word> x )/',replaceString:'{{user}}:$<word>:$0',trimStrings:[' ']}],messages:[{role:'user',content:' x '}]});
  assert.equal(result.messages[0].content,'Alice:x:x');
});
test('depth and placement, system messages untouched',()=>{
 const result=run({scripts:[{...rule,minDepth:1,maxDepth:1,placement:[2]}],messages:[{role:'system',content:'secret'},{role:'assistant',content:'secret'},{role:'user',content:'secret'}]});
 assert.deepEqual(result.messages.map(m=>m.content),['secret','safe','secret']);
});
test('JS unicode property and lookbehind',()=>assert.equal(compile('/(?<=x)\\p{L}+/gu').test('x中文'),true));
test('invalid rule returns identifier only',()=>assert.deepEqual(run({scripts:[{...rule,findRegex:'['}],messages:[]}).errors,['one']));
test('rules with negative depth are unbounded',()=>assert.equal(run({scripts:[{...rule,maxDepth:-1}],messages:[{role:'user',content:'secret'}]}).messages[0].content,'safe'));
test('disabled rule cannot break generation',()=>assert.deepEqual(run({scripts:[{...rule,findRegex:'[',disabled:true}],messages:[]}).errors,[]));
test('display rules replace previous scope and never run in prompt stage',()=>{
 setOfficialDisplayRules({scripts:[rule]}); assert.equal(officialDisplayRules()[0].promptOnly,false);
 setOfficialDisplayRules({scripts:[]}); assert.equal(officialDisplayRules().length,0);
});
test('display rejects malformed pattern',()=>assert.deepEqual(setOfficialDisplayRules({scripts:[{...rule,findRegex:'['}]}).errors,['one']));
test('stable errors never expose provider text or secrets',()=>{
 const error=generationFailure({error:{message:'secret-key-and-url',request_id:'https://private/token'}},503);
 assert.equal(error.code,'HM-G503'); assert.ok(error.message.includes('更换模型')); assert.equal(error.request_id,'');
 assert.ok(!error.message.includes('secret'));
});
test('balance/auth errors give correct next action',()=>{
 assert.ok(generationFailure({},402).message.includes('积分')); assert.ok(generationFailure({},401).message.includes('重新进入'));
});
test('diagnostics whitelist and cancellation',()=>{
 globalThis.window=new EventTarget(); let event;
 window.addEventListener('homer-generation-diagnostic', e=>event=e.detail);
 const trace=beginDiagnostic('model-test');
 observeDiagnostic(trace,{homer_diagnostic:{request_id:'abc',prompt_id:'preset',headers:'secret',api_key:'secret',regex_count:3}},'text');
 finishDiagnostic(trace,new DOMException('cancelled','AbortError'));
 assert.equal(event.status,'cancelled'); assert.equal(event.output_chars,4); assert.equal(event.api_key,undefined); assert.equal(event.headers,undefined); assert.equal(event.start,undefined);
});
test('copy excludes unexpected historical message metadata',()=>{
 const result=safeDiagnostic({schema:'homer-generation-v1',status:'complete',headers:{Authorization:'private'},content:'private',worldbook_revision:'abc',display_regex_errors:['private-pattern']});
 assert.equal(result.content,undefined);assert.equal(result.headers,undefined);assert.equal(result.worldbook_revision,'abc');assert.equal(result.display_regex_error_count,1);assert.equal(result.display_regex_errors,undefined);
});
