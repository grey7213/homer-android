// Reorganize existing Memory Books controls without replacing its save/generate handlers.
function el(tag,cls,text) {const e=document.createElement(tag);e.className=cls||'';if(text)e.textContent=text;return e;}
function enhance(popup) {
    const content=popup.querySelector('.popup-content');
    if(!content?.querySelector('#stmb-profile-select')||content.querySelector('.homer-memory-layout'))return;
    const original=[...content.children];
    const layout=el('div','homer-memory-layout');
    const title=el('h2','','长记忆');
    layout.append(title,el('p','homer-memory-intro','把一段对话整理成记忆，方便角色在之后的聊天中记住。先选范围和保存位置，再点底部「创建记忆」。'));
    const step=(name)=>{const s=el('section','homer-memory-step');s.append(el('h3','',name));layout.append(s);return s;};
    const range=step('1 · 选择要记住的对话');
    const scene=content.querySelector('#stmb-scene')||content.querySelector('.info-block.warning');
    if(scene){range.append(scene);if(scene.matches('.warning'))scene.textContent='还没有选择对话范围。填写下面的起止消息序号即可，不必返回聊天找标记按钮。';}
    const ids=[...document.querySelectorAll('#chat .mes[mesid]')].map(e=>Number(e.getAttribute('mesid'))).filter(Number.isInteger);
    const form=el('div','homer-memory-range');const inputs=[];
    for(const [label,id,initial] of [['从','homer-memory-from',ids[0]],['到','homer-memory-to',ids.at(-1)]]) {
        const wrap=el('label','',label),input=document.createElement('input');input.type='number';input.min=String((ids[0]??0)+1);input.max=String((ids.at(-1)??0)+1);input.value=String((initial??0)+1);input.id=id;input.className='text_pole';input.setAttribute('aria-label',label==='从'?'起始消息':'结束消息');wrap.append(input);form.append(wrap);inputs.push(input);
    }
    const choose=el('button','','使用此范围');choose.type='button';const feedback=el('p','homer-memory-intro');feedback.setAttribute('role','status');
    choose.onclick=()=>{
        const [a,b]=inputs.map(e=>Number(e.value)-1);
        if(!Number.isInteger(a)||!Number.isInteger(b)||a>b||!ids.includes(a)||!ids.includes(b)){feedback.textContent='请输入当前已显示消息内有效的起止序号，结束不能早于开始。';return;}
        const start=document.querySelector(`#chat .mes[mesid="${a}"] .mes_stmb_start`),end=document.querySelector(`#chat .mes[mesid="${b}"] .mes_stmb_end`);
        if(!start||!end){feedback.textContent='记忆模块尚未准备好，请稍后重新打开。';return;}
        if(!start.classList.contains('on'))start.click();
        if(!end.classList.contains('on'))end.click();
        feedback.textContent=`已选择第 ${a+1}–${b+1} 条消息。确认保存位置后，点底部「创建记忆」。`;
        if(scene?.matches('.warning'))scene.hidden=true;
    };form.append(choose);range.append(form,feedback);
    const progress=content.querySelector('#stmb-memory-status');if(progress){progress.querySelector('[data-i18n="STMemoryBooks_SinceVersion"]')?.remove();range.append(progress);}
    const storage=step('2 · 确认记忆保存位置');
    const location=content.querySelector('#stmb-active-lorebook')?.closest('.info-block');if(location)storage.append(location);
    const badge=storage.querySelector('#stmb-mode-badge');if(badge)badge.textContent=content.querySelector('#stmb-manual-mode-enabled')?.checked?'手动选择记忆书':'跟随当前对话';
    const auto=content.querySelector('#stmb-auto-create-lorebook')?.closest('.world_entry_form_control');if(auto)storage.append(auto);
    const profile=step('3 · 选择整理方式');const profileRow=content.querySelector('#stmb-profile-select')?.closest('.world_entry_form_control');if(profileRow)profile.append(profileRow);
    profile.append(el('p','homer-memory-intro','使用当前聊天模型即可开始。创建记忆会调用模型；整合记忆用于合并已经生成的记忆，不是首次创建。'));
    const advanced=el('details','homer-memory-advanced');advanced.append(el('summary','','高级设置 · 模板、模型与自动整理'));
    for(const child of original) {
        if(child.tagName==='H2' || layout.contains(child))continue;
        advanced.append(child);
    }
    layout.append(advanced);content.replaceChildren(layout);
}
let installed=false;
export function installMemoryUi() {
    if(installed)return;installed=true;
    const scan=node=>{if(!(node instanceof Element))return;const parent=node.closest('.stmb-popup');if(parent)enhance(parent);node.querySelectorAll('.stmb-popup').forEach(enhance);};
    new MutationObserver(records=>{for(const record of records){scan(record.target);for(const node of record.addedNodes)scan(node);}}).observe(document.body,{childList:true,subtree:true});
    document.querySelectorAll('.stmb-popup').forEach(enhance);
}
