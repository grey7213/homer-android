import { api, requireAuth, getCachedUser } from './app-core.js?v=20260917-r8';
import { injectLayout } from './layout.js?v=20260917-r8';
import { readPageCache, writePageCache } from './page-cache.js';
import { confirmAction } from '/assets/js/dialogs.js?v=20260917-r8';
import { social, authorizeCommunity, renderCommunityText, openCommunityUser, sheet, element, button, styles } from './community-controls.js?v=20260917-r8';
import {localEnabled,routeLocally,addLocalMedia,hydrateLocalDraft,storeLocalDraft} from './community-local.js?v=20260917-r8';

const cacheKey=name=>routeLocally()?'local-acceptance-'+name:name;
const readSocialCache=(name,user,options)=>readPageCache(cacheKey(name),user,options);
const writeSocialCache=(name,user,value)=>writePageCache(cacheKey(name),user,localEnabled()&&value.draft?{draft:storeLocalDraft(value.draft)}:value);

const unwrap = result => result?.data ?? result ?? {};
const uuid = () => crypto.randomUUID();
const initialDraft = () => ({ title: '', content: '', topic: '交流闲聊', images: [], video:'', tags:[], client_id: uuid() });
function safeImage(value) {
  if(localEnabled()&&String(value).startsWith('blob:'))return value;
  try { const url = new URL(value, location.origin); return (url.protocol === 'https:' || (url.origin === location.origin && url.protocol === location.protocol)) ? url.href : ''; } catch { return ''; }
}
function normalizePost(post) {
  return { ...post, id: String(post.id), author: String(post.author || '社区用户'),
    locked:!!post.locked,featured:!!post.featured,pinned:!!post.pinned,
    title: String(post.title || ''), content: String(post.content || ''),
    images: [...new Set((Array.isArray(post.images) ? post.images : []).map(safeImage).filter(Boolean))],
    comment_count: Number(post.comment_count || 0), like_count: Number(post.like_count || 0) };
}
export function socialPage() {
  let requestVersion = 0;
  let commentsVersion = 0;
  let toastTimer;
  return {
    user: null, points: 0, posts: [], topics: ['交流闲聊','角色故事','创作交流','攻略分享','意见反馈'],
    scope:'public',sort:'latest',topic:'',query:'',searchOpen:false,loading:false,error:'',cursor:'',hasMore:false,
    busy:'',detail:null,comments:[],commentsLoading:false,commentsMore:false,commentsCursor:'',commentDraft:'',commentSending:false,commentError:'',commentClientId:'',
    draft:initialDraft(),editingId:'',publishing:false,uploading:false,editorError:'',actionPost:null,
    reportReason:'',reportError:'',reporting:false,toast:'',
    ready:false,localMode:false,gateLoading:true,gateError:'',categories:{},reportCategory:'',reportType:'post',reportTarget:null,
    muted:false,mediaAvailable:false,replyTarget:null,commentImages:[],commentPage:1,commentPages:1,commentSnapshot:0,commentSort:'oldest',authorOnly:false,
    announcements:[],preflight:'',preflightSequence:0,searchType:'posts',searchResults:[],
    rich:renderCommunityText,openUser:openCommunityUser,
    async init() {
      styles();injectLayout('community'); if (!requireAuth()) return;
      this.user=getCachedUser();
      window.addEventListener('homer-account-cleared',()=>{this.ready=false;this.posts=[];this.detail=null;this.comments=[];document.querySelectorAll('dialog[open]').forEach(d=>d.close());});
      this.$refs.editorDialog.addEventListener('cancel',event=>{event.preventDefault();this.closeEditor();});
      await this.enter();
      if(!this.ready)return;
      const saved=readSocialCache('social-draft',this.user,{maxAgeMs:365*86400000});
      if(saved?.draft)this.draft={...initialDraft(),...await hydrateLocalDraft(saved.draft)};
      this.$watch('draft',()=>{if(!this.editingId && !writeSocialCache('social-draft',this.user,{draft:this.draft}))this.editorError='本地空间不足，草稿暂未保存，请勿关闭编辑器';});
    },
    async enter(){
      this.gateLoading=true;this.gateError='';
      try{
        const state=await authorizeCommunity();if(!state){location.replace('/app/explore.html');return;}
        this.localMode=!!state.local;
        this.categories=state.categories;this.muted=state.sanctions?.some(s=>s.kind==='mute'||s.kind==='ban');this.mediaAvailable=!!state.media;this.ready=true;
        this.topics=(await social('topics')).list;this.announcements=(await social('announcements')).list;
        await this.load(true);
      }catch(error){this.gateError=error.message;this.ready=false;this.posts=[];}finally{this.gateLoading=false;}
      if(!this.ready)return;
      const sharedPost=new URLSearchParams(location.search).get('post');
      if(sharedPost){try{await this.openPost(await social('posts/'+encodeURIComponent(sharedPost)));}catch(error){this.notify(error.message);}}
      if(new URLSearchParams(location.search).get('compose')==='1')this.openEditor();
    },
    notify(message) { this.toast=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{this.toast='';},3000); },
    formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''; },
    async setScope(value) { this.scope=value;await this.load(true); },
    async setSort(value) { this.sort=value;await this.load(true); },
    async setTopic(value) { this.topic=value;await this.load(true); },
    async load(reset=true) {
      if(!this.ready)return;
      if(!reset && this.loading)return;
      const version=++requestVersion;this.loading=true;this.error='';
      if(reset){this.cursor='';this.hasMore=false;if(this.topic || this.query || this.scope!=='public')this.posts=[];}
      try {
        const query=new URLSearchParams({scope:this.scope,sort:this.sort,topic:this.topic,q:this.query,cursor:this.cursor,...(this.profileId?{author:this.profileId}:{})});
        const data=unwrap(await api.social('posts?'+query));
        if(version!==requestVersion)return;
        const items=(data.list || []).map(normalizePost);
        this.posts=reset?items:[...new Map([...this.posts,...items].map(post=>[post.id,post])).values()];
        this.cursor=String(data.next_cursor || '');this.hasMore=!!data.has_more;
        if(this.scope==='public' && !this.topic && !this.query)writeSocialCache('social-feed',this.user,{posts:this.posts.slice(0,40)});
      } catch(err) {
        if(err.status===403){this.posts=[];this.$refs.detailDialog?.close();}
        if(version===requestVersion)this.error=err.status===404?'社区服务暂未接入，请稍后重试。':(err.message || '暂时无法获取社区内容');
      } finally { if(version===requestVersion)this.loading=false; }
    },
    updatePost(post) {
      const value=normalizePost(post);this.posts=this.posts.map(item=>item.id===value.id?value:item);
      if(this.detail?.id===value.id)this.detail=value;
      if(this.actionPost?.id===value.id)this.actionPost=value;
      const cached=readSocialCache('social-feed',this.user)?.posts || [];
      writeSocialCache('social-feed',this.user,{posts:cached.map(item=>item.id===value.id?value:item)});
      return value;
    },
    async openPost(post) {
      this.detail=normalizePost(post);this.comments=[];this.commentDraft='';this.commentClientId=uuid();this.commentError='';this.replyTarget=null;this.commentImages=[];this.commentPage=1;this.commentSnapshot=0;
      this.$refs.detailDialog.showModal();this.loadComments(true);
      const id=post.id;
      try { const data=unwrap(await api.social('posts/'+id));if(this.detail?.id===id)this.updatePost(data); }
      catch(err){if(this.detail?.id===id){this.$refs.detailDialog.close();this.posts=this.posts.filter(p=>p.id!==id);this.notify(err.message || '帖子暂不可查看');}}
    },
    async loadComments(reset=true) {
      if(!this.detail || (!reset && this.commentsLoading))return;
      const id=this.detail.id,version=++commentsVersion;this.commentsLoading=true;this.commentError='';
      try {
        if(reset){this.commentPage=1;this.commentSnapshot=0;}
        const data=unwrap(await api.social('posts/'+id+'/comments?'+new URLSearchParams({page:this.commentPage,snapshot:this.commentSnapshot,sort:this.commentSort,author_only:this.authorOnly?'1':'0'})));
        if(version!==commentsVersion || this.detail?.id!==id)return;
        this.comments=data.list || [];this.commentPage=data.page;this.commentPages=data.pages;this.commentSnapshot=data.snapshot;this.commentsMore=!!data.has_more;
      } catch(err){if(this.detail?.id===id)this.commentError=err.message || '评论加载失败';}
      finally{if(version===commentsVersion)this.commentsLoading=false;}
    },
    async sendComment() {
      if(!this.detail || this.commentSending || this.muted || (!this.commentDraft.trim() && !this.commentImages.length))return;
      const id=this.detail.id;this.commentSending=true;this.commentError='';
      try {
        const result=await social('posts/'+id+'/comments','POST',{content:this.commentDraft,images:this.commentImages,parent_id:this.replyTarget?.id||0,client_id:this.commentClientId});
        if(this.detail?.id!==id)return;
        this.commentDraft='';this.commentImages=[];this.replyTarget=null;this.commentClientId=uuid();await this.loadComments(true);this.notify(result.status==='pending'?'评论已提交，审核通过后展示':'评论已发送');
        this.updatePost(unwrap(await api.social('posts/'+id)));
      } catch(err){this.commentError=err.message || '发送失败，内容已保留';}
      finally{this.commentSending=false;}
    },
    async like(post) {
      if(this.busy)return;this.busy=post.id;
      try{this.updatePost(unwrap(await api.social('posts/'+post.id+'/like',{method:'PUT',body:{liked:!post.liked}})));}
      catch(err){this.notify(err.message || '点赞失败');}finally{this.busy='';}
    },
    async save(post) {
      if(this.busy)return;this.busy=post.id;
      try {
        const value=unwrap(await api.social('posts/'+post.id+'/save',{method:'PUT',body:{saved:!post.saved}}));
        this.updatePost(value);this.notify(value.saved?'已收藏帖子':'已取消收藏');
        if(this.scope==='saved' && !value.saved)this.posts=this.posts.filter(item=>item.id!==value.id);
      } catch(err){this.notify(err.message || '收藏失败');} finally {this.busy='';}
    },
    async sharePost(post) {
      if(this.localMode){this.notify('本机帖子未上传，不能分享为线上链接');return;}
      const url=new URL('/app/community.html?post='+encodeURIComponent(post.id),location.origin).href;
      try {
        if(navigator.share) await navigator.share({title:post.title || '惑梦社区帖子',text:post.content.slice(0,120),url});
        else { await navigator.clipboard.writeText(url);this.notify('帖子链接已复制'); }
      } catch(err){ if(err?.name!=='AbortError')this.notify('分享失败，请稍后重试'); }
    },
    async follow(post) {
      if(this.busy)return;this.busy=post.id;
      try {
        const result=unwrap(await api.social('follow',{method:'PUT',body:{user_id:post.user_id,following:!post.following}}));
        this.posts.forEach(item=>{if(item.user_id===post.user_id)item.following=result.following;});
        if(this.detail?.user_id===post.user_id)this.detail.following=result.following;
        post.following=result.following;this.notify(result.following?'已关注作者':'已取消关注');
      } catch(err){this.notify(err.message || '操作失败');}finally{this.busy='';}
    },
    openActions(post){this.actionPost=post;this.$refs.actionsDialog.showModal();},
    async openEditor(post=null) {
      if(this.muted){this.notify('当前处于禁言状态，可在我的 → 设置 → 账号状态中申诉');return;}
      this.$refs.actionsDialog.close();this.editorError='';this.editingId=post?.id || '';
      if(post?.pending_edit)post={...post,...post.pending_edit};
      if(post)this.draft={title:post.title,content:post.content,topic:post.topic,images:[...post.images],video:post.video||'',tags:post.tags||[],version:post.version,client_id:uuid()};
      else this.draft={...initialDraft(),...await hydrateLocalDraft(readSocialCache('social-draft',this.user,{maxAgeMs:365*86400000})?.draft||{})};
      this.$refs.editorDialog.showModal();
    },
    async checkContent(){
      const version=++this.preflightSequence;try{const result=await social('preflight','POST',{content:this.draft.title+'\n'+this.draft.content});if(version===this.preflightSequence)this.preflight=result.status==='rejected'?'内容未通过规则检查，请修改后发布':result.status==='pending'?'这篇内容发布后需要人工审核':'';}catch{if(version===this.preflightSequence)this.preflight='暂时无法预检查，发布时会再次校验';}
    },
    async searchAll(){
      if(this.searchType==='posts'){await this.load(true);return;}
      try{this.searchResults=(await social('search?'+new URLSearchParams({type:this.searchType,q:this.query}))).list;}catch(error){this.notify(error.message);}
    },
    async mentionUser(comment=false){
      const {dialog,body}=sheet('提及用户'),input=element('input','',{type:'search',placeholder:'搜索用户昵称或 ID','aria-label':'搜索提及用户'}),list=element('section');
      body.append(input,button('搜索',async()=>{const result=await social('search?type=users&q='+encodeURIComponent(input.value));list.replaceChildren();if(!result.list.length)list.append(element('p','没有匹配的用户'));for(const u of result.list)list.append(button(u.name,()=>{const token='@{'+u.user_id+'} ';if(comment)this.commentDraft+=token;else this.draft.content+=token;dialog.close();}));}),list);input.focus();
    },
    async pageComments(page){this.commentPage=Number(page)||1;await this.loadComments(false);},
    async replies(comment){
      const {body}=sheet('楼中回复');let page=1,snapshot=0;const list=element('section');const more=button('更多回复',async()=>{page++;await load();});
      const load=async()=>{const data=await social('posts/'+this.detail.id+'/comments?'+new URLSearchParams({root:comment.id,page,snapshot}));snapshot=data.snapshot;for(const reply of data.list){const row=element('article','',{class:'community-list-row'}),content=element('p');row.append(element('strong',reply.author),content,button('回复',()=>{this.replyTarget=reply;body.closest('dialog').close();}),button('举报',()=>this.reportPost(reply,'comment')));list.append(row);await renderCommunityText(content,reply.content);}more.hidden=!data.has_more;};body.append(list,more);await load();
    },
    async likeComment(comment){try{Object.assign(comment,await social('comments/'+comment.id+'/like','PUT',{liked:!comment.liked}));}catch(error){this.notify(error.message);}},
    closeEditor(){if(this.publishing)return;if(!this.editingId)writeSocialCache('social-draft',this.user,{draft:this.draft});this.$refs.editorDialog.close();},
    async uploadImages(event,comment=false) {
      const files=[...event.target.files];event.target.value='';this.editorError='';
      const images=comment?this.commentImages:this.draft.images,limit=comment?3:9;
      if(files.length+images.length>limit){this.notify('最多 '+limit+' 张图片');return;}
      this.uploading=true;
      try {
        for(const file of files){
          if(!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>8*1024*1024)throw Error('请选择 8 MB 以内的 PNG、JPG 或 WebP 图片');
          if(this.localMode){images.push(await addLocalMedia(file));continue;}
          const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
          const result=unwrap(await api.uploadCover(image,file.name));const url=safeImage(result.url || result.path);
          if(!url)throw Error('图片上传未返回可用地址');if(!images.includes(url))images.push(url);
        }
      }catch(err){if(comment)this.commentError=err.message||'图片上传失败';else this.editorError=err.message || '图片上传失败';}finally{this.uploading=false;}
    },
    async uploadVideo(event){
      const file=event.target.files[0];event.target.value='';if(!file)return;
      if(!this.mediaAvailable){this.editorError='视频服务尚未接入';return;}
      if(file.type!=='video/mp4'||file.size>100*1024*1024){this.editorError='请选择 100 MB 内的 MP4 视频';return;}
      this.uploading=true;this.editorError='';
      try{
        if(this.localMode){this.draft.video=await addLocalMedia(file);this.draft.images=[];return;}
        const upload=await social('media/init','POST',{mime:file.type,size:file.size});
        for(let offset=0,index=0;offset<file.size;offset+=upload.chunk_size,index++){
          const chunk=file.slice(offset,offset+upload.chunk_size);
          const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('无法读取视频'));reader.readAsDataURL(chunk);});
          await social('media/chunk','POST',{id:upload.id,index,data:encoded});
          this.editorError='视频上传 '+Math.round(Math.min(offset+upload.chunk_size,file.size)/file.size*100)+'%';
        }
        const result=await social('media/finalize','POST',{id:upload.id});this.draft.video=result.url;this.draft.images=[];this.editorError='';
      }catch(error){this.editorError=error.message||'上传失败，文字草稿已保留';}finally{this.uploading=false;}
    },
    async publish() {
      if(this.publishing || this.uploading || !this.draft.content.trim())return;
      this.publishing=true;this.editorError='';
      try {
        const post=normalizePost(unwrap(await api.social(this.editingId?'posts/'+this.editingId:'posts',{method:this.editingId?'PATCH':'POST',body:this.draft})));
        this.updatePost(post);this.draft=initialDraft();
        if(!this.editingId)writeSocialCache('social-draft',this.user,{draft:this.draft});
        this.$refs.editorDialog.close();this.scope='mine';this.topic='';this.query='';await this.load(true);this.notify(post.status==='pending'||post.edit_pending?'已提交审核，可在我的投稿中查看':this.editingId?'修改已保存':'发布成功');
      }catch(err){this.editorError=err.message || '发布失败，草稿已保留';}finally{this.publishing=false;}
    },
    async removePost(post) {
      this.$refs.actionsDialog.close();
      if(!await confirmAction('删除这篇帖子？删除后将不再公开展示。'))return;
      try{await api.social('posts/'+post.id,{method:'DELETE'});if(this.detail?.id===post.id)this.$refs.detailDialog.close();this.posts=this.posts.filter(item=>item.id!==post.id);const cached=readSocialCache('social-feed',this.user)?.posts || [];writeSocialCache('social-feed',this.user,{posts:cached.filter(item=>item.id!==post.id)});this.notify('帖子已删除');}
      catch(err){this.notify(err.message || '删除失败');}
    },
    async removeComment(comment) {
      if(!await confirmAction('删除这条评论？'))return;
      try{await api.social('comments/'+comment.id,{method:'DELETE'});await this.loadComments(true);if(this.detail)this.updatePost(unwrap(await api.social('posts/'+this.detail.id)));}
      catch(err){this.commentError=err.message || '删除失败';}
    },
    reportPost(post,type='post'){this.reportTarget=post;this.reportType=type;this.$refs.actionsDialog.close();this.reportReason='';this.reportCategory='';this.reportError='';this.$refs.reportDialog.showModal();},
    async submitReport(){
      if(this.reporting || !this.reportCategory)return;this.reporting=true;
      try{const result=await social((this.reportType==='post'?'posts/':'comments/')+this.reportTarget.id+'/report','POST',{category:this.reportCategory,reason:this.reportReason});this.$refs.reportDialog.close();this.notify(result.duplicate?'你已举报过这条内容，无需重复提交':'举报已提交，处理结果会在通知中告知');}
      catch(err){this.reportError=err.message || '提交失败';}finally{this.reporting=false;}
    },
  };
}
window.socialPage=socialPage;
