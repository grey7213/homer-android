import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../frontend/assets/js/memory-ui.js',import.meta.url),'utf8');
const implementation=source.slice(source.indexOf('const boundaryButtons='),source.indexOf('function refreshMemoryLabels('));

function harness({legacy=false,noResizeObserver=false,host=false}={}){
    const raf=new Map(),mutations=[],resizes=[],writes=[];let nextFrame=1,geometryReads=0;
    const events=()=>({listeners:new Map(),addEventListener(name,fn){this.listeners.set(name,fn);},removeEventListener(name,fn){if(this.listeners.get(name)===fn)this.listeners.delete(name);},emit(name){this.listeners.get(name)?.();}});
    const viewport=Object.assign(events(),{width:390,height:844,offsetLeft:0,offsetTop:0});
    const window=Object.assign(events(),{visualViewport:viewport});
    const priorities=new Map();
    const button={isConnected:true,parentNode:{},attributes:{},hidden:false,tabIndex:0,pluginListeners:['pointerdown','click'],
        style:new Proxy({left:'380px',top:'820px',getPropertyValue(key){return this[key]||'';},getPropertyPriority(key){return priorities.get(key)||'';},setProperty(key,value,priority=''){this[key]=value;priorities.set(key,priority);}},{set(target,key,value){writes.push([key,value]);priorities.delete(key);target[key]=value;return true;}}),
        setAttribute(key,value){this.attributes[key]=value;},getAttribute(key){return this.attributes[key]??null;},
        getBoundingClientRect(){geometryReads++;if(!legacy)throw Error('unexpected forced-layout geometry read');return {left:380,top:820,width:180,height:40};},
    };
    for(const key of ['clientWidth','clientHeight','offsetWidth','offsetHeight'])Object.defineProperty(button,key,{get(){throw Error(`unexpected ${key} read`);}});
    class MutationObserver{
        constructor(callback){this.callback=callback;this.disconnected=false;mutations.push(this);}
        observe(target,options){this.target=target;this.options=options;}
        disconnect(){this.disconnected=true;}
        emit(){if(!this.disconnected)this.callback([]);}
    }
    class ResizeObserver{
        constructor(callback){this.callback=callback;this.disconnected=false;resizes.push(this);}
        observe(target){this.target=target;}
        disconnect(){this.disconnected=true;}
        emit(width,height,{single=false,borderBox=true}={}){
            const box={inlineSize:width,blockSize:height};
            this.callback([{target:this.target,contentRect:{width,height},...(borderBox?{borderBoxSize:single?box:[box]}:{})}]);
        }
    }
    const context={window,document:{body:{classList:{contains(name){return host&&name==='homer-runtime';}}}},innerWidth:390,innerHeight:844,MutationObserver,ResizeObserver:noResizeObserver?undefined:ResizeObserver,
        requestAnimationFrame(callback){const id=nextFrame++;raf.set(id,callback);return id;},cancelAnimationFrame(id){raf.delete(id);},
    };
    vm.createContext(context);vm.runInContext(implementation,context);
    const flush=()=>{for(const [id,callback] of [...raf]){raf.delete(id);callback();}};
    return {context,button,window,viewport,raf,mutations,resizes,writes,flush,
        install(){context.enhanceBoundaryButton(button);},get geometryReads(){return geometryReads;}};
}

test('boundary enhancement startup and pre-size mutations do not force chat layout',()=>{
    const h=harness();h.install();
    assert.equal(h.raf.size,0);assert.equal(h.geometryReads,0);
    assert.equal(h.resizes[0].target,h.button);
    assert.equal(h.button.attributes['aria-label'],'跳转到尚未整理记忆的对话');
    h.mutations[0].emit();h.flush();
    assert.equal(h.geometryReads,0);assert.equal(h.writes.length,0);
});

test('first actual borderBoxSize clamps using label size rather than the plugin 36px square',()=>{
    const h=harness();h.install();h.resizes[0].emit(180,40);h.flush();
    assert.equal(h.button.style.left,'202px');assert.equal(h.button.style.top,'724px');
    assert.equal(h.geometryReads,0);
});

test('Chrome legacy single-object borderBoxSize avoids geometry reads too',()=>{
    const h=harness();h.install();h.resizes[0].emit(180,40,{single:true});h.flush();
    assert.equal(h.button.style.left,'202px');assert.equal(h.geometryReads,0);
});

test('drag mutations batch in one frame, preserve upstream listeners and use cached actual size',()=>{
    const h=harness();h.install();h.resizes[0].emit(180,40);h.flush();
    h.button.style.left='1000px';h.mutations[0].emit();h.button.style.top='2000px';h.mutations[0].emit();
    assert.equal(h.raf.size,1);h.flush();
    assert.equal(h.button.style.left,'202px');assert.equal(h.button.style.top,'724px');
    assert.deepEqual(h.button.pluginListeners,['pointerdown','click']);assert.equal(h.geometryReads,0);
});

test('window resize and keyboard visualViewport resize/scroll keep button within visible safe bounds',()=>{
    const h=harness();h.install();h.resizes[0].emit(180,40);h.flush();
    h.viewport.width=320;h.viewport.height=360;h.viewport.offsetTop=40;h.viewport.offsetLeft=5;
    h.viewport.emit('resize');h.viewport.emit('scroll');h.window.emit('resize');
    assert.equal(h.raf.size,1);h.flush();
    assert.equal(h.button.style.left,'137px');assert.equal(h.button.style.top,'280px');
    h.button.style.left='-50px';h.button.style.top='-50px';h.mutations[0].emit();h.flush();
    assert.equal(h.button.style.left,'13px');assert.equal(h.button.style.top,'96px');assert.equal(h.geometryReads,0);
});

test('without visualViewport, numeric inner dimensions retain the original safety margins',()=>{
    const h=harness();h.window.visualViewport=null;h.context.innerWidth=320;h.context.innerHeight=600;
    h.install();h.resizes[0].emit(180,40);h.flush();
    assert.equal(h.button.style.left,'132px');assert.equal(h.button.style.top,'480px');assert.equal(h.geometryReads,0);
});

test('hidden zero-size delivery waits for show and the new actual size',()=>{
    const h=harness();h.install();h.resizes[0].emit(0,0);h.mutations[0].emit();h.flush();
    assert.equal(h.writes.length,0);
    h.resizes[0].emit(220,44);h.flush();
    assert.equal(h.button.style.left,'162px');assert.equal(h.button.style.top,'720px');assert.equal(h.geometryReads,0);
});

test('removal disconnects observers, cancels frame/listeners, and allows a later reattachment',()=>{
    const h=harness();h.install();h.resizes[0].emit(180,40);
    assert.equal(h.raf.size,1);h.button.isConnected=false;h.mutations[1].emit();
    assert.equal(h.raf.size,0);assert.ok(h.mutations.every(value=>value.disconnected));assert.ok(h.resizes[0].disconnected);
    assert.equal(h.window.listeners.size,0);assert.equal(h.viewport.listeners.size,0);assert.equal(h.geometryReads,0);
    h.button.isConnected=true;h.install();assert.equal(h.resizes.length,2);h.resizes[1].emit(180,40);h.flush();
    assert.equal(h.button.style.left,'202px');
});

test('a detached button also cleans up on a pending clamp and enhancement stays single-flight',()=>{
    const h=harness();h.install();h.install();assert.equal(h.resizes.length,1);assert.equal(h.mutations.length,2);
    h.mutations[0].emit();h.button.isConnected=false;h.flush();
    assert.ok(h.resizes[0].disconnected);assert.equal(h.window.listeners.size,0);
});

test('old RO without borderBoxSize only measures inside post-layout delivery, not startup or drag',()=>{
    const h=harness({legacy:true});h.install();assert.equal(h.geometryReads,0);
    h.resizes[0].emit(178,38,{borderBox:false});h.flush();assert.equal(h.geometryReads,1);
    assert.equal(h.button.style.left,'202px');assert.equal(h.button.style.top,'724px');
    h.button.style.left='400px';h.mutations[0].emit();h.window.emit('resize');h.flush();
    assert.equal(h.geometryReads,1);assert.equal(h.button.style.left,'202px');
});

test('custom non-px initial coordinates normalize once after RO, then follow the numeric fast path',()=>{
    const h=harness({legacy:true});h.button.style.left='95%';h.button.style.top='auto';h.install();
    assert.equal(h.geometryReads,0);h.resizes[0].emit(180,40);h.flush();
    assert.equal(h.geometryReads,1);assert.equal(h.button.style.left,'202px');assert.equal(h.button.style.top,'724px');
    h.mutations[0].emit();h.flush();assert.equal(h.geometryReads,1);
});

test('pre-RO browsers preserve upstream positioning without eager geometry and still clean up',()=>{
    const h=harness({noResizeObserver:true});h.install();h.mutations[0].emit();h.flush();
    assert.equal(h.button.style.left,'380px');assert.equal(h.geometryReads,0);
    h.button.isConnected=false;h.mutations[1].emit();assert.equal(h.window.listeners.size,0);
});

test('Homer hides only the boundary jump without layout observers or changing plugin listeners',()=>{
    const h=harness({host:true});h.install();h.install();
    assert.equal(h.button.hidden,true);assert.equal(h.button.attributes['aria-hidden'],'true');assert.equal(h.button.tabIndex,-1);
    assert.equal(h.button.style.display,'none');assert.equal(h.button.style.getPropertyPriority('display'),'important');
    assert.deepEqual(h.button.pluginListeners,['pointerdown','click']);assert.equal(h.geometryReads,0);
    assert.equal(h.resizes.length,0);assert.equal(h.raf.size,0);assert.equal(h.window.listeners.size,0);assert.equal(h.viewport.listeners.size,0);
    assert.equal(h.mutations.length,2);
});

test('Homer restores hidden state after plugin display writes, inline important and attribute changes',()=>{
    const h=harness({host:true});h.install();
    for(const important of [false,true]){
        if(important)h.button.style.setProperty('display','inline-flex','important');else h.button.style.display='inline-flex';
        h.button.hidden=false;h.button.tabIndex=0;h.button.setAttribute('aria-hidden','false');h.mutations[0].emit();
        assert.equal(h.button.hidden,true);assert.equal(h.button.tabIndex,-1);assert.equal(h.button.attributes['aria-hidden'],'true');
        assert.equal(h.button.style.display,'none');assert.equal(h.button.style.getPropertyPriority('display'),'important');
    }
    const count=h.writes.length;h.mutations[0].emit();assert.equal(h.writes.length,count,'suppression must settle without another style mutation');
    assert.equal(h.geometryReads,0);
});

test('Homer releases the hidden control observer on removal and handles reattachment',()=>{
    const h=harness({host:true});h.install();h.button.isConnected=false;h.mutations[1].emit();
    assert.ok(h.mutations.every(value=>value.disconnected));
    h.button.style.display='inline-flex';h.button.hidden=false;h.button.isConnected=true;h.install();
    assert.equal(h.mutations.length,4);assert.equal(h.button.style.display,'none');assert.equal(h.button.hidden,true);
    assert.equal(h.geometryReads,0);
});

test('Homer CSS prevents a boundary jump flash in light and dark themes without hiding Long Memory settings',()=>{
    const css=fs.readFileSync(new URL('../../frontend/assets/css/chat-design.css',import.meta.url),'utf8');
    assert.match(css,/body\.homer-runtime #stmb-memory-boundary-jump\{display:none!important;visibility:hidden!important;pointer-events:none!important\}/);
    assert.doesNotMatch(css,/#stmb-memory-boundary-jump::after/);
    assert.doesNotMatch(css,/#homer-open-memory-books\s*\{[^}]*display:none/);
});
