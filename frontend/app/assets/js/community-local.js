// Explicit debug-only acceptance data. No request in this module writes to a server.
import {api as accountApi,getCachedUser} from '/assets/js/api.js?v=20260917-r8';
const PREFIX='homer.community.acceptance.v1.';
const categories={politics:'政治敏感',conflict:'引战／带节奏',attack:'人身攻击',spam:'广告 spam',rumour:'造谣传谣',privacy:'侵犯隐私',illegal:'违法违规',noise:'恶意灌水',flood:'刷屏',diversion:'恶意引流',impersonation:'冒充官方',phishing:'钓鱼链接'};
const topics=['交流闲聊','角色故事','创作交流','攻略分享','意见反馈'];
const policy={version:'local-2026-09-16',agreement:'本机交互验收模式\n这里的帖子、评论、举报和管理操作只存储在本机，不会上传，不会处罚真实账号。退出模式后返回真实服务。\n社区用户协议\n请确保有权发布内容，不冒充他人、不泄露隐私。禁止政治敏感、引战／带节奏、人身攻击、广告 spam、造谣传谣、侵犯隐私、违法违规、恶意灌水、刷屏、恶意引流、冒充官方和钓鱼链接。可对处理结果申诉。',guidelines:'社区行为规范\n讨论作品，尊重不同意见；不以举报人数直接处罚。审核结合上下文，区分虚构创作和现实攻击。限制应说明原因及期限；禁言仅影响社区互动，不影响其他功能。',categories};
let accessOwner='',accessPromise,dbPromise,queue=Promise.resolve(),localSession=false;const urls=new Map();
window.addEventListener('homer-account-cleared',()=>{accessOwner='';accessPromise=null;for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();});
const owner=()=>String(getCachedUser()?.id||'');
export function debugBuild(){try{return window.HomerNative?.isDebugBuild()===true;}catch{return false;}}
export function localEnabled(){try{return debugBuild()&&!!owner()&&localStorage.getItem(PREFIX+owner())==='on';}catch{return false;}}
// A page which entered local mode must never fall back to remote writes after another tab exits.
export function routeLocally(){if(localEnabled())localSession=true;return debugBuild()&&localSession;}
export async function canUseLocal(){
  if(!debugBuild()||!owner())return false;
  const id=owner();if(accessOwner!==id){accessOwner=id;accessPromise=null;}
  if(!accessPromise)accessPromise=accountApi.profile().then(result=>{
    const user=result?.data??result;
    return owner()===id&&String(user?.id||'')===id&&(user.is_admin===true||user.is_env_admin===true||user.role==='admin');
  }).catch(()=>false);
  return accessPromise;
}
export async function enableLocal(){if(!await canUseLocal())throw Error('本机验收仅供 debug 包中的管理员使用');localStorage.setItem(PREFIX+owner(),'on');}
export function disableLocal(){localStorage.removeItem(PREFIX+owner());}
function database(){return dbPromise ||= new Promise((resolve,reject)=>{const req=indexedDB.open('homer-community-acceptance',1);req.onupgradeneeded=()=>req.result.createObjectStore('accounts');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(Error('本机验收存储不可用'));});}
async function read(id){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('accounts'),request=tx.objectStore('accounts').get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('读取本机验收数据失败'));});}
async function write(id,value){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('accounts','readwrite');tx.objectStore('accounts').put(value,id);tx.oncomplete=resolve;tx.onerror=()=>reject(Error('本机空间不足，操作未保存'));tx.onabort=()=>reject(Error('本机保存被中断'));});}
function seed(uid){
  const now=Date.now();return {next:100,consent:false,posts:[{id:'1',user_id:'acceptance-author',author:'验收示例作者',title:'试试发帖、回复和举报',content:'这是本机示例帖子，不是线上内容。可以点赞、收藏、回复，或提交举报后进入本机管理后台处理。',topic:topics[0],images:[],video:'',tags:[],created_at:now,status:'published',version:1},{id:'2',user_id:uid,author:getCachedUser()?.name||'管理员',title:'这篇帖子可以编辑或删除',content:'自己的帖子支持编辑、删除；重新打开软件后，本机验收数据仍会保留。',topic:topics[2],images:[],video:'',tags:[],created_at:now-1000,status:'published',version:1}],comments:[],likes:[],saves:[],follows:[],blocks:[],reports:[],rules:[],notices:[],sanctions:[],appeals:[],logs:[],media:[],history:[],topics:topics.map((name,i)=>({id:i+1,name,enabled:1,position:i,description:''})),announcements:[],preferences:{comments_public:true,following_public:true,notifications:true,bio:''}};
}
function serialized(work){const run=()=>navigator.locks?navigator.locks.request('homer-community-acceptance-'+owner(),work):work();const result=queue.then(run,run);queue=result.catch(()=>{});return result;}
export async function resetLocal(){if(!await canUseLocal())throw Error('无本机验收权限');const uid=owner();await serialized(()=>write(uid,seed(uid)));for(const key of Object.keys(localStorage))if(key.startsWith('homer.page-cache.v1.local-acceptance-')&&key.endsWith('.'+uid))localStorage.removeItem(key);for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();}
export function storeLocalDraft(draft){return {...draft,images:(draft.images||[]).map(storedMedia),video:storedMedia(draft.video||'')};}
export async function hydrateLocalDraft(draft){if(!localEnabled())return draft;const s=await read(owner())||seed(owner());return {...draft,images:(draft.images||[]).map(v=>mediaURL(s,v)),video:mediaURL(s,draft.video||'')};}
export async function addLocalMedia(file){
  if(!localEnabled()||!await canUseLocal())throw Error('未进入本机验收');
  const limit=file.type==='video/mp4'?100*1024*1024:8*1024*1024;
  if(!['image/png','image/jpeg','image/webp','video/mp4'].includes(file.type)||file.size>limit)throw Error('媒体类型或大小不符合要求');
  return serialized(async()=>{const uid=owner(),s=await read(uid)||seed(uid),id=crypto.randomUUID();s.media.push({id,blob:file});await write(uid,s);return mediaURL(s,'acceptance-media:'+id);});
}
function mediaURL(s,value){if(!value?.startsWith('acceptance-media:'))return value;const id=value.slice(17),file=s.media.find(m=>m.id===id);if(!file)return '';if(!urls.has(id))urls.set(id,URL.createObjectURL(file.blob));return urls.get(id);}
function storedMedia(value){for(const [id,url] of urls)if(url===value)return 'acceptance-media:'+id;return value;}
function reject(message,status=400){const error=Error(message);error.status=status;throw error;}
export function handleLocal(path,options={}){
  return serialized(async()=>{
    if(!localEnabled()||!await canUseLocal())reject('本机验收不可用',403);
    const uid=owner(),s=await read(uid)||seed(uid),url=new URL(path,'https://local.invalid/'),route=url.pathname.slice(1),q=url.searchParams,method=options.method||'GET',b=JSON.parse(JSON.stringify(options.body||{})),now=Date.now();
    const freshId=()=>String(s.next++),members=[{user_id:uid,name:getCachedUser()?.name||'管理员'},{user_id:'acceptance-author',name:'验收示例作者'}];
    const activeSanctions=s.sanctions.filter(x=>x.user_id===uid&&!x.revoked&&(!x.until_at||x.until_at>now)&&x.kind!=='warning');
    const interactive=()=>{if(activeSanctions.length)reject('本机验收账号处于禁言状态，可在本机后台解除',403);};
    const visible=p=>p&&!p.deleted&&!s.blocks.includes(p.user_id)&&(p.status==='published'||p.user_id===uid);
    const post=id=>{const p=s.posts.find(p=>p.id===String(id));if(!visible(p))reject('内容不存在或暂不可查看',404);return p;};
    const payload=p=>({...p,images:(p.images||[]).map(u=>mediaURL(s,u)),video:mediaURL(s,p.video||''),liked:s.likes.includes(p.id),saved:s.saves.includes(p.id),following:s.follows.includes(p.user_id),is_owner:p.user_id===uid,can_delete:true,like_count:s.likes.includes(p.id)?1:0,save_count:s.saves.includes(p.id)?1:0,comment_count:s.comments.filter(c=>c.post_id===p.id&&!c.deleted&&c.status==='published').length});
    const commentPayload=c=>({...c,images:(c.images||[]).map(u=>mediaURL(s,u)),can_delete:true,like_count:c.liked?1:0,reply_count:s.comments.filter(x=>x.root_id===c.id&&!x.deleted).length});
    const notify=(kind,title,post_id='')=>s.notices.unshift({id:freshId(),kind,title,post_id,created_at:now,read_at:0});
    const audit=(action,object_type,object_id,reason)=>s.logs.unshift({id:freshId(),actor:uid,action,object_type,object_id,reason,created_at:now});
    const verdict=content=>{const matches=s.rules.filter(r=>r.enabled!==false&&r.enabled!==0&&content.includes(r.term));return {status:matches.some(r=>r.action==='block')?'rejected':matches.some(r=>r.action==='review')?'pending':'published',matches};};
    const contentData=()=>{const content=String(b.content||'').trim(),title=String(b.title||'');if(!content&&!b.images?.length&&!b.video)reject('请填写内容');if(content.length>10000||title.length>80)reject('内容过长');const status=verdict(title+'\n'+content).status;if(status==='rejected')reject('内容未通过本机规则检查',422);return {content,title,topic:b.topic||topics[0],tags:b.tags||[],images:(b.images||[]).map(storedMedia),video:storedMedia(b.video||''),status};};
    let result,match;
    if(route==='bootstrap')result={...policy,available:true,consented:s.consent,mode:'local',is_admin:true,media:true,sanctions:activeSanctions,local:true};
    else if(route==='policy')result=policy;
    else if(route==='consent'){if(!b.agreement||!b.guidelines||b.version!==policy.version)reject('请确认本机验收协议');s.consent=true;result={accepted:true};}
    else if(route==='preflight')result=verdict(b.content||'');
    else if(route==='topics')result={list:s.topics.filter(t=>t.enabled).map(t=>t.name)};
    else if(route==='announcements')result={list:s.announcements.filter(t=>t.enabled)};
    else if(route==='resolve-cards'){
      let cards=[];try{const cache=JSON.parse(localStorage.getItem('homer.page-cache.v1.explore.'+uid)||'null');cards=[...(cache?.value?.cards||[]),...(cache?.value?.featuredPool||[])];}catch{}
      result={cards:Object.fromEntries((b.ids||[]).map(id=>{const card=cards.find(c=>String(c.displayId||c.display_id||c.id)===id);return [id,card?{status:'available',internal_id:String(card.id),name:card.name}:{status:'unavailable'}];}))};
    }else if(route==='posts'&&method==='GET'){
      let rows=s.posts.filter(visible);const scope=q.get('scope'),search=q.get('q')||'';
      if(scope==='mine')rows=rows.filter(p=>p.user_id===uid);else rows=rows.filter(p=>p.status==='published');
      if(scope==='saved')rows=rows.filter(p=>s.saves.includes(p.id));if(scope==='following')rows=rows.filter(p=>s.follows.includes(p.user_id));
      if(q.get('author'))rows=rows.filter(p=>p.user_id===q.get('author'));if(q.get('topic'))rows=rows.filter(p=>p.topic===q.get('topic'));
      rows=rows.filter(p=>(p.title+p.content).includes(search));if(q.get('sort')==='featured')rows=rows.filter(p=>p.featured);
      rows.sort((a,b)=>(!!b.pinned-!!a.pinned)||(q.get('sort')==='hot'?(+s.likes.includes(b.id)-+s.likes.includes(a.id)):0)||b.created_at-a.created_at);
      const offset=Number(q.get('cursor')||0);result={list:rows.slice(offset,offset+20).map(payload),has_more:rows.length>offset+20,next_cursor:String(offset+20)};
    }else if(route==='posts'&&method==='POST'){
      interactive();let p=s.posts.find(p=>p.client_id===b.client_id&&p.user_id===uid);if(!p){p={...contentData(),id:freshId(),user_id:uid,author:members[0].name,created_at:now,version:1,client_id:b.client_id};s.posts.unshift(p);}result=payload(p);
    }else if((match=route.match(/^posts\/(\d+)(?:\/(comments|like|save|report))?$/))){
      const p=post(match[1]),action=match[2];
      if(!action){if(method==='DELETE'){p.deleted=true;audit('delete','post',p.id,'本机作者删除');result={deleted:true};}else if(method==='PATCH'){interactive();if(p.user_id!==uid)reject('不能编辑他人帖子');if(p.version!==b.version)reject('版本已更新',409);Object.assign(p,contentData(),{version:p.version+1});result=payload(p);}else{s.history=[p.id,...s.history.filter(id=>id!==p.id)].slice(0,200);result=payload(p);}}
      else if(action==='comments'){
        if(method==='POST'){interactive();if(p.locked)reject('评论已关闭');let c=s.comments.find(c=>c.client_id===b.client_id);if(!c){const parent=s.comments.find(c=>c.id===String(b.parent_id));if(parent&&parent.post_id!==p.id)reject('回复目标无效');c={...contentData(),id:freshId(),post_id:p.id,user_id:uid,author:members[0].name,created_at:now,parent_id:parent?.id||0,root_id:parent?(parent.root_id||parent.id):0,client_id:b.client_id};s.comments.push(c);}result=commentPayload(c);}
        else{const root=String(q.get('root')||0),page=Math.max(1,Number(q.get('page')||1));let rows=s.comments.filter(c=>c.post_id===p.id&&!c.deleted&&String(c.root_id)===root);if(q.get('author_only')==='1')rows=rows.filter(c=>c.user_id===p.user_id);if(q.get('sort')==='latest')rows.reverse();result={list:rows.slice((page-1)*20,page*20).map(commentPayload),pages:Math.max(1,Math.ceil(rows.length/20)),page,snapshot:now,has_more:rows.length>page*20};}
      }else if(action==='report')result=report('post',p);
      else{if(action==='like')interactive();const key=action==='like'?'likes':'saves',desired=action==='like'?b.liked:b.saved;s[key]=s[key].filter(id=>id!==p.id);if(desired)s[key].push(p.id);result=payload(p);}
    }else if((match=route.match(/^comments\/(\d+)(?:\/(report|like))?$/))){
      const c=s.comments.find(c=>c.id===match[1]&&!c.deleted);if(!c)reject('评论不存在',404);post(c.post_id);
      if(match[2]==='report')result=report('comment',c);else if(match[2]==='like'){interactive();c.liked=!!b.liked;result=commentPayload(c);}else{c.deleted=true;result={deleted:true};}
    }else if(route==='follow'){interactive();s.follows=s.follows.filter(id=>id!==b.user_id);if(b.following)s.follows.push(b.user_id);result={following:!!b.following};}
    else if(route==='blocks'){if(method==='GET')result={list:s.blocks.map(id=>({target_id:id,name:members.find(m=>m.user_id===id)?.name||id}))};else{s.blocks=s.blocks.filter(id=>id!==b.user_id);if(b.blocked)s.blocks.push(b.user_id);result={blocked:!!b.blocked};}}
    else if(route==='preferences'){if(method==='PUT')Object.assign(s.preferences,b);result=s.preferences;}
    else if(route==='history'){if(method==='DELETE')s.history=[];result={list:s.history.map(id=>s.posts.find(p=>p.id===id)).filter(visible).map(payload)};}
    else if(route==='account-status')result={sanctions:s.sanctions.filter(x=>x.user_id===uid),appeals:s.appeals.filter(x=>x.user_id===uid)};
    else if(route==='appeals'){s.appeals.push({...b,id:freshId(),user_id:uid,state:'pending',created_at:now});result={submitted:true};}
    else if(route==='reports')result={list:s.reports};
    else if(route==='notifications'){if(method==='PUT')s.notices.forEach(n=>{if(b.all||b.ids?.map(String).includes(n.id))n.read_at=now;});if(method==='DELETE')s.notices=s.notices.filter(n=>!b.ids?.map(String).includes(n.id));result={list:s.notices.filter(n=>!q.get('kind')||n.kind===q.get('kind')),unread:s.notices.filter(n=>!n.read_at).length,has_more:false};}
    else if(route==='search'){const term=q.get('q')||'';result={list:q.get('type')==='topics'?s.topics.filter(t=>t.name.includes(term)):members.filter(m=>!s.blocks.includes(m.user_id)&&m.name.includes(term))};}
    else if((match=route.match(/^users\/([^/]+)(?:\/(comments|following|followers))?$/))){
      const member=members.find(m=>m.user_id===match[1]);if(!member||s.blocks.includes(match[1]))reject('用户暂不可查看',404);
      result=match[2]?{list:match[2]==='comments'?s.comments.filter(c=>c.user_id===member.user_id&&!c.deleted).map(commentPayload):members.filter(m=>s.follows.includes(m.user_id))}:{...member,bio:'本机验收资料',badge:'验收示例',posts:s.posts.filter(p=>p.user_id===member.user_id&&!p.deleted).length,likes:0,following_count:s.follows.length,followers_count:0,following:s.follows.includes(member.user_id)};
    }else if(route.startsWith('admin/'))result=admin(route.slice(6));
    else reject('本机验收暂不支持该操作：'+route,404);
    if(owner()!==uid||!localEnabled())reject('账号已切换，本次操作未保存',409);
    await write(uid,s);return {code:0,data:result};

    function report(type,object){if(!categories[b.category])reject('请选择违规类型');let r=s.reports.find(r=>r.object_type===type&&r.object_id===object.id);const duplicate=!!r;if(!r){r={id:freshId(),object_type:type,object_id:object.id,reporter:uid,category:b.category,reason:b.reason||'',snapshot:{...object},context:{...object},state:'pending',created_at:now};s.reports.unshift(r);}return {reported:true,id:r.id,duplicate};}
    function admin(action){
      if(action==='config')return {mode:'internal',testers:[],categories,version:policy.version,local:true};
      if(action==='stats')return {activity:[{day:new Date(now).toISOString().slice(0,10),users:1}],posts:[{status:'published',count:s.posts.filter(p=>!p.deleted).length}],comments:[{status:'published',count:s.comments.filter(c=>!c.deleted).length}],reports:['pending','resolved','ignored'].map(state=>({state,count:s.reports.filter(r=>r.state===state).length})),violations:[],muted:s.sanctions.filter(x=>!x.revoked&&x.kind==='mute').length};
      if(action==='users')return {list:members.filter(m=>m.name.includes(q.get('q')||'')||m.user_id.includes(q.get('q')||'')).map(m=>({...m,sanctions:s.sanctions.filter(x=>x.user_id===m.user_id),recent_posts:s.posts.filter(p=>p.user_id===m.user_id)}))};
      if(action==='content'){const type=q.get('type')==='comment'?'comments':'posts';return {list:s[type].filter(x=>(!q.get('status')||x.status===q.get('status'))&&(!q.get('q')||x.content.includes(q.get('q')))).map(x=>({...x,images:JSON.stringify((x.images||[]).map(v=>mediaURL(s,v))),pending_versions:[]}))};}
      if(action==='logs'){if(q.get('export')==='csv')return {csv:'操作,原因\n'+s.logs.map(x=>[x.action,x.reason].map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n')};return {list:s.logs};}
      if(action==='rules/import'){for(const rule of b.rules||[]){if(!categories[rule.category])reject('规则类别不正确');s.rules.push({...rule,id:freshId(),enabled:true});}return {count:b.rules?.length||0};}
      if(action==='sanctions'&&method==='POST'){if(!b.reason?.trim()||!categories[b.category])reject('请填写原因和违规类型');const record={...b,id:freshId(),created_at:now,until_at:Number(b.days)?now+Number(b.days)*86400000:0,revoked:0};s.sanctions.push(record);audit('sanction','user',b.user_id,b.reason);notify('system','本机账号处理：'+b.reason);return {id:record.id};}
      let a;
      if((a=action.match(/^sanctions\/(\d+)\/revoke$/))){const record=s.sanctions.find(x=>x.id===a[1]);if(record)record.revoked=1;audit('revoke','user',a[1],b.reason);return {revoked:true};}
      if((a=action.match(/^content\/(post|comment)\/(\d+)$/))){const row=(a[1]==='post'?s.posts:s.comments).find(x=>x.id===a[2]);if(!row)reject('内容不存在');if(!b.reason?.trim())reject('请填写原因');if(b.action==='delete')row.deleted=true;else if(b.action==='restore'){row.deleted=false;row.status='published';}else if(['approve','reject'].includes(b.action))row.status=b.action==='approve'?'published':'rejected';else row[b.action]=!!b.enabled;audit(b.action,a[1],row.id,b.reason);notify('system','本机内容处理：'+b.reason);return {updated:true};}
      if((a=action.match(/^(reports|rules|topics|announcements|appeals)(?:\/(\d+))?$/))){
        const key=a[1];if(method==='GET')return {list:s[key].filter(x=>(!q.get('state')||x.state===q.get('state'))&&(!q.get('category')||x.category===q.get('category')))};
        const row=s[key].find(x=>String(x.id)===a[2]);if(method==='DELETE'){s[key]=s[key].filter(x=>String(x.id)!==a[2]);return {deleted:true};}
        if(key==='reports'&&row){if(!b.reason?.trim())reject('请填写原因');row.state={delete:'resolved',ignore:'ignored',claim:'processing'}[b.action];row.resolution=b.reason;if(b.action==='delete'){const content=(row.object_type==='post'?s.posts:s.comments).find(x=>x.id===row.object_id);if(content)content.deleted=true;}notify('report','本机举报处理结果：'+b.reason);audit(b.action,'report',row.id,b.reason);return row;}
        if(key==='appeals'&&row){Object.assign(row,{state:b.state,resolution:b.reason});if(b.state==='accepted'){const sanction=s.sanctions.find(x=>x.id===String(row.sanction_id));if(sanction)sanction.revoked=1;}notify('appeal','本机申诉结果：'+b.reason);return row;}
        if(key==='rules'&&(!categories[b.category]||!b.term?.trim()))reject('请检查关键词与分类');
        if(row)Object.assign(row,b);else s[key].unshift({...b,id:freshId()});audit('update',key,a[2]||'',b.reason||'本机配置调整');return {saved:true};
      }
      reject('本机管理操作暂不支持',404);
    }
  });
}
