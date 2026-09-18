import { api, requireAuth, getCachedUser } from './app-core.js?v=20260917-r8';
import { injectLayout } from './layout.js?v=20260917-r8';
import { authorizeCommunity } from './community-controls.js?v=20260917-r8';
window.contestPage = () => ({
  user:null,points:0,contest:null,loading:false,error:'',
  async init(){injectLayout('community');this.user=getCachedUser();if(!requireAuth())return;try{if(await authorizeCommunity())await this.load();else location.replace('/app/explore.html');}catch(error){this.error=error.message;}},
  async load(){if(this.loading)return;this.loading=true;this.error='';try{const result=await api.creatorContests();this.contest=result?.data?.contest || result?.contest || null;}catch(err){this.error=err.message || '获取赛事失败';}finally{this.loading=false;}}
});
