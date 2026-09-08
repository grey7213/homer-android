import { api, requireAuth, getCachedUser } from './app-core.js?v=20260908-pr7';
import { injectLayout } from './layout.js?v=20260908-pr7';
import { readPageCache, writePageCache } from './page-cache.js';
import { confirmAction } from '/assets/js/dialogs.js?v=20260908-pr7';
import { allowCommunityPreview } from './community-preview.js';

const unwrap = result => result?.data ?? result ?? {};
const uuid = () => crypto.randomUUID();
const initialDraft = () => ({ title: '', content: '', topic: '交流闲聊', images: [], client_id: uuid() });
function safeImage(value) {
  try { const url = new URL(value, location.origin); return (url.protocol === 'https:' || (url.origin === location.origin && url.protocol === location.protocol)) ? url.href : ''; } catch { return ''; }
}
function normalizePost(post) {
  return { ...post, id: String(post.id), author: String(post.author || '社区用户'),
    title: String(post.title || ''), content: String(post.content || ''),
    images: [...new Set((Array.isArray(post.images) ? post.images : []).map(safeImage).filter(Boolean))],
    comment_count: Number(post.comment_count || 0), like_count: Number(post.like_count || 0) };
}
function socialPage() {
  let requestVersion = 0;
  let commentsVersion = 0;
  let toastTimer;
  return {
    user: null, points: 0, posts: [], topics: ['交流闲聊','角色故事','创作交流','攻略分享','意见反馈'],
    scope:'public',sort:'latest',topic:'',query:'',searchOpen:false,loading:false,error:'',cursor:'',hasMore:false,
    busy:'',detail:null,comments:[],commentsLoading:false,commentsMore:false,commentsCursor:'',commentDraft:'',commentSending:false,commentError:'',commentClientId:'',
    draft:initialDraft(),editingId:'',publishing:false,uploading:false,editorError:'',actionPost:null,
    reportReason:'',reportError:'',reporting:false,toast:'',
    async init() {
      if (!await allowCommunityPreview()) return;
      injectLayout('community'); if (!requireAuth()) return;
      this.user=getCachedUser();
      this.posts=(readPageCache('social-feed',this.user)?.posts || []).map(normalizePost);
      const saved=readPageCache('social-draft',this.user);
      if(saved?.draft) this.draft={...initialDraft(),...saved.draft};
      this.$watch('draft',()=>{if(!this.editingId)writePageCache('social-draft',this.user,{draft:this.draft});});
      this.$refs.editorDialog.addEventListener('cancel',event=>{event.preventDefault();this.closeEditor();});
      await this.load(true);
      const sharedPost=new URLSearchParams(location.search).get('post');
      if(sharedPost){const post=this.posts.find(item=>item.id===String(sharedPost));if(post)this.openPost(post);}
    },
    notify(message) { this.toast=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{this.toast='';},3000); },
    formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''; },
    async setScope(value) { this.scope=value;await this.load(true); },
    async setSort(value) { this.sort=value;await this.load(true); },
    async setTopic(value) { this.topic=value;await this.load(true); },
    async load(reset=true) {
      if(!reset && this.loading)return;
      const version=++requestVersion;this.loading=true;this.error='';
      if(reset){this.cursor='';this.hasMore=false;if(this.topic || this.query || this.scope!=='public')this.posts=[];}
      try {
        const query=new URLSearchParams({scope:this.scope,sort:this.sort,topic:this.topic,q:this.query,cursor:this.cursor});
        const data=unwrap(await api.social('posts?'+query));
        if(version!==requestVersion)return;
        const items=(data.list || []).map(normalizePost);
        this.posts=reset?items:[...new Map([...this.posts,...items].map(post=>[post.id,post])).values()];
        this.cursor=String(data.next_cursor || '');this.hasMore=!!data.has_more;
        if(this.scope==='public' && !this.topic && !this.query)writePageCache('social-feed',this.user,{posts:this.posts.slice(0,40)});
      } catch(err) {
        if(version===requestVersion)this.error=err.status===404?'社区服务暂未接入，请稍后重试。':(err.message || '暂时无法获取社区内容');
      } finally { if(version===requestVersion)this.loading=false; }
    },
    updatePost(post) {
      const value=normalizePost(post);this.posts=this.posts.map(item=>item.id===value.id?value:item);
      if(this.detail?.id===value.id)this.detail=value;
      if(this.actionPost?.id===value.id)this.actionPost=value;
      const cached=readPageCache('social-feed',this.user)?.posts || [];
      writePageCache('social-feed',this.user,{posts:cached.map(item=>item.id===value.id?value:item)});
      return value;
    },
    async openPost(post) {
      this.detail=normalizePost(post);this.comments=[];this.commentDraft='';this.commentClientId=uuid();this.commentError='';
      this.$refs.detailDialog.showModal();this.loadComments(true);
      const id=post.id;
      try { const data=unwrap(await api.social('posts/'+id));if(this.detail?.id===id)this.updatePost(data); }
      catch(err){if(this.detail?.id===id)this.commentError=err.message || '帖子刷新失败';}
    },
    async loadComments(reset=true) {
      if(!this.detail || (!reset && this.commentsLoading))return;
      const id=this.detail.id,version=++commentsVersion;this.commentsLoading=true;this.commentError='';
      try {
        const data=unwrap(await api.social('posts/'+id+'/comments?cursor='+(reset?'':this.commentsCursor)));
        if(version!==commentsVersion || this.detail?.id!==id)return;
        this.comments=reset?(data.list || []):[...this.comments,...(data.list || [])];
        this.commentsMore=!!data.has_more;this.commentsCursor=String(data.next_cursor || '');
      } catch(err){if(this.detail?.id===id)this.commentError=err.message || '评论加载失败';}
      finally{if(version===commentsVersion)this.commentsLoading=false;}
    },
    async sendComment() {
      if(!this.detail || this.commentSending || !this.commentDraft.trim())return;
      const id=this.detail.id;this.commentSending=true;this.commentError='';
      try {
        await api.social('posts/'+id+'/comments',{method:'POST',body:{content:this.commentDraft,client_id:this.commentClientId}});
        if(this.detail?.id!==id)return;
        this.commentDraft='';this.commentClientId=uuid();await this.loadComments(true);
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
    openEditor(post=null) {
      this.$refs.actionsDialog.close();this.editorError='';this.editingId=post?.id || '';
      if(post)this.draft={title:post.title,content:post.content,topic:post.topic,images:[...post.images],client_id:uuid()};
      else this.draft=readPageCache('social-draft',this.user)?.draft || initialDraft();
      this.$refs.editorDialog.showModal();
    },
    closeEditor(){if(this.publishing)return;if(!this.editingId)writePageCache('social-draft',this.user,{draft:this.draft});this.$refs.editorDialog.close();},
    async uploadImages(event) {
      const files=[...event.target.files];event.target.value='';this.editorError='';
      if(files.length+this.draft.images.length>9){this.editorError='每篇帖子最多 9 张图片';return;}
      this.uploading=true;
      try {
        for(const file of files){
          if(!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>8*1024*1024)throw Error('请选择 8 MB 以内的 PNG、JPG 或 WebP 图片');
          const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
          const result=unwrap(await api.uploadCover(image,file.name));const url=safeImage(result.url || result.path);
          if(!url)throw Error('图片上传未返回可用地址');if(!this.draft.images.includes(url))this.draft.images.push(url);
        }
      }catch(err){this.editorError=err.message || '图片上传失败';}finally{this.uploading=false;}
    },
    async publish() {
      if(this.publishing || this.uploading || !this.draft.content.trim())return;
      this.publishing=true;this.editorError='';
      try {
        const post=normalizePost(unwrap(await api.social(this.editingId?'posts/'+this.editingId:'posts',{method:this.editingId?'PATCH':'POST',body:this.draft})));
        this.updatePost(post);this.draft=initialDraft();
        if(!this.editingId)writePageCache('social-draft',this.user,{draft:this.draft});
        this.$refs.editorDialog.close();this.scope='mine';this.topic='';this.query='';await this.load(true);this.notify(this.editingId?'修改已保存':'发布成功');
      }catch(err){this.editorError=err.message || '发布失败，草稿已保留';}finally{this.publishing=false;}
    },
    async removePost(post) {
      this.$refs.actionsDialog.close();
      if(!await confirmAction('删除这篇帖子？删除后将不再公开展示。'))return;
      try{await api.social('posts/'+post.id,{method:'DELETE'});if(this.detail?.id===post.id)this.$refs.detailDialog.close();this.posts=this.posts.filter(item=>item.id!==post.id);const cached=readPageCache('social-feed',this.user)?.posts || [];writePageCache('social-feed',this.user,{posts:cached.filter(item=>item.id!==post.id)});this.notify('帖子已删除');}
      catch(err){this.notify(err.message || '删除失败');}
    },
    async removeComment(comment) {
      if(!await confirmAction('删除这条评论？'))return;
      try{await api.social('comments/'+comment.id,{method:'DELETE'});await this.loadComments(true);if(this.detail)this.updatePost(unwrap(await api.social('posts/'+this.detail.id)));}
      catch(err){this.commentError=err.message || '删除失败';}
    },
    reportPost(post){this.actionPost=post;this.$refs.actionsDialog.close();this.reportReason='';this.reportError='';this.$refs.reportDialog.showModal();},
    async submitReport(){
      if(this.reporting || !this.reportReason.trim())return;this.reporting=true;
      try{await api.social('posts/'+this.actionPost.id+'/report',{method:'POST',body:{reason:this.reportReason}});this.$refs.reportDialog.close();this.notify('举报已提交');}
      catch(err){this.reportError=err.message || '提交失败';}finally{this.reporting=false;}
    },
  };
}
window.socialPage=socialPage;
