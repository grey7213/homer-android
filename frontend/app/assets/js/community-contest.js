import { api, requireAuth, getCachedUser } from './app-core.js?v=20260908-pr7';
import { injectLayout } from './layout.js?v=20260908-pr7';
import { allowCommunityPreview } from './community-preview.js';
window.contestPage = () => ({
  user:null,points:0,contest:null,loading:false,error:'',
  async init(){if(!await allowCommunityPreview())return;injectLayout('community');this.user=getCachedUser();if(requireAuth())await this.load();},
  async load(){if(this.loading)return;this.loading=true;this.error='';try{const result=await api.creatorContests();this.contest=result?.data?.contest || result?.contest || null;}catch(err){this.error=err.message || '获取赛事失败';}finally{this.loading=false;}}
});
