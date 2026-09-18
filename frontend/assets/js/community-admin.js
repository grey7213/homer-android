import {social,element,button,sheet,showError,styles} from '/app/assets/js/community-controls.js?v=20260917-r8';
import {localEnabled} from '/app/assets/js/community-local.js?v=20260917-r8';

const labels={pending:'待处理',processing:'处理中',resolved:'已处理',ignored:'已忽略',published:'已发布',rejected:'未通过',accepted:'已通过',post:'帖子',comment:'评论',mute:'禁言',ban:'封禁',warning:'提醒'};
const time=value=>value?new Date(value).toLocaleString():'长期有效';
function select(label,options,value=''){
  const row=element('label',label),control=element('select','',{'aria-label':label});
  for(const [key,text] of Object.entries(options))control.append(element('option',text,{value:key}));control.value=String(value);row.append(control);return {row,control};
}
function field(label,value='',type='text'){
  const row=element('label',label),control=element(type==='textarea'?'textarea':'input','',type==='textarea'?{}:{type});control.value=value;control.setAttribute('aria-label',label);row.append(control);return {row,control};
}
async function form(title,fields,save){
  const {dialog,body}=sheet(title),controls={};
  for(const [key,definition] of Object.entries(fields)){
    const f=definition.options?select(definition.label,definition.options,definition.value):field(definition.label,definition.value,definition.type);
    controls[key]=f.control;body.append(f.row);
  }
  body.append(button('确认保存',async()=>{await save(Object.fromEntries(Object.entries(controls).map(([key,c])=>[key,c.value])));dialog.close();}));
}
function download(name,content,type='application/json'){
  const url=URL.createObjectURL(new Blob([content],{type})),a=element('a','',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function mediaPreview(root,item){
  const safe=url=>typeof url==='string'&&(/^(https:\/\/|\/(?!\/))/.test(url)||(localEnabled()&&url.startsWith('blob:')));
  let images;try{images=Array.isArray(item.images)?item.images:JSON.parse(item.images||'[]');}catch{images=[];}
  for(const url of images){if(safe(url))root.append(element('img','',{src:url,alt:'待审核配图',loading:'lazy',referrerpolicy:'no-referrer',style:'max-width:100%;max-height:280px;object-fit:contain;margin:8px 0'}));}
  if(item.video && safe(item.video))root.append(element('video','',{src:item.video,controls:'',preload:'none',style:'width:100%;max-height:300px'}));
}
export async function mountCommunityAdmin(root){
  if(!root || root.dataset.mounted)return;styles();root.dataset.mounted='1';root.classList.add('community-admin');
  let config,tab='reports',offset=0,sequence=0,filters={};
  const nav=element('nav','',{class:'community-tabs','aria-label':'社区管理分区'}),toolbar=element('div','',{class:'community-admin-toolbar'}),status=element('p','',{role:'status'}),list=element('section'),pager=element('nav','',{class:'community-tabs'});
  root.replaceChildren(element('h2',localEnabled()?'本机社区管理 · 不上传':'社区管理'),element('p',localEnabled()?'以下操作只影响本机验收数据，不会删除线上内容或处罚真实用户。':'审核内容、处理反馈与管理账号；社区仍按服务端设置控制开放范围。'),nav,toolbar,status,list,pager);
  const tabs={reports:'举报处理',content:'内容巡查',users:'用户管理',appeals:'申诉',rules:'关键词规则',topics:'版块管理',announcements:'社区公告',stats:'数据统计',logs:'操作日志',config:'开放设置'};
  for(const [id,title] of Object.entries(tabs))nav.append(button(title,async()=>{tab=id;offset=0;filters={};await load();},{'data-tab':id}));
  try{config=await social('admin/config');await load();}catch(error){showError(root,error);root.dataset.mounted='';}
  function filter(label,key,options){
    const f=options?select(label,options,filters[key]||''):field(label,filters[key]||'');
    f.control.onchange=()=>{filters[key]=f.control.value;offset=0;load();};toolbar.append(f.row);
  }
  async function reasonAction(title,route,body={}){
    await form(title,{reason:{label:'处理原因（必填）',type:'textarea'}},async values=>{if(!values.reason.trim())throw Error('请填写原因');await social(route,'PATCH',{...body,...values});await load();});
  }
  async function editResource(resource,item={}){
    let fields;
    if(resource==='rules')fields={term:{label:'匹配关键词',value:item.term||''},category:{label:'违规类别',options:config.categories,value:item.category||Object.keys(config.categories)[0]},action:{label:'命中后处理',options:{review:'转人工审核',block:'拦截发布',warn:'提示修改'},value:item.action||'review'}};
    else if(resource==='topics')fields={name:{label:'版块名称',value:item.name||''},description:{label:'版块说明',type:'textarea',value:item.description||''},position:{label:'排序（较小的在前）',type:'number',value:item.position||0}};
    else fields={title:{label:'公告标题',value:item.title||''},content:{label:'公告正文',type:'textarea',value:item.content||''},start_at:{label:'开始时间',type:'datetime-local',value:localDate(item.start_at||Date.now())},end_at:{label:'结束时间（留空长期）',type:'datetime-local',value:item.end_at?localDate(item.end_at):''}};
    fields.enabled={label:'状态',options:{true:'启用',false:'停用'},value:item.enabled===0?'false':'true'};
    await form(item.id?'编辑':'新增',fields,async values=>{
      values.enabled=values.enabled==='true';if('position' in values)values.position=Number(values.position);
      if(resource==='announcements'){values.start_at=new Date(values.start_at).getTime();values.end_at=values.end_at?new Date(values.end_at).getTime():0;}
      await social('admin/'+resource+(item.id?'/'+item.id:''),item.id?'PATCH':'POST',values);await load();
    });
  }
  async function sanction(user){
    await form('处理用户：'+user.name,{kind:{label:'处理方式',options:{mute:'禁言（保留浏览）',warning:'警告',ban:'社区封禁'},value:'mute'},days:{label:'时长',options:{1:'1 天',3:'3 天',7:'7 天',30:'30 天',0:'永久',custom:'自定义天数'},value:'1'},custom:{label:'自定义天数（上方选择自定义时生效）',type:'number',value:1},category:{label:'违规类别',options:config.categories},reason:{label:'处理原因',type:'textarea'}},async values=>{
      values.days=Number(values.days==='custom'?values.custom:values.days);if(!Number.isInteger(values.days)||values.days<0)throw Error('请填写有效天数');
      await social('admin/sanctions','POST',{...values,user_id:user.user_id});await load();
    });
  }
  async function load(){
    const version=++sequence;status.textContent='正在读取…';list.replaceChildren();toolbar.replaceChildren();pager.replaceChildren();
    nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.tab===tab?'true':'false'));
    if(tab==='config'){
      if(config.local){status.textContent='本机验收不能更改线上开放范围。正式社区保持原有设置。';return;}
      status.textContent='当前模式：'+({internal:'内部测试',closed:'关闭',open:'对全部账号开放'}[config.mode]);
      const mode=select('开放模式',{closed:'关闭',internal:'内部测试',open:'公开'},config.mode),testers=field('测试账号内部 ID（每行一个）',config.testers.join('\n'),'textarea');
      list.append(mode.row,testers.row,button('保存开放设置',async()=>{
        await form('确认开放配置',{reason:{label:'调整原因',type:'textarea'}},async values=>{config=await social('admin/config','PUT',{mode:mode.control.value,testers:testers.control.value.split(/\s+/).filter(Boolean),reason:values.reason});await load();});
      }),element('a','进入内部测试社区',{href:'/app/community.html',class:'community-reference'}));return;
    }
    if(['reports','rules'].includes(tab))filter('违规类别','category',{'':'全部类别',...config.categories});
    if(tab==='reports')filter('处理状态','state',{'':'全部',pending:'待处理',processing:'处理中',resolved:'已处理',ignored:'已忽略'});
    if(tab==='content'){filter('内容类型','type',{post:'帖子',comment:'评论'});filter('审核状态','status',{'':'全部',pending:'待审核',published:'已发布',rejected:'未通过'});filter('作者内部 ID','user_id');filter('关键词','q');filter('版块','topic');}
    if(tab==='users')filter('搜索昵称或内部 ID','q');
    if(tab==='logs'){filter('操作人内部 ID','actor');filter('操作类型','action');toolbar.append(button('导出当前筛选日志',async()=>{const data=await social('admin/logs?'+new URLSearchParams({...filters,export:'csv',limit:100,offset}));download('社区操作日志.csv','\ufeff'+data.csv,'text/csv;charset=utf-8');}));}
    if(['rules','topics','announcements'].includes(tab))toolbar.append(button('新增',()=>editResource(tab)));
    if(tab==='rules'){
      toolbar.append(button('导出词库',async()=>download('社区关键词规则.json',JSON.stringify((await social('admin/rules')).list,null,2))));
      const upload=element('input','',{type:'file',accept:'application/json','aria-label':'导入词库 JSON'});
      upload.onchange=async()=>{try{const file=upload.files[0];if(!file)return;if(file.size>1024*1024)throw Error('词库文件不能超过 1 MB');const rules=JSON.parse(await file.text());if(!Array.isArray(rules)||rules.length>1000)throw Error('最多导入 1000 条规则');const result=await social('admin/rules/import','POST',{rules});status.textContent='已导入 '+result.count+' 条规则';await load();}catch(error){showError(root,error);}finally{upload.value='';}};toolbar.append(upload);
    }
    toolbar.append(button('刷新',load));
    try{
      const data=await social('admin/'+tab+'?'+new URLSearchParams({...filters,offset,limit:40}));if(version!==sequence)return;
      status.textContent='';
      if(tab==='stats'){renderStats(data);return;}
      let items=data.list||[];if(tab==='rules'&&filters.category)items=items.filter(r=>r.category===filters.category);
      if(!items.length)list.append(element('p','当前筛选下暂无记录',{class:'community-empty'}));
      for(const item of items)renderRow(item);
      if(!['rules','topics','announcements'].includes(tab))pager.append(button('上一页',()=>{offset=Math.max(0,offset-40);return load();},{disabled:offset===0?true:undefined}),element('span','第 '+(offset/40+1)+' 页'),button('下一页',()=>{offset+=40;return load();},{disabled:items.length<40?true:undefined}));
    }catch(error){if(version===sequence){status.textContent='读取失败';showError(list,error);}}
  }
  function renderRow(item){
    const row=element('article','',{class:'community-list-row'});list.append(row);
    if(tab==='reports'){
      row.append(element('h3',`${config.categories[item.category]||'历史举报（待分类）'} · ${labels[item.state]}`),element('p',`举报人 ${item.reporter} · ${time(item.created_at)}`),element('p',item.reason||'未补充说明'));
      const detail=element('details');detail.append(element('summary','原内容与上下文'),element('p',item.snapshot.content),element('p',item.post?.content||item.context?.content||''));mediaPreview(detail,item.snapshot);row.append(detail);
      if(['pending','processing'].includes(item.state))for(const [action,title] of [['claim','领取处理'],['delete','删除内容'],['ignore','忽略举报']])row.append(button(title,()=>reasonAction(title,'admin/reports/'+item.id,{action})));
      row.append(button('处理被举报用户',()=>sanction({user_id:item.snapshot.user_id,name:item.snapshot.author})));if(item.resolution)row.append(element('p',item.resolution));
    }else if(tab==='content'){
      const type=filters.type||'post';row.append(element('h3',(item.title||item.author)+' · '+(item.deleted?'已删除':labels[item.status])),element('p',item.content),element('small',`${item.user_id} · ${time(item.created_at)}`));
      mediaPreview(row,item);
      if(item.pending_versions?.length){const detail=element('details');detail.append(element('summary','待审修改版本'));for(const v of item.pending_versions){let draft;try{draft=JSON.parse(v.data);}catch{draft={content:'无法解析'};}detail.append(element('p','版本 '+v.version+'\n'+draft.title+'\n'+draft.content));}row.append(detail);}
      for(const [action,title] of [['approve','审核通过'],['reject','驳回'],[item.deleted?'restore':'delete',item.deleted?'恢复内容':'删除内容']])row.append(button(title,()=>reasonAction(title,'admin/content/'+type+'/'+item.id,{action,version:item.version})));
      if(type==='post')for(const [key,title] of [['pinned','置顶'],['featured','精华'],['locked','关闭评论']])row.append(button((item[key]?'取消':'设为')+title,()=>reasonAction(title,'admin/content/post/'+item.id,{action:key,enabled:!item[key]})));
    }else if(tab==='users'){
      row.append(element('h3',item.name),element('small',item.user_id),button('警告 / 禁言 / 封禁',()=>sanction(item)));
      const history=element('details');history.append(element('summary','近期发言与处罚记录'));
      for(const post of item.recent_posts)history.append(element('p',post.title+'\n'+post.content));
      for(const s of item.sanctions){const p=element('p',`${labels[s.kind]} · ${s.reason} · ${s.revoked?'已解除':time(s.until_at)}`);if(!s.revoked)p.append(button('解除限制',()=>form('解除限制',{reason:{label:'解除原因',type:'textarea'}},async values=>{await social('admin/sanctions/'+s.id+'/revoke','POST',values);await load();})));history.append(p);}row.append(history);
    }else if(tab==='appeals'){
      row.append(element('h3','申诉 #'+item.id+' · '+(labels[item.state]||item.state)),element('p',item.user_id+'\n'+item.reason));
      if(item.state==='pending')for(const [state,title] of [['accepted','通过并解除限制'],['rejected','驳回申诉']])row.append(button(title,()=>reasonAction(title,'admin/appeals/'+item.id,{state})));
      if(item.resolution)row.append(element('p',item.resolution));
    }else if(['rules','topics','announcements'].includes(tab)){
      row.append(element('h3',item.term||item.name||item.title),element('p',tab==='rules'?`${config.categories[item.category]||'已停用类别'} · ${{review:'转审核',block:'拦截',warn:'提示'}[item.action]}`:item.description||item.content),element('small',item.enabled?'已启用':'已停用'),button('编辑',()=>editResource(tab,item)),button('删除',()=>form('确认删除',{reason:{label:'删除原因',type:'textarea'}},async values=>{await social('admin/'+tab+'/'+item.id,'DELETE',values);await load();})));
    }else if(tab==='logs'){
      row.append(element('strong',`${item.actor} · ${item.action}`),element('p',`${item.object_type} #${item.object_id}\n${item.reason}`),element('small',time(item.created_at)));
    }
  }
  function renderStats(data){
    list.append(element('h3','当前禁言用户：'+data.muted));
    for(const [key,title] of [['activity','最近 30 日活跃用户'],['posts','帖子量'],['comments','评论量'],['reports','举报处理'],['violations','已确认违规类型']]){
      const section=element('section');section.append(element('h3',title));const rows=data[key]||[],max=Math.max(1,...rows.map(r=>r.users||r.count||0));
      for(const r of rows){const n=r.users||r.count||0;const label=r.day||config.categories[r.category]||labels[r.status||r.state]||'其他',row=element('div','',{class:'community-stat'}),meter=element('meter','',{min:0,max,value:n,'aria-label':label});row.append(element('span',label),meter,element('strong',n));section.append(row);}list.append(section);
    }
  }
}
function localDate(value){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
