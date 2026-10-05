import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createRegexTemplateCache, fillRegexTemplate } from '../../sillytavern-runtime/public/scripts/homer-stable-template.mjs';

const root = new URL('../../sillytavern-runtime/', import.meta.url);
const acorn = createRequire(new URL('package.json',root))('acorn');
const source = fs.readFileSync(new URL('public/scripts/extensions/regex/engine.js',root),'utf8');
const utils = fs.readFileSync(new URL('public/scripts/utils.js',root),'utf8');
const fences = await import('../../sillytavern-runtime/public/scripts/homer-html-fences.mjs');
function declaration(text,name){
  const n=acorn.parse(text,{ecmaVersion:'latest',sourceType:'module'}).body.map(n=>n.declaration||n).find(n=>n.id?.name===name);
  assert.ok(n,name);return text.slice(n.start,n.end);
}
const rule = patch=>({findRegex:'START',replaceString:'',disabled:false,markdownOnly:true,promptOnly:false,
  placement:[2],trimStrings:[],substituteRegex:0,...patch});
function engine(card,official=[]){
  const scope={console,extension_settings:{disabledExtensions:[]},getRegexScripts:()=>[...card,...official],
    officialDisplayRules:()=>official,createFrontendRuleBoundary:fences.createFrontendRuleBoundary,
    substitute_find_regex:{NONE:0,RAW:1,ESCAPED:2},replacementTemplates:createRegexTemplateCache(),fillRegexTemplate,
    substituteParams:v=>v,substituteParamsExtended:v=>v,assertDeterministicMacroReplayEligible(){},name1:'Reader',name2:'Card'};
  vm.createContext(scope);
  vm.runInContext(declaration(utils,'regexFromString'),scope);
  for(const n of ['RegexProvider','getRegexedString','runRegexScript','filterString','replayRegexParams','sanitizeRegexMacro'])vm.runInContext(declaration(source,n),scope);
  return (text,options={})=>scope.getRegexedString(text,2,{isMarkdown:true,depth:0,...options});
}
// Exact failure mechanism: the author's SCRIPT contains literal thinking tags.
// The official thinking beautifier was matching these JavaScript string values.
const doc='```html\n<!DOCTYPE html><html><body><button>Game</button><script>const clean=s=>s.replace(/<thinking>[\\s\\S]*?<\\/thinking>/gi, ""); const example="<thinking>sample</thinking>";</script></body></html>\n```';
const beauty=rule({findRegex:'<(?:think(?:ing)?|inner_flow)>([\\s\\S]*?)<\\/(?:think(?:ing)?|inner_flow)>',replaceString:'<style>theme</style><details>$1</details>'});
test('actual engine preserves authored executable frontend under official thinking rule',()=>{
  const render=engine([rule({replaceString:doc})],[beauty]);
  assert.equal(render('START'),doc);
});
test('official rules still transform prose before and after multiple frontend blocks',()=>{
  const render=engine([rule({findRegex:'/START/g',replaceString:doc})],[rule({findRegex:'/sample/g',replaceString:'changed'})]);
  assert.equal(render('sample\nSTART\nsample\nSTART\nsample'), 'changed\n'+doc+'\nchanged\n'+doc+'\nchanged');
});
test('official catch-all cannot consume/corrupt the frozen document boundary',()=>{
  assert.equal(engine([], [rule({findRegex:'/[\\s\\S]+/g',replaceString:'clean'})])('before\n'+doc+'\nafter'),'clean\n'+doc+'\nclean');
});
test('card-owned regex chains retain their original full-source semantics',()=>{
  assert.equal(engine([rule({replaceString:doc}),rule({findRegex:'/sample/g',replaceString:'changed'})])('START'),doc.replace('sample','changed'));
});
test('prompt processing and ordinary non-document code do not acquire a display exception',()=>{
  const prompt=rule({...beauty,markdownOnly:false,promptOnly:true});
  assert.equal(engine([], [prompt])('<thinking>text</thinking>',{isMarkdown:false,isPrompt:true}),'<style>theme</style><details>text</details>');
  assert.equal(engine([], [beauty])('```js\nconst x="<thinking>sample</thinking>";\n```'),'```js\nconst x="<style>theme</style><details>sample</details>";\n```');
});
test('malformed/incomplete fences retain existing official rule behavior',()=>{
  const malformed=doc.replace('</body>','');
  assert.notEqual(engine([], [beauty])(malformed),malformed);
});
test('CRLF, indentation, tilde and longer fences retain exact authored bytes',()=>{
  for(const fence of ['```','````','~~~']) {
    const html='  '+fence+'HTML\r\n<BODY><script>const x="<thinking>sample</thinking>";</script></BODY>\r\n  '+fence;
    const input='sample\r\n'+html+'\r\nsample';
    assert.equal(engine([], [rule({findRegex:'/sample/g',replaceString:'changed'})])(input),'changed\r\n'+html+'\r\nchanged');
  }
});
test('disabled, edit and depth filtering still run before the official boundary',()=>{
  const input='<thinking>sample</thinking>\n'+doc;
  for(const patch of [{disabled:true},{minDepth:2},{maxDepth:-1,runOnEdit:false}]) {
    const options=Object.hasOwn(patch,'runOnEdit')?{isEdit:true}:{};
    assert.equal(engine([], [rule({...beauty,...patch})])(input,options),input);
  }
});
