// Each principal community workflow has its own document URL and navigation history.
import {socialPage} from './community-feed.js?v=20260917-r8';
import {api,requireAuth,getCachedUser} from './app-core.js?v=20260917-r8';
import {injectLayout} from './layout.js?v=20260917-r8';
import {social,authorizeCommunity,communityNotifications,communitySettings,element,button,sheet} from './community-controls.js?v=20260917-r8';
import {localEnabled,routeLocally,storeLocalDraft,hydrateLocalDraft} from './community-local.js?v=20260917-r8';
import {readPageCache,writePageCache} from './page-cache.js';
import {confirmAction} from '/assets/js/dialogs.js?v=20260917-r8';
import {screenHTML} from './community-templates.js?v=20260917-r8';

const params=new URLSearchParams(location.search);
const pages={'community.html':'home','community-search.html':'search','community-post.html':'post','community-compose.html':'compose','community-activity.html':'activity','community-profile.html':'profile','community-messages.html':'messages','favorites.html':'saved'};
const page=pages[location.pathname.split('/').pop()]||'home';
const titles={home:'社区',search:'搜索',post:'帖子详情',compose:'发布帖子',activity:'我的动态',profile:'作者主页',messages:'社区消息',saved:'我的收藏'};
const draftKey=id=>(routeLocally()?'local-acceptance-':'')+'social-draft'+(id?'-edit-'+id:'');
const stateKey=()=>`homer.community.navigation.${getCachedUser()?.id||''}.${localEnabled()?'local':'live'}.${location.pathname}${location.search}`;
const postURL=id=>'/app/community-post.html?id='+encodeURIComponent(id);

window.communityScreen=()=>{
  const base=socialPage();let searchedVersion=0,saveTimer,position=0;
  return {...base,page,title:titles[page],profile:null,profileId:params.get('user')||'',activityTab:params.get('tab')||'posts',activityItems:[],profileTab:'posts',searched:false,recent:[],draftSaved:false,emojiOpen:false,attachmentsOpen:false,
    postURL,settings:communitySettings,
    async init(){
      if(!requireAuth())return;
      this.user=getCachedUser();if(page==='home')injectLayout('community');
      window.addEventListener('pagehide',()=>{this.remember();this.saveDraft();});
      window.addEventListener('homer-account-cleared',()=>{location.replace('/app/login.html');});
      window.addEventListener('pageshow',e=>{if(e.persisted){this.enter(true);}});
      // A small visualViewport correction keeps the reply bar above the soft keyboard.
      const viewport=()=>{const v=window.visualViewport;document.documentElement.style.setProperty('--community-keyboard',Math.max(0,innerHeight-(v?.height||innerHeight)-(v?.offsetTop||0))+'px');};
      window.visualViewport?.addEventListener('resize',viewport);viewport();
      await this.enter();
      this.$watch('draft',()=>{if(page==='compose'){clearTimeout(saveTimer);this.draftSaved=false;saveTimer=setTimeout(()=>this.saveDraft(),200);}});
    },
    async enter(refresh=false){
      this.gateLoading=true;this.gateError='';
      try{
        const access=await authorizeCommunity();if(!access){location.replace('/app/explore.html');return;}
        this.localMode=!!access.local;this.categories=access.categories;this.muted=access.sanctions?.some(s=>['mute','ban'].includes(s.kind));this.mediaAvailable=!!access.media;
        this.ready=true;document.title=this.title+' · 惑梦';
        if(!refresh){try{const state=JSON.parse(sessionStorage.getItem(stateKey())||'null');if(state){for(const key of ['scope','sort','topic','query','searchType','searched'])if(key in state)this[key]=state[key];position=state.scroll||0;}}catch{}}
        if(page==='home'){
          this.topics=(await social('topics')).list;this.announcements=(await social('announcements')).list;await this.load(true);
        }else if(page==='search'){
          this.topics=(await social('topics')).list;this.query=params.get('q')||this.query;this.recent=readPageCache('community-recent',this.user)?.items||[];
          if(this.query)await this.searchAll();
        }else if(page==='post'){
          const id=params.get('id');if(!id)throw Error('缺少帖子编号，请返回社区重新选择');
          this.detail=this.updatePost(await social('posts/'+encodeURIComponent(id)));this.commentClientId=crypto.randomUUID();await this.loadComments(true);
        }else if(page==='compose'){
          this.editingId=params.get('edit')||'';this.title=this.editingId?'编辑帖子':'发布帖子';this.topics=(await social('topics')).list;
          const saved=readPageCache(draftKey(this.editingId),this.user,{maxAgeMs:365*86400000})?.draft;
          if(saved)this.draft={...this.draft,...await hydrateLocalDraft(saved)};
          else if(this.editingId){const p=await social('posts/'+encodeURIComponent(this.editingId));if(!p.is_owner)throw Error('只能编辑自己的帖子');Object.assign(this.draft,p.pending_edit||p,{client_id:crypto.randomUUID()});}
        }else if(page==='saved'){this.scope='saved';await this.load(true);}
        else if(page==='activity'){await this.loadActivity();}
        else if(page==='profile'){this.profile=await social('users/'+encodeURIComponent(this.profileId));await this.load(true);}
        else if(page==='messages'){await communityNotifications(this.$refs.messages);}
        if(position)requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo(0,position)));
      }catch(error){this.gateError=error.message||'暂时无法打开，请重试';this.ready=false;}finally{this.gateLoading=false;}
    },
    retry(){return page==='search'?this.searchAll():page==='activity'?this.loadActivity():page==='profile'?this.profileView(this.profileTab):this.load(true);},
    remember(){try{sessionStorage.setItem(stateKey(),JSON.stringify({scope:this.scope,sort:this.sort,topic:this.topic,query:this.query,searchType:this.searchType,searched:this.searched,scroll:scrollY}));}catch{}},
    go(url){this.remember();this.saveDraft();location.href=url;},
    back(){this.saveDraft();if(document.referrer.startsWith(location.origin+'/app/')&&history.length>1)history.back();else location.replace('/app/community.html');},
    openPost(post){this.go(postURL(post.id));},
    openEditor(post=null){if(this.muted){this.notify('当前处于禁言状态，暂不能发布');return;}this.go('/app/community-compose.html'+(post?'?edit='+encodeURIComponent(post.id):''));},
    openUser(id){this.go(String(id)===String(this.user.id)?'/app/community-activity.html':'/app/community-profile.html?user='+encodeURIComponent(id));},
    saveDraft(){if(page!=='compose'||!this.ready||this.publishing)return;const draft=localEnabled()?storeLocalDraft(this.draft):this.draft;this.draftSaved=writePageCache(draftKey(this.editingId),this.user,{draft});if(!this.draftSaved)this.editorError='草稿保存失败，请勿关闭页面';},
    closeEditor(){this.saveDraft();this.back();},
    async publish(){
      if(this.publishing||this.uploading||this.muted||!this.draft.content.trim())return;
      this.publishing=true;this.editorError='';
      try{const post=await social(this.editingId?'posts/'+encodeURIComponent(this.editingId):'posts',this.editingId?'PATCH':'POST',this.draft);
        writePageCache(draftKey(this.editingId),this.user,{draft:null});this.ready=false;
        // Replace the editor so Back cannot accidentally republish the submitted draft.
        location.replace(postURL(post.id));
      }catch(e){this.editorError=e.message||'发布失败，内容已保留';this.publishing=false;this.saveDraft();}
    },
    async searchAll(){
      const version=++searchedVersion;this.query=this.query.trim();this.error='';this.searched=!!this.query;
      if(!this.query){this.posts=[];this.searchResults=[];return;}
      const url=new URL(location.href);url.searchParams.set('q',this.query);history.replaceState(null,'',url);
      this.recent=[this.query,...this.recent.filter(q=>q!==this.query)].slice(0,8);writePageCache('community-recent',this.user,{items:this.recent});
      if(this.searchType==='posts'){await this.load(true);return;}
      this.loading=true;try{const data=await social('search?'+new URLSearchParams({type:this.searchType,q:this.query}));if(version===searchedVersion)this.searchResults=data.list||[];}catch(e){this.error=e.message;}finally{if(version===searchedVersion)this.loading=false;}
    },
    async searchTypeTo(type){this.searchType=type;this.posts=[];this.searchResults=[];if(this.query)await this.searchAll();},
    clearRecent(){this.recent=[];writePageCache('community-recent',this.user,{items:[]});},
    async loadActivity(tab=this.activityTab){this.activityTab=tab;this.error='';const url=new URL(location.href);url.searchParams.set('tab',tab);history.replaceState(null,'',url);if(tab==='posts'){this.scope='mine';await this.load(true);}else{this.loading=true;try{this.activityItems=(await social('users/'+encodeURIComponent(this.user.id)+'/comments')).list||[];}catch(e){this.error=e.message;}finally{this.loading=false;}}},
    async profileView(tab){this.profileTab=tab;this.error='';if(tab==='posts'){await this.load(true);return;}this.loading=true;try{const data=await social('users/'+encodeURIComponent(this.profileId)+'/'+tab);this.activityItems=data.list||[];if(data.private)this.error='对方未公开这部分内容';}catch(e){this.error=e.message;}finally{this.loading=false;}},
    async followProfile(){try{this.profile.following=(await social('follow','PUT',{user_id:this.profileId,following:!this.profile.following})).following;}catch(e){this.notify(e.message);}},
    async blockProfile(){if(!await confirmAction('拉黑后，双方的社区内容互相不可见。确认拉黑？'))return;try{await social('blocks','PUT',{user_id:this.profileId,blocked:true});this.back();}catch(e){this.notify(e.message);}},
    async removePost(post){this.$refs.actionsDialog.close();if(!await confirmAction('删除这篇帖子？删除后不再公开展示。'))return;try{await social('posts/'+post.id,'DELETE');if(page==='post')location.replace('/app/community-activity.html');else{this.posts=this.posts.filter(p=>p.id!==post.id);this.notify('帖子已删除');}}catch(e){this.notify(e.message);}},
    async sharePost(post){if(this.localMode){this.notify('本机帖子不生成线上分享链接');return;}try{const url=new URL(postURL(post.id),location.origin).href;if(navigator.share)await navigator.share({title:post.title,url});else{await navigator.clipboard.writeText(url);this.notify('链接已复制');}}catch(e){if(e.name!=='AbortError')this.notify('分享失败，请重试');}},
    async previewMedia(url){const {body}=sheet('图片预览');const img=element('img','',{src:url,alt:'帖子配图',style:'width:100%;height:auto'});body.append(img);},
  };
};

// Compatibility for previously shared URLs; the canonical destination is now a page.
if(page==='home'&&(params.has('post')||params.has('compose'))){
  location.replace(params.has('post')?postURL(params.get('post')):'/app/community-compose.html');
}else{
  document.body.className='community-app community-screen-'+page;
  document.body.innerHTML=screenHTML(page);
  const style=document.createElement('link');style.rel='stylesheet';style.href='/assets/css/community-screens.css?v=20260917-r8';document.head.append(style);
  const alpine=document.createElement('script');alpine.src='/app/assets/vendor/alpine-3.14.1.min.js?v=3.14.1';document.head.append(alpine);
}
