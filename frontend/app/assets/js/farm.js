import { api, requireAuth, getCachedUser, setCachedUser, ApiError } from '/app/assets/js/app-core.js?v=20260717-handoff-merge';
import { injectLayout, loadPublicSiteSettings } from '/app/assets/js/layout.js?v=20260901-persistent-pages';

const BASE_SEEDS = [
  { kind: 'carrot', apiKind: 'code_carrot', name: '代码胡萝卜', cost: 50, rewardCoins: 90, rewardXp: 10, durationSeconds: 3 * 3600, durationLabel: '3 小时' },
  { kind: 'wheat', apiKind: 'compute_wheat', name: '算力小麦', cost: 100, rewardCoins: 190, rewardXp: 22, durationSeconds: 9 * 3600, durationLabel: '9 小时' },
  { kind: 'berry', apiKind: 'inspiration_berry', name: '灵感莓果', cost: 180, rewardCoins: 340, rewardXp: 40, durationSeconds: 18 * 3600, durationLabel: '18 小时' },
];

const UNLOCK_DAYS = [1, 7, 14, 21, 28, 35, 42, 49];
const FRIEND_COLORS = ['#d38151', '#66899e', '#9172a0', '#63896d'];

function intValue(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function unwrap(result) {
  if (!result || typeof result !== 'object') return {};
  return result.data && typeof result.data === 'object' ? result.data : result;
}

function parseTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  let text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)) text = text.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cropKind(value) {
  const key = String(value || '').trim().toLowerCase();
  if (['carrot', 'code_carrot', '代码胡萝卜'].includes(key)) return 'carrot';
  if (['wheat', 'compute_wheat', '算力小麦'].includes(key)) return 'wheat';
  if (['berry', 'inspiration_berry', '灵感莓果'].includes(key)) return 'berry';
  return '';
}

function makeIdempotencyKey(action) {
  if (globalThis.crypto?.randomUUID) return `farm-${action}-${crypto.randomUUID()}`;
  return `farm-${action}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (value <= 0) return '已成熟';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (hours > 0) return `${hours}时${String(minutes).padStart(2, '0')}分`;
  return `${minutes}分${String(secs).padStart(2, '0')}秒`;
}

function cropSvg(kind, stage = 4) {
  if (kind === 'locked') {
    return '<svg viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#31402e" d="M12 22h24v21H12zM17 13h14v4h4v10h-5v-9H18v9h-5V17h4z"/><path fill="#9a825e" d="M15 25h18v15H15z"/><path fill="#4b4437" d="M21 31h7v6h-2v4h-3v-4h-2z"/></svg>';
  }
  if (kind === 'empty' || !kind) {
    return '<svg viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#4a392b" d="M8 39h32v4H8z"/><path fill="#c9a26a" d="M21 18h7v8h8v7h-8v8h-7v-8h-8v-7h8z"/><path fill="#f1cc82" d="M23 21h3v7h7v3h-7v7h-3v-7h-7v-3h7z"/></svg>';
  }
  if (stage <= 0) {
    return '<svg class="growth-stage-0" viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#382b24" d="M13 38h22v6H13z"/><path fill="#765039" d="M17 34h14v6H17z"/><path fill="#d9b36c" d="M22 29h5v5h-5z"/><path fill="#f0cd82" d="M23 30h2v2h-2z"/></svg>';
  }
  if (stage === 1) {
    return '<svg class="growth-stage-1" viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#382b24" d="M11 40h27v5H11z"/><path fill="#2c432e" d="M22 22h6v18h-6zM12 21h11v5h5v7H18v-4h-6zm16-6h10v9h-5v6h-7V20h2z"/><path fill="#62a851" d="M14 23h8v4h4v3h-6v-4h-6zm16-5h6v4h-4v5h-4v-7h2z"/></svg>';
  }
  if (stage === 2) {
    return `<svg class="growth-stage-2" viewBox="0 0 48 48" shape-rendering="crispEdges"><path fill="#382b24" d="M10 41h29v5H10z"/><path fill="#2e4a2f" d="M13 19h6v23h-6zm10-8h6v31h-6zm10 5h6v26h-6z"/><path fill="${kind === 'berry' ? '#579a4d' : '#69a94b'}" d="M7 22h10v5H7zm13-8h10v6H20zm9 10h12v6H29z"/></svg>`;
  }
  if (stage === 3) {
    if (kind === 'wheat') {
      return '<svg class="growth-stage-3" viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#382b24" d="M7 42h35v5H7z"/><path fill="#4c3d29" d="M11 12h7v32h-7zm11-7h7v39h-7zm12 4h7v35h-7z"/><path fill="#76a549" d="M13 14h3v28h-3zm11-7h3v35h-3zm12 4h3v31h-3z"/><path fill="#b5b44b" d="M9 9h11v5H9zm11-7h11v5H20zm12 4h11v5H32z"/></svg>';
    }
    if (kind === 'berry') {
      return '<svg class="growth-stage-3" viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#29402c" d="M17 9h15v5h7v7h5v19H5V21h6v-7h6z"/><path fill="#387443" d="M19 12h11v5h7v7h4v13H8V24h6v-7h5z"/><path fill="#5ba451" d="M11 23h11v8H11zm16-7h9v8h-9zm-7 16h13v6H20z"/><path fill="#efe079" d="M14 20h4v4h-4zm18 6h4v4h-4zm-9 5h4v4h-4z"/></svg>';
    }
    return '<svg class="growth-stage-3" viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#29422d" d="M19 5h11v28h7v7H11v-8h7V13h-8V8h9z"/><path fill="#3d8540" d="M22 8h5v27h-5zM11 11h10v6h6v7H17v-5h-6zm18-2h9v8h-5v8h-7V15h3z"/><path fill="#67b24d" d="M13 12h6v3h-6zm18-1h5v4h-5z"/><path fill="#d85a3c" d="M21 35h7v8h-7z"/><path fill="#fa8d4c" d="M23 35h4v4h-4z"/></svg>';
  }
  if (kind === 'wheat') {
    return '<svg viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#55402a" d="M20 10h6v34h-6zM9 17h6v27H9zm23-4h6v31h-6z"/><path fill="#d9992e" d="M21 11h4v30h-4zM10 18h4v23h-4zm23-4h4v27h-4z"/><path fill="#f4c84e" d="M15 6h14v6H15zm0 7h11v6H15zM5 12h13v6H5zM4 19h12v6H4zm25-12h12v6H29zm2 7h12v6H31z"/><path fill="#8f6032" d="M6 41h36v4H6z"/></svg>';
  }
  if (kind === 'berry') {
    return '<svg viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#2c422d" d="M19 10h10v5h7v5h6v16h-6v6H12v-5H6V20h7v-6h6z"/><path fill="#4b9148" d="M13 21h9v7h-9zm14-4h7v7h-7zm-5 13h10v6H22z"/><path fill="#572941" d="M10 25h10v10H10zm21 3h10v10H31zM19 35h10v10H19z"/><path fill="#d45378" d="M12 27h6v6h-6zm21 3h6v6h-6zm-12 7h6v6h-6z"/></svg>';
  }
  return '<svg viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><path fill="#2a422c" d="M20 5h9v12h7v10h-5v5H16v-5h-6V14h10z"/><path fill="#4a9147" d="M22 8h5v12h-5zM13 16h9v5h5v4H17v-4h-4zm15-2h6v8h-5v4h-5v-6h4z"/><path fill="#df633e" d="M15 29h16v5h-3v7h-4v4h-3v-6h-4v-6h-2z"/><path fill="#ff9951" d="M18 30h10v4H18z"/></svg>';
}

function farmPage() {
  return {
    user: null,
    points: 0,
    sidebarOpen: false,
    state: null,
    siteSettings: null,
    plots: [],
    friends: [],
    friendsMode: 'empty',
    friendsMessage: '',
    seeds: BASE_SEEDS.map(item => ({ ...item })),
    coins: 0,
    xp: 0,
    energy: 0,
    energyMax: 5,
    streakDays: 0,
    stealsLeft: 0,
    dailyRewardPoints: 10,
    dailyClaimed: false,
    energyUpdatedAt: 0,
    nextEnergyAt: 0,
    serverOffsetMs: 0,
    nowMs: Date.now(),
    loading: true,
    busy: false,
    activePlotNo: 0,
    selectedPlot: null,
    seedPickerOpen: false,
    seedPlot: null,
    loadError: '',
    toast: null,
    toastTimer: null,
    clockTimer: null,
    refreshTimer: null,

    get level() { return Math.max(1, Math.floor(this.xp / 100) + 1); },

    async init() {
      injectLayout('farm');
      if (!requireAuth()) return;
      this.user = getCachedUser();
      this.siteSettings = await loadPublicSiteSettings().catch(() => null);
      this.dailyRewardPoints = intValue(this.siteSettings?.rewards?.daily_points, 10);
      await this.loadAll(false);
      this.clockTimer = setInterval(() => {
        this.nowMs = Date.now() + this.serverOffsetMs;
        this.refreshTemporalPlots();
      }, 1000);
      this.refreshTimer = setInterval(() => this.loadState(true), 60000);
    },

    destroy() {
      if (this.clockTimer) clearInterval(this.clockTimer);
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      if (this.toastTimer) clearTimeout(this.toastTimer);
    },

    async loadAll(showSuccess = false) {
      this.loading = true;
      this.loadError = '';
      const results = await Promise.allSettled([
        api.farmState(),
        api.farmFriends(),
        api.profile(),
        api.credits().catch(() => api.points()),
        api.rewards(),
      ]);
      const stateResult = results[0];
      if (stateResult.status === 'fulfilled') {
        this.applyState(stateResult.value);
      } else {
        this.loadError = stateResult.reason?.message || '无法读取农场状态';
      }
      if (results[1].status === 'fulfilled') this.applyFriends(results[1].value);
      if (results[2].status === 'fulfilled') {
        this.user = unwrap(results[2].value);
        if (this.user?.id) setCachedUser(this.user);
      }
      if (results[3].status === 'fulfilled') this.applyCredits(results[3].value);
      if (results[4].status === 'fulfilled') this.applyDailyMeta(results[4].value);
      this.loading = false;
      if (showSuccess && this.state) this.showToast('农场状态已刷新', 'info');
    },

    async loadState(silent = false) {
      try {
        const result = await api.farmState();
        this.applyState(result);
      } catch (error) {
        if (!silent) this.showToast(error.message || '刷新农场失败', 'error');
      }
    },

    applyCredits(result) {
      const data = unwrap(result);
      const balance = data.balance || data;
      this.points = intValue(balance.points ?? balance.total_points ?? data.points, this.points);
    },

    applyDailyMeta(result) {
      const data = unwrap(result);
      const daily = data.daily || data.daily_reward || {};
      this.dailyRewardPoints = intValue(daily.points ?? daily.reward_points ?? data.daily_points, this.dailyRewardPoints);
      if ('claimed' in daily || 'is_claimed' in daily) this.dailyClaimed = boolValue(daily.claimed ?? daily.is_claimed);
    },

    applyState(result) {
      const outer = unwrap(result);
      const raw = outer.state || outer.farm_state || outer.farm || outer;
      const profile = raw.profile || raw.farm_profile || raw;
      const serverTime = parseTime(raw.server_time || raw.serverTime || outer.server_time || outer.serverTime);
      if (serverTime) this.serverOffsetMs = serverTime - Date.now();
      this.nowMs = Date.now() + this.serverOffsetMs;
      if (raw.account_balance) this.applyCredits(raw.account_balance);
      else if (profile.points != null) this.points = intValue(profile.points, this.points);
      // 农场币是独立货币，与账号积分分开显示。
      this.coins = intValue(profile.coins ?? profile.farm_coins, this.coins);
      this.xp = intValue(profile.xp ?? profile.experience, this.xp);
      this.energy = intValue(profile.energy, this.energy);
      this.energyMax = intValue(profile.energy_max ?? raw.energy_max, 5);
      this.energyUpdatedAt = parseTime(profile.energy_updated_at || profile.energyUpdatedAt);
      this.nextEnergyAt = parseTime(profile.next_energy_at || profile.nextEnergyAt);
      this.streakDays = intValue(profile.streak_days ?? profile.streakDays, this.streakDays || 1);
      this.stealsLeft = intValue(raw.steals_remaining ?? raw.steals_left ?? raw.stealsLeft ?? profile.steals_remaining ?? profile.steals_left, this.stealsLeft);
      this.dailyRewardPoints = intValue(raw.daily_reward_points ?? raw.daily_points ?? raw.daily_reward?.points, this.dailyRewardPoints);
      if (raw.daily_reward && ('claimed' in raw.daily_reward || 'is_claimed' in raw.daily_reward)) this.dailyClaimed = boolValue(raw.daily_reward.claimed ?? raw.daily_reward.is_claimed);
      if ('daily_claimed' in raw || 'daily_reward_claimed' in raw) this.dailyClaimed = boolValue(raw.daily_claimed ?? raw.daily_reward_claimed);
      this.seeds = this.normalizeSeeds(raw.crops || raw.seed_catalog || raw.seeds);
      this.plots = this.normalizePlots(raw.plots || raw.farm_plots || []);
      if (Array.isArray(raw.friends)) this.friends = this.normalizeFriends(raw.friends);
      this.state = raw;
      this.syncSelectedPlot();
    },

    normalizeSeeds(items) {
      if (!Array.isArray(items) || !items.length) return BASE_SEEDS.map(item => ({ ...item }));
      const byKind = new Map(items.map(item => [cropKind(item.kind || item.crop_kind || item.id), item]));
      return BASE_SEEDS.map(base => {
        const item = byKind.get(base.kind) || {};
        const durationSeconds = intValue(item.duration_seconds ?? item.grow_seconds, base.durationSeconds);
        return {
          ...base,
          apiKind: item.kind || item.crop_kind || base.apiKind,
          name: item.name || item.label || base.name,
          cost: intValue(item.cost ?? item.cost_coins, base.cost),
          rewardCoins: intValue(item.reward_coins ?? item.coins, base.rewardCoins),
          rewardXp: intValue(item.reward_xp ?? item.xp, base.rewardXp),
          durationSeconds,
          durationLabel: item.duration_label || (durationSeconds % 3600 === 0 ? `${durationSeconds / 3600} 小时` : formatDuration(durationSeconds)),
        };
      });
    },

    normalizePlots(items) {
      const source = Array.isArray(items) ? items : [];
      const map = new Map(source.map((item, index) => [intValue(item.plot_no ?? item.plotNo ?? item.id, index + 1), item]));
      return Array.from({ length: 8 }, (_, index) => {
        const plotNo = index + 1;
        const item = map.get(plotNo) || {};
        const kind = cropKind(item.crop_kind ?? item.cropKind ?? item.crop?.kind ?? item.crop);
        const unlockDays = intValue(item.unlock_days ?? item.unlockDays, UNLOCK_DAYS[index]);
        const locked = ('unlocked' in item || 'is_unlocked' in item)
          ? !boolValue(item.unlocked ?? item.is_unlocked)
          : boolValue(item.locked ?? item.is_locked, this.streakDays < unlockDays);
        const plantedAt = parseTime(item.planted_at || item.plantedAt);
        const readyAt = parseTime(item.ready_at || item.readyAt || item.matures_at || item.maturesAt);
        const seed = this.seeds.find(entry => entry.kind === kind);
        const progress = readyAt && plantedAt && readyAt > plantedAt ? Math.max(0, Math.min(1, (this.nowMs - plantedAt) / (readyAt - plantedAt))) : 0;
        const ready = !locked && !!kind && (boolValue(item.ready ?? item.is_ready) || (readyAt > 0 && this.nowMs >= readyAt));
        const stage = ready ? 4 : progress >= .72 ? 3 : progress >= .42 ? 2 : progress >= .12 ? 1 : 0;
        return {
          raw: item,
          plotNo,
          cropKind: locked ? 'locked' : kind,
          name: locked ? '待解锁' : (seed?.name || (kind ? '生长中的作物' : '空闲土地')),
          unlockDays,
          locked,
          empty: !locked && !kind,
          planted: !locked && !!kind,
          plantedAt,
          readyAt,
          remainingSeconds: intValue(item.remaining_seconds ?? item.remainingSeconds, readyAt ? Math.max(0, Math.ceil((readyAt - this.nowMs) / 1000)) : 0),
          ready,
          watered: boolValue(item.watered ?? item.is_watered) || !!item.watered_at,
          stage,
          progress,
        };
      });
    },

    normalizeFriends(items) {
      return (Array.isArray(items) ? items : []).map((item, index) => {
        const friendCrop = item.crop && typeof item.crop === 'object' ? item.crop : {};
        const kind = cropKind(item.crop_kind ?? item.cropKind ?? friendCrop.kind ?? item.crop) || BASE_SEEDS[index % BASE_SEEDS.length].kind;
        const seed = this.seeds.find(entry => entry.kind === kind) || BASE_SEEDS[0];
        return {
          raw: item,
          id: item.id ?? item.friend_id ?? item.friendId ?? String(index + 1),
          name: String(item.name || item.nickname || `农场邻居 ${index + 1}`),
          level: intValue(item.level, index + 3),
          cropKind: kind,
          cropName: item.crop_name || item.cropName || friendCrop.name || seed.name,
          rewardCoins: intValue(item.reward_coins ?? item.coins ?? friendCrop.coins, [20, 35, 55][index % 3]),
          available: boolValue(item.available ?? item.can_steal, !boolValue(item.stolen_today ?? item.claimed ?? item.stolen)),
          color: item.color || item.tone || FRIEND_COLORS[index % FRIEND_COLORS.length],
        };
      });
    },

    applyFriends(result) {
      const data = unwrap(result);
      const items = data.list || data.friends || data.items || (Array.isArray(data) ? data : []);
      this.friends = this.normalizeFriends(items);
      this.friendsMode = String(data.mode || (this.friends.length ? 'available' : 'empty'));
      this.friendsMessage = String(data.message || '当前账号暂无可访问的好友农场。');
      this.stealsLeft = intValue(data.steals_remaining ?? data.steals_left ?? data.stealsLeft ?? data.remaining, this.stealsLeft);
    },

    refreshTemporalPlots() {
      let changed = false;
      this.plots = this.plots.map(plot => {
        if (!plot.planted || plot.ready || !plot.readyAt) return plot;
        const ready = this.nowMs >= plot.readyAt;
        const progress = plot.readyAt > plot.plantedAt ? Math.max(0, Math.min(1, (this.nowMs - plot.plantedAt) / (plot.readyAt - plot.plantedAt))) : plot.progress;
        const stage = ready ? 4 : progress >= .72 ? 3 : progress >= .42 ? 2 : progress >= .12 ? 1 : 0;
        if (ready !== plot.ready || stage !== plot.stage) changed = true;
        return { ...plot, ready, progress, stage };
      });
      if (changed) this.syncSelectedPlot();
    },

    syncSelectedPlot() {
      if (!this.selectedPlot) return;
      this.selectedPlot = this.plots.find(plot => plot.plotNo === this.selectedPlot.plotNo) || null;
    },

    plotClasses(plot) {
      return {
        'is-locked': plot.locked,
        'is-empty': plot.empty,
        'is-planted': plot.planted,
        'is-ready': plot.ready,
        'is-watered': plot.watered,
        'is-selected': this.selectedPlot?.plotNo === plot.plotNo,
      };
    },

    cropSprite(plot) {
      const kind = plot.locked ? 'locked' : (plot.cropKind || (plot.empty ? 'empty' : 'carrot'));
      return cropSvg(kind, intValue(plot.stage, 4));
    },

    plotStatus(plot) {
      if (plot.locked) return `${plot.unlockDays}天解锁`;
      if (plot.empty) return '点击种植';
      if (plot.ready) return '成熟啦';
      if (plot.readyAt) return formatDuration((plot.readyAt - this.nowMs) / 1000);
      if (plot.remainingSeconds) return formatDuration(plot.remainingSeconds);
      return '生长中';
    },

    plotActionHint(plot) {
      if (plot.locked) return `连续活跃 ${plot.unlockDays} 天后开放`;
      if (plot.empty) return '选择一种种子开始种植';
      if (plot.ready) return '作物已经成熟，收获可获得农场币和经验';
      if (plot.watered) return `已浇水 · 还需 ${this.plotStatus(plot)}`;
      return `消耗 1 体力浇水，可缩短剩余成熟时间 20%`;
    },

    choosePlot(plot) {
      if (plot.locked) {
        this.showToast(`连续活跃 ${plot.unlockDays} 天即可解锁这块土地`, 'info');
        return;
      }
      this.selectedPlot = plot;
      if (plot.empty) this.openSeedPicker(plot);
    },

    openSeedPicker(plot) {
      if (!plot?.empty || this.busy) return;
      this.seedPlot = plot;
      this.seedPickerOpen = true;
    },

    closeSeedPicker() {
      if (this.busy) return;
      this.seedPickerOpen = false;
      this.seedPlot = null;
    },

    async plantSeed(seed) {
      const plot = this.seedPlot;
      if (!plot || this.busy) return;
      if (this.coins < seed.cost) {
        this.showToast('农场币不足，先收获已有作物吧', 'error');
        return;
      }
      await this.runAction('plant', plot.plotNo, () => api.farmPlant(plot.plotNo, seed.apiKind, makeIdempotencyKey(`plant-${plot.plotNo}-${seed.apiKind}`)), `${seed.name}已经种下`);
      this.seedPickerOpen = false;
      this.seedPlot = null;
    },

    async waterPlot(plot) {
      if (!plot || this.busy || plot.watered) return;
      if (this.energy < 1) {
        this.showToast('体力不足，稍后会自动恢复', 'error');
        return;
      }
      await this.runAction('water', plot.plotNo, () => api.farmWater(plot.plotNo, makeIdempotencyKey(`water-${plot.plotNo}`)), '浇水成功，成熟时间已缩短');
    },

    async harvestPlot(plot) {
      if (!plot || this.busy || !plot.ready) return;
      await this.runAction('harvest', plot.plotNo, () => api.farmHarvest(plot.plotNo, makeIdempotencyKey(`harvest-${plot.plotNo}`)), '收获成功');
    },

    async stealFrom(friend) {
      if (!friend?.available || this.busy || this.stealsLeft < 1) return;
      await this.runAction('steal', 0, () => api.farmSteal(friend.id, makeIdempotencyKey(`steal-${friend.id}`)), `从${friend.name}的农场采摘成功`);
      await api.farmFriends().then(result => this.applyFriends(result)).catch(() => {});
    },

    async runAction(action, plotNo, request, fallbackMessage) {
      this.busy = true;
      this.activePlotNo = plotNo;
      try {
        const result = await request();
        const data = unwrap(result);
        const embeddedState = data.state || data.farm_state || data.farm || (data.profile && data.plots ? data : null);
        if (embeddedState) this.applyState({ data: embeddedState });
        else await this.loadState(true);
        const added = intValue(data.points_added ?? data.daily_points_added ?? data.daily_reward?.points_added, 0);
        if (data.daily_reward && (data.daily_reward.already_claimed || added > 0)) this.dailyClaimed = true;
        if (added > 0) {
          const rewardBalance = data.daily_reward?.balance;
          this.points = rewardBalance && typeof rewardBalance === 'object'
            ? intValue(rewardBalance.points ?? rewardBalance.total_points, this.points + added)
            : this.points + added;
          this.showToast(`${fallbackMessage}，今日首收奖励 +${added} 惑梦币`, 'success', 4200);
        } else {
          this.showToast(data.message || fallbackMessage, 'success');
        }
        if (action === 'harvest') {
          const refreshed = await Promise.allSettled([api.credits(), api.rewards(), api.profile()]);
          if (refreshed[0].status === 'fulfilled') this.applyCredits(refreshed[0].value);
          if (refreshed[1].status === 'fulfilled') this.applyDailyMeta(refreshed[1].value);
          if (refreshed[2].status === 'fulfilled') {
            this.user = unwrap(refreshed[2].value);
            if (this.user?.id) setCachedUser(this.user);
          }
        }
      } catch (error) {
        const message = error instanceof ApiError ? error.message : (error?.message || '操作失败，请稍后重试');
        this.showToast(message, 'error', 4000);
      } finally {
        this.busy = false;
        this.activePlotNo = 0;
      }
    },

    energyRecoveryText() {
      if (this.energy >= this.energyMax) return '体力已满';
      const nextAt = this.nextEnergyAt || (this.energyUpdatedAt ? this.energyUpdatedAt + 30 * 60 * 1000 : 0);
      if (!nextAt) return '每 30 分钟 +1';
      return `${formatDuration((nextAt - this.nowMs) / 1000)}后 +1`;
    },

    showToast(message, type = 'info', duration = 3000) {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toast = { message: String(message || ''), type };
      this.toastTimer = setTimeout(() => { this.toast = null; }, duration);
    },
  };
}

window.farmPage = farmPage;
document.addEventListener('alpine:init', () => {
  if (window.Alpine?.data) window.Alpine.data('farmPage', farmPage);
});
