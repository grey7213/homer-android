"""Fixture-scoped browser actions; no credentials, provider or fake bridge."""

SELECT_FIXTURES = r"""async q=>{
  if(location.origin!=='http://127.0.0.1:8191')throw Error('Exact isolated loopback origin required');
  const {api}=await import('/app/assets/js/app-core.js'),r=await api.conversations(),rows=(r.data||r).list;
  if(!Array.isArray(rows))throw Error('Actual history list unavailable');
  const candidates=rows.filter(row=>/^R34 [AB] [a-f0-9]{8}$/.test(String(row.app_name||''))
    &&String(row.app_id??'').trim()&&String(row.id??'').trim());
  const scoped=q!=null;
  if(scoped&&(!q||typeof q!=='object'||typeof q.app!=='string'||!q.app.trim()
    ||typeof q.conv!=='string'||!q.conv.trim()))throw Error('Exact current fixture scope required');
  for(const first of candidates.filter(row=>row.app_name.startsWith('R34 A '))){
    const second=candidates.find(row=>row.app_name==='R34 B '+first.app_name.slice(6)
      &&String(row.app_id)!==String(first.app_id)&&String(row.id)!==String(first.id)
      &&(!scoped||(String(first.app_id)===q.app&&String(first.id)===q.conv)
        ||(String(row.app_id)===q.app&&String(row.id)===q.conv)));
    if(second)
      return [first,second].map((row,index)=>({app:String(row.app_id),conv:String(row.id),name:row.app_name,label:index?'B':'A'}));
  }
  throw Error('Exact paired owned R34 A/B histories required; do not create or use arbitrary cards');
}"""

OWNED_PROOF = r"""q=>{
  const c=window.SillyTavern?.getContext?.(),card=c?.characters?.[c.characterId],data=card?.data||card;
  const matched=/^R34 ([AB]) [a-f0-9]{8}$/.exec(String(data?.name||card?.name||''));
  const b=c?.chatMetadata?.homer_bridge,h=data?.extensions?.homer_bridge;
  return {exact_selected_name:String(data?.name||card?.name||'')===q.name,strict_owned_name:!!matched,
    isolated_creator:data?.creator==='local-test',isolated_description:data?.description==='本机隔离测试',
    original_authored_opening:!!matched&&data?.first_mes==='R34 opening '+matched[1],
    exact_scope:String(b?.app_id||'')===q.app&&String(b?.conversation_id||'')===q.conv
      &&String(h?.app_id||'')===q.app&&c?.chatId==='Homer-'+q.conv,
    actual_runtime:!!window.__homerCardStageRuntime&&b?.runtime==='dialogue'};
}"""

INSTALL_OBSERVER = r"""async()=>{
  if(window.__r37StageMatrix)return false;
  const {event_types}=await import('./script.js'),c=window.SillyTavern.getContext();
  const probe=window.__r37StageMatrix={lifecycle:[],presentation:[],capability:[],snapshots:[],retired:[]};
  for(const name of ['CHAT_CHANGED','CHAT_LOADED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED'])
    c.eventSource.on(event_types[name],()=>probe.lifecycle.push(name));
  document.addEventListener('homer-presentation-mode-state',event=>probe.presentation.push({mode:event.detail?.mode,available:!!event.detail?.visualAvailable}));
  document.addEventListener('homer-card-sidebar-capability',event=>probe.capability.push(!!event.detail?.enabled));
  return true;
}"""

APPLY_EXPERIENCE = r"""async q=>{
  const proof=(__OWNED__)(q);if(!Object.values(proof).every(Boolean))throw Error('Owned canonical fixture proof required before mutation');
  const {event_types}=await import('./script.js'),c=window.SillyTavern.getContext(),data=c.characters[c.characterId].data;
  const probe=window.__r37StageMatrix;if(!probe)throw Error('Real lifecycle observer missing');
  if(!probe.snapshots.some(row=>row.data===data))probe.snapshots.push({data,app:q.app,conv:q.conv,
    experience_present:Object.hasOwn(data.extensions,'homer_card_experience'),experience:data.extensions.homer_card_experience,
    assets_present:Object.hasOwn(data.extensions,'homer_media_assets'),assets:data.extensions.homer_media_assets,
    chat:c.chat.slice()});
  const marker=q.marker,asset='r37-stage-background-'+q.label;
  data.extensions.homer_card_experience={version:2,
    stage:{enabled:true,layout:'standard',orientation:'default',chat_width:92,show_portrait:false,
      background_asset_id:asset,accent_color:q.label==='A'?'#4fa3ff':'#66bb88'},
    structured_components:{enabled:true,status:true},galgame:{enabled:false},bgm:{enabled:false},
    sidebars:[{id:'r37-stage-sidebar-'+q.label,name:'Fixture panel '+q.label,trigger_label:'Fixture '+q.label,
      enabled:true,position:'right',width:260,content_mode:'static',
      content_html:'<p data-stage-fixture-panel>'+marker+'</p><span data-card-live></span>'}]};
  data.extensions.homer_media_assets=[{id:asset,kind:'background',name:'Synthetic one-pixel fixture',status:'ready',
    url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',mime_type:'image/gif'}];
  const status={type:'status',id:marker,title:marker,items:[{name:'Fixture HP',value:17,max:20,description:'Fixture detail '+marker}]};
  const mes=marker+'\n```homer-ui\n'+JSON.stringify(status)+'\n```';
  c.chat.splice(0,c.chat.length,{name:'Isolated fixture',is_user:false,is_system:false,mes,send_date:new Date().toISOString(),extra:{}});
  await c.printMessages({scroll:false});
  // Exercise the actual installed listeners with the ordinary full lifecycle.
  await Promise.all([c.eventSource.emit(event_types.CHAT_CHANGED,c.chatId),c.eventSource.emit(event_types.CHAT_LOADED,c.chatId)]);
  return {owned_proof:proof,synthetic_messages_only:true,no_card_api_write:true};
}""".replace('__OWNED__', OWNED_PROOF)

APPEND_LATEST = r"""async q=>{
  if(!Object.values((__OWNED__)(q)).every(Boolean))throw Error('Owned canonical fixture required before latest message mutation');
  const {event_types}=await import('./script.js'),c=window.SillyTavern.getContext();
  const status={type:'status',id:q.marker,title:q.marker,items:[{name:'Latest fixture HP',value:19,max:20,description:'Fixture detail '+q.marker}]};
  c.chat.push({name:'Isolated fixture',is_user:false,is_system:false,mes:q.marker+'\n```homer-ui\n'+JSON.stringify(status)+'\n```',
    send_date:new Date().toISOString(),extra:{}});
  // Match the shipping append path: replacing the entire DOM with
  // printMessages would discard older structured components while the
  // following point event intentionally renders only this new message.
  c.addOneMessage(c.chat[c.chat.length-1],{scroll:false});
  await c.eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED,c.chat.length-1);
  return {canonical_messages:c.chat.length,point_event:'CHARACTER_MESSAGE_RENDERED',no_generation:true};
}""".replace('__OWNED__', OWNED_PROOF)

RETIRE_MEDIA = r"""async()=>{
  const {cardExperienceRuntime}=await import('/app/assets/js/card-experience-runtime.mjs?v=20260821-chatarchive-dialogue-only-v5');
  const probe=window.__r37StageMatrix,root=document.getElementById('homerCardExperienceRoot'),backdrop=document.getElementById('homerCardStageBackdrop');
  if(!probe||!root||!backdrop||!backdrop.querySelector('img'))throw Error('Actual mounted fixture media required');
  probe.retired.push({root,backdrop,image:backdrop.querySelector('img'),audio:cardExperienceRuntime.audio});
  return {retired_count:probe.retired.length};
}"""

MAKE_ORDINARY = r"""async q=>{
  if(!Object.values((__OWNED__)(q)).every(Boolean))throw Error('Owned canonical fixture required before ordinary configuration');
  const {event_types}=await import('./script.js'),c=window.SillyTavern.getContext(),data=c.characters[c.characterId].data;
  data.extensions.homer_card_experience={};data.extensions.homer_media_assets=[];
  c.chat.splice(0,c.chat.length,{name:'Isolated ordinary fixture',is_user:false,is_system:false,
    mes:q.marker,send_date:new Date().toISOString(),extra:{}});
  await c.printMessages({scroll:false});
  await Promise.all([c.eventSource.emit(event_types.CHAT_CHANGED,c.chatId),c.eventSource.emit(event_types.CHAT_LOADED,c.chatId)]);
  return {ordinary_same_owned_card:true,no_card_api_write:true};
}""".replace('__OWNED__', OWNED_PROOF)

RENDERED_STATE = r"""()=>{
  const c=window.SillyTavern?.getContext?.(),root=document.getElementById('homerCardExperienceRoot'),shadow=root?.shadowRoot;
  const backdrop=document.getElementById('homerCardStageBackdrop'),probe=window.__r37StageMatrix;
  const toggle=document.getElementById('homer-presentation-mode-toggle'),rail=document.querySelector('.homer-keyword-injector');
  const rect=node=>{const r=node?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null;};
  return {canonical_count:c?.chat?.length||0,dom_count:document.querySelectorAll('#chat>.mes').length,
    component_ids:[...document.querySelectorAll('#chat .homer-card-component')].map(node=>node.dataset.componentId),
    stage_active:document.body.classList.contains('homer-card-stage-active'),root_count:document.querySelectorAll('#homerCardExperienceRoot').length,
    backdrop_count:document.querySelectorAll('#homerCardStageBackdrop').length,
    background_loaded:!!backdrop?.querySelector('img')?.complete&&!!backdrop?.querySelector('img')?.naturalWidth,
    component_bounds:rect(document.querySelector('#chat .homer-card-component')),
    sidebar_triggers:shadow?.querySelectorAll('.ce-edge button').length||0,
    open_sidebars:shadow?.querySelectorAll('.ce-sidebar.is-open').length||0,
    mode:toggle?.dataset.mode,toggle_hidden:!!toggle?.hidden,
    generic_rail_disabled:!rail||rail.classList.contains('is-card-disabled'),orientation:document.documentElement.dataset.homerOrientation,
    retired_media_clean:(probe?.retired||[]).every(row=>!row.root.isConnected&&!row.backdrop.isConnected&&!row.image.isConnected
      &&(!row.audio||(row.audio.paused&&!row.audio.getAttribute('src')))),
    lifecycle:probe?.lifecycle?.slice()||[],presentation:probe?.presentation?.slice()||[],capability:probe?.capability?.slice()||[]};
}"""

RESTORE_FIXTURES = r"""async()=>{
  const probe=window.__r37StageMatrix;if(!probe)return {restored:0};
  const c=window.SillyTavern.getContext();
  for(const row of probe.snapshots){
    if(row.experience_present)row.data.extensions.homer_card_experience=row.experience;
    else delete row.data.extensions.homer_card_experience;
    if(row.assets_present)row.data.extensions.homer_media_assets=row.assets;
    else delete row.data.extensions.homer_media_assets;
    if(String(c.chatMetadata?.homer_bridge?.app_id||'')===row.app&&String(c.chatMetadata?.homer_bridge?.conversation_id||'')===row.conv)
      c.chat.splice(0,c.chat.length,...row.chat);
  }
  return {restored:probe.snapshots.length,no_card_api_write:true};
}"""
