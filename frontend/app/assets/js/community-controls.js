import { api, getCachedUser } from './app-core.js?v=20260917-r8';
import { confirmAction } from '/assets/js/dialogs.js?v=20260917-r8';
import {canUseLocal,enableLocal,disableLocal,localEnabled,resetLocal} from './community-local.js?v=20260917-r8';

export const social = async (path, method='GET', body) => {
  const response = await api.social(path, {method, ...(body === undefined ? {} : {body})});
  return response?.data ?? response;
};
export function element(tag, text='', attrs={}) {
  const node=document.createElement(tag); node.textContent=text;
  for(const [key,value] of Object.entries(attrs)) if(value!==undefined)node.setAttribute(key,String(value));
  return node;
}
export function button(text, handler, attrs={}) {
  const node=element('button',text,{type:'button',...attrs});
  node.onclick=async()=>{node.disabled=true;try{await handler();}catch(error){showError(node.closest('dialog')||node.parentElement,error);}finally{node.disabled=false;}};
  return node;
}
export function showError(root,error) {
  let node=root.querySelector('[data-community-error]');
  if(!node){node=element('p','',{'data-community-error':'',role:'alert',class:'community-error'});root.append(node);}
  node.textContent=error?.message || String(error);
}
export function sheet(title) {
  styles();
  const dialog=element('dialog','',{class:'community-dialog','aria-label':title});
  const header=element('header'); header.append(element('h2',title),button('关闭',()=>dialog.close(),{'aria-label':'关闭'+title}));
  const body=element('div','',{class:'community-dialog-body'});dialog.append(header,body);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  return {dialog,body};
}
export function styles() {
  if(document.querySelector('link[data-community-controls]'))return;
  document.head.append(element('link','',{rel:'stylesheet',href:'/assets/css/community-controls.css?v=20260917-r8','data-community-controls':''}));
}
export async function policy(bootstrap, required=false) {
  const data=bootstrap || await social('policy');
  return new Promise(resolve=>{
    const {dialog,body}=sheet(required?'进入社区前，请阅读':'社区协议与行为规范');
    dialog.addEventListener('close',()=>resolve(false),{once:true});
    for(const [title,text] of [['社区用户协议',data.agreement],['社区行为规范',data.guidelines]]){
      body.append(element('h3',title),element('p',text,{class:'community-policy-text'}));
    }
    body.append(element('small','协议版本 '+data.version));
    if(!required)return;
    const label=element('label','',{class:'community-check'}), input=element('input','',{type:'checkbox'});
    label.append(input,document.createTextNode('我已阅读并同意《社区用户协议》和《社区行为规范》'));
    const accept=button('同意并进入',async()=>{await social('consent','POST',{version:data.version,agreement:true,guidelines:true});resolve(true);dialog.close();});
    accept.disabled=true;input.onchange=()=>{accept.disabled=!input.checked;};
    body.append(label,accept,button('不同意，返回',()=>dialog.close()));
  });
}
export async function authorizeCommunity() {
  if(new URLSearchParams(location.search).get('acceptance')==='local')await enableLocal();
  let data;try{data=await social('bootstrap');}catch(error){if(error.status===404||error.code===404)throw Error('社区服务暂未连接，请稍后重试或联系管理员。');throw error;}
  if(!data.available)throw Error('社区暂时维护中，请稍后再试。');
  if(data.local)mountLocalBanner();
  if(!data.consented && !await policy(data,true))return null;
  return data;
}

export function mountLocalBanner(){
  if(!localEnabled()||document.querySelector('[data-local-acceptance]'))return;
  document.body.dataset.communityLocal='true';
  styles();
  const banner=element('aside','',{'data-local-acceptance':'',class:'community-local-banner','aria-label':'本机验收模式'});
  banner.append(element('strong','本机验收 · 不上传'),button('验收选项',()=>{
    const {body}=sheet('本机交互验收');body.append(element('p','社区帖子、媒体和管理操作仅存本机，不影响线上内容与真实账号。线上分享与赛事投票不在本机验收范围。'));
    body.append(button('本机社区管理',async()=>{const view=sheet('本机社区管理 · 不影响线上账号');const {mountCommunityAdmin}=await import('/assets/js/community-admin.js?v=20260917-r8');await mountCommunityAdmin(view.body);}),button('清空验收数据',async()=>{if(await confirmAction('清空这台设备上当前账号的本机社区验收数据？线上数据不会改变。')){await resetLocal();location.reload();}}),button('退出验收',()=>{disableLocal();location.replace('/app/explore.html');}));
  }));const root=document.querySelector('[data-local-slot]')||document.querySelector('main')||document.body;root.prepend(banner);
}

// Create text nodes and verified anchors, never execute post HTML.
export async function renderCommunityText(node,content) {
  if(!node)return;
  const text=String(content||''),marker=Symbol();node._communityRender=marker;node.textContent=text;
  const ids=[...new Set([...text.matchAll(/\bID\s*[:：]\s*(\d{1,20})(?!\d)/gi)].map(m=>m[1]))].slice(0,20);
  let cards={};if(ids.length){try{cards=(await social('resolve-cards','POST',{ids})).cards||{};}catch{/* Keep readable IDs if resolution is offline. */}}
  if(node._communityRender!==marker || !node.isConnected)return;
  const fragment=document.createDocumentFragment();let start=0;
  const expression=/\bID\s*[:：]\s*(\d{1,20})(?!\d)|@\{([A-Za-z0-9_-]{1,160})\}|https:\/\/[^\s<>]+/gi;
  for(const match of text.matchAll(expression)){
    fragment.append(document.createTextNode(text.slice(start,match.index)));start=match.index+match[0].length;
    if(match[1]){
      const card=cards[match[1]];
      if(card?.status==='available'){
        const a=element('a',card.name,{href:'/app/character.html?id='+encodeURIComponent(card.internal_id),class:'community-reference'});
        a.onclick=e=>e.stopPropagation();fragment.append(a);
      }else fragment.append(element('span',match[0],{title:'角色暂不可查看'}));
    }else if(match[2]){
      const a=button('@用户',()=>openCommunityUser(match[2]),{class:'community-reference'});
      a.addEventListener('click',e=>e.stopPropagation());fragment.append(a);
      social('users/'+encodeURIComponent(match[2])).then(user=>{if(node._communityRender===marker)a.textContent='@'+user.name;}).catch(()=>{a.textContent='@不可查看的用户';a.disabled=true;});
    }else{
      const a=element('a',match[0],{href:match[0],rel:'noopener noreferrer nofollow',target:'_blank',class:'community-reference'});
      a.onclick=async e=>{e.preventDefault();e.stopPropagation();if(await confirmAction('即将打开外部网站。不要向对方提供账号密码或验证码。'))window.open(a.href,'_blank','noopener,noreferrer');};fragment.append(a);
    }
  }
  fragment.append(document.createTextNode(text.slice(start)));node.replaceChildren(fragment);
}

export async function openCommunityUser(uid) {
  location.href=String(getCachedUser()?.id)===String(uid)?'/app/community-activity.html':'/app/community-profile.html?user='+encodeURIComponent(uid);
}
function renderItems(root,items,type='posts') {
  if(!items.length){root.append(element('p','暂无内容',{class:'community-empty'}));return;}
  for(const item of items){
    const article=element('article','',{class:'community-list-row'});
    if(type==='following'||type==='followers')article.append(button(item.name,()=>openCommunityUser(item.user_id)));
    else{
      const a=element('a',item.title||item.content?.slice(0,100)||'查看内容',{href:'/app/community-post.html?id='+encodeURIComponent(item.post_id||item.id)});
      article.append(a,element('small',`${item.author||''} · ${{pending:'待审核',rejected:'未通过',published:'已发布'}[item.status]||''}`));
    }root.append(article);
  }
}
export async function mountCommunityPosts(root,scope='mine') {
  let cursor='',loading=false;root.replaceChildren();
  const list=element('section'),more=button('更多',()=>load(false));
  root.append(list,more);
  async function load(reset){
    if(loading)return;loading=true;
    try{
      const data=await social('posts?'+new URLSearchParams({scope,cursor:reset?'':cursor}));
      if(reset)list.replaceChildren();renderItems(list,data.list||[]);cursor=data.next_cursor||'';more.hidden=!data.has_more;
    }catch(error){showError(root,error);}finally{loading=false;}
  }
  await load(true);
  if(scope==='mine')root.append(element('a','继续编辑草稿',{href:'/app/community-compose.html',class:'community-reference'}));
}

export async function communitySettings() {
  const {body}=sheet('社区设置');
  body.append(button('社区协议与行为规范',()=>policy()),button('账号状态与申诉',accountStatus));
  body.append(button('我参与的评论',async()=>{const view=sheet('我参与的评论');renderItems(view.body,(await social('users/'+encodeURIComponent(getCachedUser().id)+'/comments')).list,'comments');}));
  body.append(button('社区浏览记录',async()=>{const view=sheet('社区浏览记录');view.body.append(element('small','仅本人可见，最多保留最近 200 篇。'));renderItems(view.body,(await social('history')).list);view.body.append(button('清空浏览记录',async()=>{if(!await confirmAction('清空社区浏览记录？此操作不能恢复。'))return;await social('history','DELETE');view.body.replaceChildren(element('p','浏览记录已清空'));}));}));
  body.append(button('我的举报进度',async()=>{const view=sheet('我的举报进度'),data=await social('reports');if(!data.list.length)view.body.append(element('p','暂无举报记录'));for(const report of data.list)view.body.append(element('p',`#${report.id} · ${{pending:'待处理',processing:'处理中',resolved:'已处理',ignored:'已忽略'}[report.state]}\n${report.resolution||'处理后会向你发送通知。'}`));}));
  const data=await social('preferences');
  for(const [key,label] of [['comments_public','公开我的评论'],['following_public','公开关注与粉丝'],['notifications','接收点赞和关注通知']]){
    const row=element('label','',{class:'community-check'}),input=element('input','',{type:'checkbox'});input.checked=!!data[key];
    input.onchange=async()=>{input.disabled=true;try{await social('preferences','PUT',{[key]:input.checked});}catch(error){input.checked=!input.checked;showError(body,error);}finally{input.disabled=false;}};
    row.append(input,document.createTextNode(label));body.append(row);
  }
  body.append(element('h3','已拉黑用户'));
  const blocked=await social('blocks');
  for(const user of blocked.list||[]){const row=element('p');row.append(document.createTextNode(user.name||user.target_id),button('解除拉黑',async()=>{await social('blocks','PUT',{user_id:user.target_id,blocked:false});row.remove();}));body.append(row);}
  if(!blocked.list?.length)body.append(element('p','暂无拉黑用户'));
}
export async function accountStatus() {
  const {body}=sheet('账号状态与申诉');
  const data=await social('account-status');
  if(!data.sanctions.length)body.append(element('p','当前没有社区处罚记录。'));
  for(const sanction of data.sanctions){
    const row=element('article','',{class:'community-list-row'});
    const status=sanction.revoked?'已结束':sanction.until_at && sanction.until_at<Date.now()?'已到期':sanction.until_at?'至 '+new Date(sanction.until_at).toLocaleString():'永久';
    row.append(element('strong',`${{mute:'禁言',ban:'封禁',warning:'提醒'}[sanction.kind]} · ${status}`),element('p',sanction.reason));
    const appeal=data.appeals.find(a=>a.sanction_id===sanction.id);
    if(appeal)row.append(element('p',`${{pending:'申诉待处理',accepted:'申诉通过',rejected:'申诉未通过'}[appeal.state]} ${appeal.resolution}`));
    else{
      const input=element('textarea','',{placeholder:'说明申诉原因',maxlength:2000,'aria-label':'申诉原因'});
      row.append(input,button('提交申诉',async()=>{if(!input.value.trim())throw Error('请填写申诉原因');await social('appeals','POST',{sanction_id:sanction.id,reason:input.value});row.replaceChildren(element('p','申诉已提交，处理结果将通过通知发送。'));}));
    }body.append(row);
  }
}
export async function communityNotifications(root) {
  styles();root.replaceChildren();let kind='',cursor='',serial=0;
  const tabs=element('nav','',{class:'community-tabs','aria-label':'消息分类'}),list=element('section', '', {'aria-live':'polite'}),more=button('更多消息',()=>load(false));
  for(const [key,label] of [['','全部'],['reply','回复'],['mention','提及'],['like','点赞'],['system','系统'],['report','举报'],['appeal','申诉']])tabs.append(button(label,()=>{kind=key;return load(true);},{'data-kind':key,'aria-pressed':key===kind}));
  root.append(tabs,button('全部标为已读',async()=>{await social('notifications','PUT',{all:true});await load(true);}),list,more);
  async function load(reset){
    const version=++serial;tabs.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.kind===kind));if(reset){cursor='';list.textContent='正在读取消息…';}
    try{
      const data=await social('notifications?'+new URLSearchParams({kind,cursor}));if(version!==serial)return;
      if(reset)list.replaceChildren();if(!data.list.length && reset){const empty=element('div','',{class:'community-empty'});empty.append(element('h3','暂时没有这类消息'),element('p','有新的回复或处理结果时，会在这里告诉你。'));list.append(empty);}
      for(const item of data.list){
        const row=element('article','',{class:'community-list-row'+(!item.read_at?' is-unread':'')});
        row.append(element('small',new Date(item.created_at).toLocaleString()),button(item.title,async()=>{await social('notifications','PUT',{ids:[item.id]});row.classList.remove('is-unread');if(item.post_id)location.href='/app/community.html?post='+encodeURIComponent(item.post_id);}));list.append(row);
      }cursor=data.next_cursor||'';more.hidden=!data.has_more;
    }catch(error){if(version===serial){list.replaceChildren();showError(list,error);list.append(button('重试',()=>load(true)));}}
  }await load(true);
}

// Navigation is public; authorization remains on the server, not on link visibility.
export async function installCommunityExtensions(active) {
  const owner=String(getCachedUser()?.id||'');if(!owner)return;
  const localAdmin=await canUseLocal();
  if(String(getCachedUser()?.id||'')!==owner)return;styles();
  if(localEnabled())mountLocalBanner();
  if(localEnabled())for(const a of document.querySelectorAll('[data-community-nav]')){
    a.querySelector('span').textContent='社区·验收';
  }
  if(active==='me'){
    const settings=document.querySelector('.profile-settings__body');
    if(settings && !settings.querySelector('[data-community-settings]')){
    const section=element('section','',{'data-community-settings':'',class:'community-inline'});
      section.append(element('h3','社区'),element('a','我的社区动态',{href:'/app/community-activity.html',class:'community-reference'}),element('a','社区消息',{href:'/app/community-messages.html',class:'community-reference'}),button('社区设置与行为规范',async()=>{if(await authorizeCommunity())await communitySettings();}),button('账号状态与申诉',accountStatus));
      if(localAdmin)section.append(element('a','本机交互验收（仅此设备）',{href:'/app/community.html?acceptance=local',class:'community-reference'}));
      settings.append(section);
    }
  }
  const path=location.pathname;
  if(!['/app/favorites.html','/app/my-apps.html'].includes(path))return;
  if(document.querySelector('[data-community-personal]'))return;
  const main=document.querySelector('main');if(!main)return;
  const section=element('nav','',{class:'community-inline','data-community-personal':'','aria-label':'内容分类'});
  const isSaved=path.endsWith('favorites.html');
  if(isSaved)section.append(element('a','角色卡',{href:'/app/favorites.html','aria-current':'page'}),element('a','社区帖子',{href:'/app/favorites.html?tab=community'}));
  else section.append(element('a','我的社区动态与草稿',{href:'/app/community-activity.html',class:'community-reference'}));
  const header=main.querySelector('header');if(header)header.after(section);else main.prepend(section);
}
