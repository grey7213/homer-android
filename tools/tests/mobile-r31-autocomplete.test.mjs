import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const text=fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/autocomplete/AutoComplete.js',import.meta.url),'utf8');
const source=text.replace(/^import .*;\r?\n/gm,'').replaceAll('export const','const').replace('export class','class');
const scope={};vm.createContext(scope);vm.runInContext(source+';globalThis.AutoComplete=AutoComplete',scope);
for(const name of ['updatePosition','updateDetailsPosition','updateFloatingPosition','updateFloatingDetailsPosition']) {
 test(`inactive ${name} never measures layout or constructs a cursor mirror`,()=>{
  const panel=Object.create(scope.AutoComplete.prototype);panel.isActive=false;
  panel.getCursorPosition=()=>assert.fail('inactive panel measured cursor');
  panel.textarea=new Proxy({}, {get:()=>assert.fail('inactive panel read DOM')});
  panel[name]();assert.equal(panel.clone,undefined);
 });
}
test('active floating autocomplete still measures and positions the suggestion',()=>{
 const panel=Object.create(scope.AutoComplete.prototype);panel.isActive=true;
 panel.getCursorPosition=()=>{throw new Error('active cursor measured')};
 assert.throws(()=>panel.updateFloatingPosition(),/active cursor measured/);
 assert.throws(()=>panel.updateFloatingDetailsPosition(),/active cursor measured/);
});
