import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const start=source.indexOf('async function enableTavernHelperCardScripts(');
const end=source.indexOf('\nasync function selectLaunchCharacter(',start);
assert.ok(start>=0&&end>start);
function fixture({ committed=true, changeOwner=false }={}) {
    let now=0,owner='qa-owner';const sleeps=[],writes=[];
    class Element {}
    class Input extends Element {
        checked=false;
        click(){this.checked=true;queueMicrotask(()=>{if(committed)settings.tavern_helper.script.enabled.characters.push('QA Card');});}
    }
    const toggle=new Input(),settings={tavern_helper:{script:{enabled:{characters:[]}}}};
    const context={Date:{now:()=>now},HTMLInputElement:Input,HTMLElement:Element,
        launch:{app_id:'qa-card',conversation_id:'qa-chat'},storageAccountEpoch:0,
        reconcileStorageAccount:()=>owner,extension_settings:settings,
        localStorage:{setItem:(...values)=>writes.push(values)},
        document:{querySelectorAll:selector=>selector==='[data-container-type]'
            ?[{getAttribute:()=> 'character'}]:selector.startsWith('input')?[toggle]:[]},
        window:{setTimeout:fn=>{sleeps.push(16);now+=16;if(changeOwner)owner='next-owner';queueMicrotask(fn);}},
    };
    vm.createContext(context);vm.runInContext(source.slice(start,end),context);
    const character={avatar:'qa.png',name:'QA Card',data:{extensions:{tavern_helper:{scripts:[{id:'qa',name:'qa',content:'owned fixture'}]}}}};
    return {context,character,toggle,sleeps,writes};
}
test('actual committed character scripts settle without the old fixed 500ms window',async()=>{
    const f=fixture();await f.context.enableTavernHelperCardScripts(f.character);
    assert.equal(f.toggle.checked,true);assert.ok(f.sleeps.length<=1);assert.equal(f.writes.length,1);
});
test('checked UI without an actual settings commit never counts as successful activation',async()=>{
    const f=fixture({committed:false});await assert.rejects(f.context.enableTavernHelperCardScripts(f.character),/启用未完成/);
    assert.equal(f.writes.length,0);
});
test('account changes while activation is settling reject rather than writing a new scope',async()=>{
    const f=fixture({changeOwner:true});await assert.rejects(f.context.enableTavernHelperCardScripts(f.character),/所属会话已切换/);
    assert.equal(f.writes.length,0);
});
test('actual selected-store adapter is awaited and never polls DOM checkbox ordering',async()=>{
    const f=fixture();let calls=0;
    f.context.window.HomerTavernHelperActivation={activateCharacter:async name=>{assert.equal(name,'QA Card');calls++;return true;}};
    await f.context.enableTavernHelperCardScripts(f.character);
    assert.equal(calls,1);assert.equal(f.toggle.checked,false);assert.equal(f.sleeps.length,0);
});
test('preparing selected scripts does not activate the previous card or require its checkbox',async()=>{
    const f=fixture();let calls=0;
    f.context.window.HomerTavernHelperActivation={prepareCharacter:async name=>{assert.equal(name,'QA Card');calls++;return true;}};
    await f.context.enableTavernHelperCardScripts(f.character,{prepare:true});
    assert.equal(calls,1);assert.equal(f.toggle.checked,false);
});
