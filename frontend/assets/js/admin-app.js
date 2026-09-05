// 惑梦（Homer） 管理后台 Alpine.js 应用
import { api, isLoggedIn, formatDateTime, ApiError } from '/assets/js/api.js?v=20260905-notices-v1';

function adminPanel() {
  return {
    state: 'loading',
    activeTab: 'stats',
    loading: false,
    toast: null,
    toastTimer: null,
    adminInfo: null,
    notifications: [],
    notificationForm: null,
    notificationBusy: false,
    notificationError: '',
    errorMessage: '',
    errorDetail: '',

    tabs: [
      { id: 'notifications', label: '通知管理', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" d="M6 8a6 6 0 0112 0v8l2 2H4l2-2V8m4 12h4"/></svg>' },
      { id: 'stats', label: '数据总览', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>' },
      { id: 'users', label: '用户管理', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-9a4 4 0 11-8 0 4 4 0 018 0zM21 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>' },
      { id: 'logs', label: '请求日志', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>' },
      { id: 'orders', label: '充值订单', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"/></svg>' },
      { id: 'redeem', label: '兑换码', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7h3a2 2 0 012 2v1m-5-3V5a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2h2m8-8L7 15m10 0h2a2 2 0 002-2v-1m-4 3v4a2 2 0 01-2 2H9a2 2 0 01-2-2v-4"/></svg>' },
      { id: 'contests', label: '赛事', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 4h8v3a4 4 0 01-8 0V4zm0 2H4v1a4 4 0 004 4m8-5h4v1a4 4 0 01-4 4M12 11v5m-4 4h8m-6-4h4"/></svg>' },
      { id: 'site', label: '运营配置', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h10M4 18h7m8-7l-2 2-1-1m3 4l-2 2-1-1"/></svg>' },
      { id: 'llm', label: '模型配置', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>' },
      { id: 'global-presets', label: '全局预设', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h10M18 16l2 2 3-3"/></svg>' },
      { id: 'plugins', label: '对话扩展', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3M5 11h14M7 21h10a2 2 0 002-2v-8H5v8a2 2 0 002 2zm5-6v3m-2-2h4"/></svg>' },
      { id: 'apps', label: '角色卡', icon: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14-7H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zm-3 11l-2-2-4 4"/></svg>' },
    ],
    navLabelItems: [
      { key: 'home', label: '首页' },
      { key: 'workshop', label: '创作工坊' },
      { key: 'histories', label: '历史会话' },
      { key: 'group', label: '群聊' },
      { key: 'me', label: '我的' },
      { key: 'favorites', label: '我的收藏' },
      { key: 'image', label: '图片聊天' },
      { key: 'rewards', label: '农场奖励' },
      { key: 'logs', label: '操作记录' },
      { key: 'deposit', label: '积分充值' },
      { key: 'info', label: '信息中心' },
    ],
    mobileNavLabelItems: [
      { key: 'home', label: '首页' },
      { key: 'group', label: '群聊' },
      { key: 'workshop', label: '创作' },
      { key: 'favorites', label: '收藏' },
      { key: 'me', label: '我的' },
    ],
    appShellCopyItems: [
      { key: 'shell_profile_title', label: '用户卡链接 title', max: 40 },
      { key: 'shell_guest_name', label: '用户卡昵称兜底', max: 40 },
      { key: 'shell_points_suffix', label: '用户卡积分后缀', max: 20 },
    ],
    appHomeCopyItems: [
      { key: 'topbar_title', label: '首页标题', max: 30 },
      { key: 'search_placeholder', label: '搜索框占位', max: 80 },
      { key: 'pictureless_off', label: '无图模式关闭文案', max: 40 },
      { key: 'pictureless_on', label: '无图模式开启文案', max: 40 },
      { key: 'favorite_label', label: '收藏按钮无障碍名', max: 30 },
      { key: 'official_author', label: '官方作者兜底', max: 40 },
      { key: 'unnamed_role', label: '未命名角色兜底', max: 40 },
      { key: 'summary_fallback', label: '卡片简介兜底', max: 120 },
      { key: 'load_more_text', label: '加载更多按钮', max: 40 },
      { key: 'end_text', label: '到底提示', max: 40 },
      { key: 'redirect_text', label: '探索旧入口跳转文字', max: 60 },
      { key: 'redirect_link_text', label: '探索旧入口链接文字', max: 40 },
    ],
    appHomeCategoryItems: [
      { key: 'all', label: '全部' },
      { key: '恋爱', label: '恋爱' },
      { key: '二次元', label: '二次元' },
      { key: '游戏', label: '游戏' },
      { key: 'urban', label: '都市' },
      { key: 'history', label: '历史' },
      { key: 'fantasy', label: '玄幻' },
      { key: 'scifi', label: '科幻' },
      { key: 'mystery', label: '悬疑' },
    ],
    appHomeRankItems: [
      { key: 'daily', label: '日榜' },
      { key: 'weekly', label: '周榜' },
      { key: 'monthly', label: '月榜' },
      { key: 'overall', label: '总榜' },
    ],
    appHomeSortItems: [
      { key: 'random', label: '随机' },
      { key: 'popular', label: '热门' },
      { key: 'latest', label: '最新' },
      { key: 'updated', label: '更新' },
    ],
    authCopyItems: [
      { key: 'brand_subtitle', label: '登录页副标语', max: 80 },
      { key: 'login_tab_label', label: '登录 Tab', max: 20 },
      { key: 'register_tab_label', label: '注册 Tab', max: 20 },
      { key: 'reset_tab_label', label: '重置密码 Tab', max: 20 },
      { key: 'login_button_text', label: 'App 登录按钮', max: 30 },
      { key: 'login_hint', label: 'App 登录提示', max: 120 },
      { key: 'forgot_password_text', label: '忘记密码链接', max: 30 },
      { key: 'reset_title', label: '重置页标题', max: 60 },
      { key: 'reset_subtitle', label: '重置页说明', max: 140 },
      { key: 'reset_email_hint', label: '重置邮箱提示', max: 120 },
      { key: 'reset_button_text', label: '重置提交按钮', max: 30 },
      { key: 'register_button_text', label: '注册按钮', max: 30 },
      { key: 'send_code_button_text', label: '验证码按钮', max: 20 },
      { key: 'home_link_text', label: '返回首页链接', max: 30 },
      { key: 'dashboard_title', label: '用户中心未登录标题', max: 80 },
      { key: 'dashboard_subtitle', label: '用户中心未登录说明', max: 140 },
      { key: 'dashboard_login_title', label: '用户中心登录表单标题', max: 60 },
      { key: 'dashboard_register_title', label: '用户中心注册表单标题', max: 60 },
      { key: 'dashboard_login_button_text', label: '用户中心登录按钮', max: 30 },
      { key: 'dashboard_login_hint', label: '登录表单提示', max: 80 },
      { key: 'dashboard_register_link_text', label: '注册链接文案', max: 30 },
      { key: 'register_hint_email', label: '注册邮箱提示', max: 120 },
      { key: 'register_hint_points', label: '注册送积分提示', max: 120 },
      { key: 'email_label', label: '邮箱标签', max: 30 },
      { key: 'email_placeholder', label: '邮箱占位', max: 80 },
      { key: 'password_label', label: '密码标签', max: 30 },
      { key: 'login_password_placeholder', label: '登录密码占位', max: 80 },
      { key: 'code_label', label: '验证码标签', max: 30 },
      { key: 'code_placeholder', label: '验证码占位', max: 40 },
      { key: 'nickname_label', label: '昵称标签', max: 30 },
      { key: 'nickname_placeholder', label: '昵称占位', max: 80 },
      { key: 'register_password_placeholder', label: '注册密码占位', max: 80 },
      { key: 'reset_password_placeholder', label: '重置密码占位', max: 80 },
      { key: 'invalid_email_text', label: '邮箱校验提示', max: 80 },
      { key: 'code_sent_text', label: '验证码发送成功', max: 100 },
      { key: 'reset_code_sent_text', label: '重置验证码发送成功', max: 100 },
      { key: 'send_failed_text', label: '验证码发送失败', max: 80 },
      { key: 'login_success_text', label: '登录成功提示', max: 80 },
      { key: 'login_failed_text', label: '登录失败提示', max: 80 },
      { key: 'reset_success_text', label: '重置成功提示', max: 80 },
      { key: 'reset_failed_text', label: '重置失败提示', max: 80 },
      { key: 'register_success_text', label: '注册成功提示', max: 100 },
      { key: 'register_failed_text', label: '注册失败提示', max: 80 },
      { key: 'login_invalid_response_text', label: '登录异常响应提示', max: 80 },
      { key: 'register_invalid_response_text', label: '注册异常响应提示', max: 80 },
      { key: 'reset_invalid_response_text', label: '重置异常响应提示', max: 80 },
    ],
    dashboardCopyItems: [
      { key: 'unnamed_user', label: '未命名用户兜底', max: 40 },
      { key: 'purchase_section_label', label: '购买兑换区眉标', max: 40 },
      { key: 'balance_title', label: '余额卡标题', max: 60 },
      { key: 'balance_updated_label', label: '更新时间标签', max: 30 },
      { key: 'balance_refresh_text', label: '刷新按钮', max: 20 },
      { key: 'balance_free_label', label: '免费额度标签', max: 20 },
      { key: 'balance_paid_label', label: '充值额度标签', max: 20 },
      { key: 'balance_reward_label', label: '奖励额度标签', max: 20 },
      { key: 'daily_checkin_title', label: '农场入口标题', max: 40 },
      { key: 'download_title', label: '下载入口标题', max: 40 },
      { key: 'download_subtitle', label: '下载入口说明', max: 80 },
      { key: 'admin_card_title', label: '后台入口标题', max: 40 },
      { key: 'admin_card_subtitle', label: '后台入口说明', max: 80 },
      { key: 'api_title', label: 'API 信息标题', max: 60 },
      { key: 'api_endpoint_label', label: 'API 端点标签', max: 40 },
      { key: 'app_endpoint_label', label: '服务地址标签', max: 40 },
      { key: 'user_id_label', label: '用户 ID 标签', max: 40 },
      { key: 'api_note', label: 'API 提示', max: 240 },
      { key: 'daily_points_template', label: '农场奖励副文案模板', max: 60 },
      { key: 'points_failed_text', label: '积分获取失败', max: 80 },
      { key: 'redeem_empty_text', label: '兑换码为空提示', max: 80 },
      { key: 'redeem_success_template', label: '兑换成功 Toast', max: 80 },
      { key: 'redeem_success_detail_template', label: '奖励页兑换成功', max: 100 },
      { key: 'redeem_failed_text', label: '兑换失败提示', max: 80 },
      { key: 'checkin_success_template', label: '旧签到成功 Toast（兼容）', max: 80 },
      { key: 'checkin_reward_success_template', label: '旧奖励页签到成功（兼容）', max: 100 },
      { key: 'checkin_repeat_text', label: '旧签到重复提示（兼容）', max: 80 },
      { key: 'checkin_failed_text', label: '旧签到失败提示（兼容）', max: 80 },
      { key: 'claim_failed_text', label: '奖励领取失败', max: 80 },
      { key: 'logout_success_text', label: '退出登录提示', max: 80 },
      { key: 'aifadian_missing_text', label: '购买链接未配置提示', max: 120 },
    ],
    accountCopyItems: [
      { key: 'topbar_title', label: '我的页标题', max: 30 },
      { key: 'full_account_button', label: '完整账户按钮', max: 30 },
      { key: 'profile_registered_label', label: '注册时间标签', max: 30 },
      { key: 'persona_section_label', label: '人设区眉标', max: 40 },
      { key: 'persona_title', label: '人设区标题', max: 60 },
      { key: 'persona_description', label: '人设区说明', max: 240 },
      { key: 'model_section_label', label: '模型区眉标', max: 40 },
      { key: 'model_title', label: '模型区标题', max: 60 },
      { key: 'model_description', label: '模型区说明', max: 240 },
      { key: 'app_info_title', label: 'APP 信息标题', max: 60 },
      { key: 'app_info_note', label: 'APP 信息说明', max: 200 },
      { key: 'persona_name_label', label: '人设名称标签', max: 40 },
      { key: 'persona_name_placeholder', label: '人设名称占位', max: 120 },
      { key: 'persona_description_label', label: '人设描述标签', max: 40 },
      { key: 'persona_description_placeholder', label: '人设描述占位', max: 180 },
      { key: 'persona_save_button', label: '保存人设按钮', max: 40 },
      { key: 'persona_saved_text', label: '人设保存成功', max: 120 },
      { key: 'model_display_name_placeholder', label: '模型显示名占位', max: 80 },
      { key: 'model_protocol_openai', label: 'OpenAI 协议名', max: 50 },
      { key: 'model_protocol_anthropic', label: 'Anthropic 协议名', max: 50 },
      { key: 'model_openai_base_placeholder', label: 'OpenAI Base URL 占位', max: 120 },
      { key: 'model_anthropic_base_placeholder', label: 'Anthropic Base URL 占位', max: 120 },
      { key: 'model_name_placeholder', label: '模型名占位', max: 100 },
      { key: 'model_api_key_placeholder', label: 'API Key 占位', max: 60 },
      { key: 'model_keep_key_placeholder_template', label: '保留 Key 占位模板', max: 100 },
      { key: 'model_temperature_placeholder', label: '温度占位', max: 40 },
      { key: 'model_enabled_label', label: '启用标签', max: 30 },
      { key: 'model_default_label', label: '默认标签', max: 30 },
      { key: 'model_remove_text', label: '删除模型按钮', max: 30 },
      { key: 'add_openai_button', label: '添加 OpenAI 按钮', max: 60 },
      { key: 'add_openrouter_button', label: '添加 OpenRouter 按钮', max: 60 },
      { key: 'add_anthropic_button', label: '添加 Claude 按钮', max: 60 },
      { key: 'save_models_button', label: '保存模型按钮', max: 60 },
      { key: 'model_saved_text', label: '模型保存成功', max: 100 },
      { key: 'model_save_failed_text', label: '模型保存失败', max: 80 },
      { key: 'save_failed_text', label: '我的页保存失败', max: 80 },
      { key: 'custom_openai_name', label: '自定义 OpenAI 名称', max: 80 },
      { key: 'custom_anthropic_name', label: '自定义 Anthropic 名称', max: 80 },
      { key: 'new_model_name_template', label: '新模型名模板', max: 60 },
      { key: 'daily_checkin_template', label: '我的页农场按钮模板（兼容旧配置）', max: 60 },
    ],
    myAppsCopyItems: [
      { key: 'topbar_title', label: '页面标题', max: 40 },
      { key: 'new_role_text', label: '新建角色按钮', max: 40 },
      { key: 'unnamed_role', label: '未命名角色兜底', max: 40 },
      { key: 'summary_fallback', label: '简介兜底', max: 120 },
      { key: 'detail_text', label: '详情按钮', max: 30 },
      { key: 'edit_text', label: '编辑按钮', max: 30 },
      { key: 'delete_text', label: '删除按钮', max: 30 },
      { key: 'edit_modal_title', label: '编辑弹窗标题', max: 60 },
      { key: 'close_text', label: '关闭按钮', max: 30 },
      { key: 'name_label', label: '名称标签', max: 30 },
      { key: 'summary_label', label: '简介标签', max: 30 },
      { key: 'description_label', label: '设定标签', max: 30 },
      { key: 'opening_label', label: '开场白标签', max: 30 },
      { key: 'tags_label', label: '标签标签', max: 30 },
      { key: 'cover_label', label: '封面 URL 标签', max: 40 },
      { key: 'cancel_text', label: '取消按钮', max: 30 },
      { key: 'save_text', label: '保存按钮', max: 30 },
      { key: 'load_failed_text', label: '加载失败提示', max: 80 },
      { key: 'validate_name', label: '缺名称提示', max: 80 },
      { key: 'saved_success', label: '保存成功提示', max: 60 },
      { key: 'save_failed', label: '保存失败提示', max: 80 },
      { key: 'delete_confirm_template', label: '删除确认模板', max: 120 },
      { key: 'deleted_success', label: '删除成功提示', max: 60 },
      { key: 'delete_failed', label: '删除失败提示', max: 80 },
    ],
    depositDisplayItems: [
      { key: 'title', label: '购买卡标题', max: 60 },
      { key: 'description', label: '购买卡说明', max: 180 },
      { key: 'button_text', label: '购买按钮', max: 40 },
      { key: 'redeem_button_text', label: '兑换按钮', max: 40 },
      { key: 'redeem_placeholder', label: '兑换码占位', max: 60 },
    ],
    rewardsCopyItems: [
      { key: 'page_title', label: '奖励页顶部标题', max: 60 },
      { key: 'credits_eyebrow', label: '余额卡眉标', max: 80 },
      { key: 'balance_suffix', label: '余额说明后缀', max: 80 },
      { key: 'balance_unit_suffix', label: '余额分类后缀', max: 20 },
      { key: 'packages_title', label: '套餐区标题', max: 60 },
      { key: 'purchase_button_fallback', label: '购买按钮兜底', max: 40 },
      { key: 'bonus_prefix', label: '套餐奖励前缀', max: 40 },
      { key: 'daily_claimed_text', label: '已领取按钮', max: 40 },
      { key: 'daily_claim_template', label: '领取按钮模板', max: 60 },
      { key: 'task_available_label', label: '任务可完成状态', max: 40 },
      { key: 'redemptions_title', label: '兑换记录标题', max: 60 },
      { key: 'redemptions_hint', label: '兑换记录说明', max: 120 },
      { key: 'redemptions_refresh_text', label: '兑换记录刷新按钮', max: 30 },
    ],
    emptyStateItems: [
      { key: 'explore_no_results', label: '探索无结果', max: 120 },
      { key: 'favorites_empty_title', label: '收藏空态', max: 120 },
      { key: 'favorites_cta_text', label: '收藏空态按钮', max: 40 },
      { key: 'histories_empty_title', label: '历史空态标题', max: 120 },
      { key: 'histories_empty_hint', label: '历史空态链接', max: 120 },
      { key: 'histories_cta_text', label: '新对话按钮', max: 40 },
      { key: 'my_apps_empty_title', label: '我的角色空态', max: 120 },
      { key: 'my_apps_cta_text', label: '我的角色按钮', max: 40 },
      { key: 'logs_empty_title', label: '操作记录空态', max: 120 },
      { key: 'redemptions_empty_title', label: '兑换记录空态', max: 120 },
      { key: 'workshop_empty_title', label: '工坊角色空态', max: 140 },
      { key: 'image_status_badge', label: '图片聊天状态', max: 40 },
      { key: 'image_drop_text', label: '图片上传提示', max: 160 },
      { key: 'image_prompt_placeholder', label: '图片提示词占位', max: 160 },
      { key: 'image_send_button', label: '图片发送按钮', max: 40 },
      { key: 'image_empty_text', label: '图片回复空态', max: 260 },
      { key: 'image_reply_title', label: '图片回复标题', max: 40 },
      { key: 'workshop_eyebrow', label: '工坊眉标', max: 60 },
      { key: 'workshop_title', label: '工坊主标题', max: 120 },
      { key: 'workshop_copy', label: '工坊说明', max: 240 },
      { key: 'workshop_create_title', label: '工坊新建标题', max: 40 },
      { key: 'workshop_create_copy', label: '工坊新建说明', max: 80 },
      { key: 'workshop_my_roles_title', label: '工坊我的角色标题', max: 40 },
      { key: 'workshop_my_roles_copy', label: '工坊我的角色说明', max: 80 },
      { key: 'workshop_official_title', label: '工坊官方标题', max: 40 },
      { key: 'workshop_official_copy', label: '工坊官方说明', max: 80 },
      { key: 'workshop_library_title', label: '工坊角色库标题', max: 40 },
      { key: 'workshop_library_prefix', label: '角色库数量前缀', max: 40 },
      { key: 'workshop_library_suffix', label: '角色库数量后缀', max: 40 },
    ],
    characterCopyItems: [
      { key: 'back_text', label: '返回按钮', max: 20 },
      { key: 'page_title', label: '页面标题', max: 40 },
      { key: 'start_chat_text', label: '开始聊天按钮', max: 30 },
      { key: 'unnamed_role', label: '未命名角色', max: 40 },
      { key: 'summary_fallback', label: '简介兜底', max: 120 },
      { key: 'user_badge', label: '用户角色徽标', max: 30 },
      { key: 'official_badge', label: '角色设定徽标', max: 30 },
      { key: 'setting_title', label: '旧设定区标题', max: 40 },
      { key: 'comment_title', label: '评论区标题', max: 40 },
      { key: 'comment_empty_text', label: '评论区空态', max: 120 },
      { key: 'opening_title', label: '开场白标题', max: 40 },
      { key: 'create_role_text', label: '创建角色按钮', max: 30 },
      { key: 'not_found_text', label: '未找到提示', max: 120 },
      { key: 'back_to_explore_text', label: '回探索按钮', max: 40 },
    ],
    chatCopyItems: [
      { key: 'conversation_list_title', label: '会话列表标题', max: 40 },
      { key: 'new_role_link', label: '新角色链接', max: 30 },
      { key: 'creating_label', label: '创建中状态', max: 30 },
      { key: 'new_conversation_prefix', label: '新会话前缀', max: 20 },
      { key: 'new_conversation_suffix', label: '新会话后缀', max: 40 },
      { key: 'current_role_fallback', label: '当前角色兜底', max: 40 },
      { key: 'no_conversations_title', label: '无会话标题', max: 80 },
      { key: 'no_conversations_prefix', label: '无会话连接词', max: 20 },
      { key: 'no_conversations_link', label: '无会话链接', max: 30 },
      { key: 'no_conversations_suffix', label: '无会话后缀', max: 80 },
      { key: 'unnamed_conversation', label: '未命名会话', max: 40 },
      { key: 'continue_preview', label: '继续对话提示', max: 60 },
      { key: 'new_role_name', label: '新角色名称兜底', max: 40 },
      { key: 'new_chat_title', label: '新对话标题', max: 40 },
      { key: 'conversation_fallback_title', label: '会话标题兜底', max: 40 },
      { key: 'hero_continue_title', label: '头图区继续标题', max: 40 },
      { key: 'hero_empty_title', label: '头图区空标题', max: 60 },
      { key: 'hero_empty_hint', label: '头图区空提示', max: 120 },
      { key: 'memory_tool_title', label: '记忆按钮提示', max: 30 },
      { key: 'memory_title', label: '记忆抽屉标题', max: 40 },
      { key: 'summary_label', label: '摘要标签', max: 40 },
      { key: 'summary_placeholder', label: '摘要占位', max: 80 },
      { key: 'auto_summary_button', label: '自动摘要按钮', max: 30 },
      { key: 'save_summary_button', label: '保存摘要按钮', max: 30 },
      { key: 'memory_title_label', label: '记忆标题标签', max: 40 },
      { key: 'memory_title_placeholder', label: '记忆标题占位', max: 80 },
      { key: 'memory_content_label', label: '记忆内容标签', max: 40 },
      { key: 'memory_content_placeholder', label: '记忆内容占位', max: 120 },
      { key: 'memory_keywords_label', label: '关键词标签', max: 40 },
      { key: 'memory_keywords_placeholder', label: '关键词占位', max: 120 },
      { key: 'add_memory_button', label: '添加记忆按钮', max: 30 },
      { key: 'pinned_on_button', label: '已置顶按钮', max: 30 },
      { key: 'pinned_off_button', label: '置顶按钮', max: 30 },
      { key: 'no_memory_text', label: '无记忆提示', max: 80 },
      { key: 'unnamed_memory', label: '未命名记忆', max: 60 },
      { key: 'delete_text', label: '删除文字', max: 30 },
      { key: 'no_role_title', label: '未选角色标题', max: 80 },
      { key: 'no_role_cta', label: '未选角色按钮', max: 30 },
      { key: 'edit_save_button', label: '编辑保存按钮', max: 30 },
      { key: 'edit_cancel_button', label: '编辑取消按钮', max: 30 },
      { key: 'regenerate_text', label: '重新生成', max: 40 },
      { key: 'edit_text', label: '编辑', max: 30 },
      { key: 'speak_text', label: '朗读', max: 30 },
      { key: 'swipe_prev_title', label: '上一条提示', max: 40 },
      { key: 'swipe_next_title', label: '下一条提示', max: 80 },
      { key: 'send_placeholder', label: '输入框占位', max: 120 },
      { key: 'speech_input_title', label: '语音输入提示', max: 40 },
      { key: 'speech_listening_title', label: '听写中提示', max: 40 },
      { key: 'send_aria', label: '发送无障碍名', max: 30 },
      { key: 'delete_conversation_confirm', label: '删除会话确认', max: 160 },
      { key: 'delete_memory_confirm', label: '删除记忆确认', max: 120 },
      { key: 'delete_message_confirm', label: '删除消息确认', max: 120 },
      { key: 'delete_failed_text', label: '删除失败提示', max: 80 },
      { key: 'save_memory_failed_text', label: '保存记忆失败', max: 80 },
      { key: 'delete_memory_failed_text', label: '删除记忆失败', max: 80 },
      { key: 'unsupported_speak_text', label: '不支持朗读', max: 100 },
      { key: 'unsupported_speech_input_text', label: '不支持语音输入', max: 100 },
      { key: 'auto_summary_failed_text', label: '自动摘要失败', max: 80 },
      { key: 'save_summary_failed_text', label: '保存摘要失败', max: 80 },
      { key: 'regenerate_failed_text', label: '重新生成失败', max: 80 },
      { key: 'generate_failed_text', label: '生成失败', max: 80 },
      { key: 'save_failed_text', label: '保存失败', max: 80 },
      { key: 'error_prefix', label: '流式错误前缀', max: 40 },
      { key: 'retry_text', label: '重试提示', max: 80 },
    ],
    creatorCopyItems: [
      { key: 'back_title', label: '返回 title', max: 40 },
      { key: 'back_text', label: '返回文字', max: 20 },
      { key: 'delete_title', label: '删除 title', max: 40 },
      { key: 'delete_text', label: '删除文字', max: 20 },
      { key: 'import_title', label: '导入 title', max: 80 },
      { key: 'importing_text', label: '导入中', max: 30 },
      { key: 'import_text', label: '导入文字', max: 20 },
      { key: 'export_title', label: '导出 JSON title', max: 80 },
      { key: 'export_text', label: '导出文字', max: 20 },
      { key: 'export_png_title', label: '导出 PNG title', max: 80 },
      { key: 'preview_title', label: '预览 title', max: 60 },
      { key: 'preview_text', label: '预览文字', max: 20 },
      { key: 'public_title', label: '公开 title', max: 60 },
      { key: 'private_title', label: '私密 title', max: 60 },
      { key: 'public_text', label: '公开文字', max: 20 },
      { key: 'private_text', label: '私密文字', max: 20 },
      { key: 'save_text', label: '保存文字', max: 20 },
      { key: 'tip_text', label: '顶部提示', max: 180 },
      { key: 'name_label', label: '名称标签', max: 30 },
      { key: 'name_placeholder', label: '名称占位', max: 80 },
      { key: 'summary_label', label: '描述标签', max: 30 },
      { key: 'summary_hint', label: '描述提示', max: 160 },
      { key: 'summary_placeholder', label: '描述占位', max: 120 },
      { key: 'tags_label', label: '标签标签', max: 30 },
      { key: 'tags_hint', label: '标签提示', max: 120 },
      { key: 'tags_placeholder', label: '标签占位', max: 80 },
      { key: 'language_label', label: '语言标签', max: 30 },
      { key: 'language_hint', label: '语言提示', max: 80 },
      { key: 'language_option', label: '语言选项', max: 30 },
      { key: 'nsfw_title', label: 'NSFW 标题', max: 60 },
      { key: 'nsfw_hint', label: 'NSFW 提示', max: 120 },
      { key: 'protect_title', label: '防护标题', max: 60 },
      { key: 'protect_hint', label: '防护提示', max: 120 },
      { key: 'anonymous_title', label: '匿名标题', max: 60 },
      { key: 'anonymous_hint', label: '匿名提示', max: 120 },
      { key: 'media_section_title', label: '视觉素材标题', max: 40 },
      { key: 'cover_label', label: '封面标签', max: 40 },
      { key: 'cover_upload_title', label: '封面上传标题', max: 60 },
      { key: 'cover_upload_hint', label: '封面上传提示', max: 120 },
      { key: 'cover_overlay_text', label: '封面替换提示', max: 30 },
      { key: 'cover_url_placeholder', label: '封面 URL 占位', max: 80 },
      { key: 'bg_label', label: '背景标签', max: 40 },
      { key: 'bg_upload_title', label: '背景上传标题', max: 60 },
      { key: 'bg_upload_hint', label: '背景上传提示', max: 120 },
      { key: 'bg_overlay_text', label: '背景替换提示', max: 30 },
      { key: 'bg_url_placeholder', label: '背景 URL 占位', max: 80 },
      { key: 'prompt_section_title', label: '提示词区标题', max: 40 },
      { key: 'description_label', label: '角色设定标签', max: 40 },
      { key: 'description_hint', label: '角色设定提示', max: 200 },
      { key: 'description_placeholder', label: '角色设定占位', max: 160 },
      { key: 'personality_label', label: '性格标签', max: 40 },
      { key: 'personality_hint', label: '性格提示', max: 160 },
      { key: 'personality_placeholder', label: '性格占位', max: 120 },
      { key: 'scenario_label', label: '场景标签', max: 40 },
      { key: 'scenario_hint', label: '场景提示', max: 160 },
      { key: 'scenario_placeholder', label: '场景占位', max: 160 },
      { key: 'opening_label', label: '开场白标签', max: 40 },
      { key: 'opening_hint', label: '开场白提示', max: 180 },
      { key: 'opening_placeholder', label: '开场白占位', max: 160 },
      { key: 'system_prompt_label', label: '主提示标签', max: 60 },
      { key: 'system_prompt_hint', label: '主提示说明', max: 160 },
      { key: 'system_prompt_placeholder', label: '主提示占位', max: 160 },
      { key: 'example_label', label: '对话示例标签', max: 40 },
      { key: 'example_hint', label: '对话示例说明', max: 180 },
      { key: 'example_placeholder', label: '对话示例占位', max: 220 },
      { key: 'prompt_manager_title', label: 'Prompt Manager 标题', max: 40 },
      { key: 'prompt_manager_hint', label: 'Prompt Manager 提示', max: 240 },
      { key: 'prompt_block_name_prefix', label: '提示词块名称前缀', max: 40 },
      { key: 'greetings_title', label: '备用开场白标题', max: 40 },
      { key: 'greetings_hint', label: '备用开场白提示', max: 160 },
      { key: 'world_title', label: '世界书标题', max: 50 },
      { key: 'world_hint', label: '世界书提示', max: 200 },
      { key: 'world_entry_name_prefix', label: '世界书条目名称前缀', max: 40 },
      { key: 'advanced_title', label: '高级提示词标题', max: 40 },
      { key: 'model_section_title', label: '默认模型标题', max: 50 },
      { key: 'model_hint', label: '默认模型提示', max: 220 },
      { key: 'site_model_group_label', label: '站点模型组名', max: 40 },
      { key: 'user_model_group_label', label: '我的模型组名', max: 40 },
      { key: 'user_model_prefix', label: '我的模型前缀', max: 40 },
      { key: 'voice_title', label: '语音分区标题', max: 40 },
      { key: 'voice_hint', label: '语音分区提示', max: 120 },
      { key: 'voice_note', label: '语音占位说明', max: 160 },
      { key: 'share_title', label: '分享分区标题', max: 50 },
      { key: 'share_hint', label: '分享分区提示', max: 160 },
      { key: 'share_note', label: '分享占位说明', max: 180 },
      { key: 'bottom_note', label: '底部提示', max: 220 },
      { key: 'validate_name', label: '缺名称提示', max: 80 },
      { key: 'validate_summary', label: '缺简介提示', max: 100 },
      { key: 'saved_success', label: '保存成功提示', max: 60 },
      { key: 'created_success', label: '创建成功提示', max: 60 },
      { key: 'save_failed', label: '保存失败提示', max: 80 },
      { key: 'delete_confirm', label: '删除确认', max: 160 },
      { key: 'delete_success', label: '删除成功提示', max: 60 },
      { key: 'delete_failed', label: '删除失败提示', max: 80 },
    ],
    creatorAdvancedCopyItems: [
      { key: 'prompt_enable_title', label: '启用提示词块', max: 40 },
      { key: 'prompt_remove_text', label: '提示词块删除', max: 20 },
      { key: 'prompt_name_label', label: '提示词名称标签', max: 30 },
      { key: 'prompt_name_placeholder', label: '提示词名称占位', max: 80 },
      { key: 'prompt_position_label', label: '注入位置标签', max: 40 },
      { key: 'prompt_position_system_before', label: 'System 前置选项', max: 40 },
      { key: 'prompt_position_system_after', label: 'System 后置选项', max: 40 },
      { key: 'prompt_position_post_history', label: '历史后指令选项', max: 40 },
      { key: 'prompt_order_label', label: '顺序标签', max: 30 },
      { key: 'prompt_content_placeholder', label: '提示词内容占位', max: 120 },
      { key: 'prompt_add_system_before', label: '添加 System 前置', max: 40 },
      { key: 'prompt_add_system_after', label: '添加 System 后置', max: 40 },
      { key: 'prompt_add_post_history', label: '添加历史后指令', max: 50 },
      { key: 'greeting_label_prefix', label: '备用开场白前缀', max: 40 },
      { key: 'greeting_placeholder', label: '备用开场白占位', max: 80 },
      { key: 'add_greeting_text', label: '添加备用开场白', max: 50 },
      { key: 'world_entry_prefix', label: '世界书条目前缀', max: 30 },
      { key: 'world_delete_text', label: '世界书删除', max: 20 },
      { key: 'world_name_placeholder', label: '世界书名称占位', max: 60 },
      { key: 'world_position_system', label: '系统提示选项', max: 40 },
      { key: 'world_position_depth', label: '深度插入选项', max: 40 },
      { key: 'world_position_post_history', label: '历史后插入选项', max: 40 },
      { key: 'world_keys_placeholder', label: '关键词占位', max: 120 },
      { key: 'world_secondary_keys_placeholder', label: '二级关键词占位', max: 140 },
      { key: 'world_content_placeholder', label: '世界书内容占位', max: 120 },
      { key: 'world_priority_label', label: '优先级标签', max: 30 },
      { key: 'world_order_label', label: '排序标签', max: 30 },
      { key: 'world_depth_label', label: '插入深度标签', max: 30 },
      { key: 'world_probability_label', label: '触发概率标签', max: 40 },
      { key: 'world_enabled_title', label: '世界书启用', max: 30 },
      { key: 'world_constant_title', label: '常驻注入', max: 40 },
      { key: 'world_selective_title', label: '二级命中', max: 40 },
      { key: 'world_recursive_title', label: '递归扫描', max: 40 },
      { key: 'add_world_text', label: '添加世界书', max: 50 },
      { key: 'post_history_label', label: '历史后指令标签', max: 40 },
      { key: 'post_history_hint', label: '历史后指令说明', max: 180 },
      { key: 'post_history_placeholder', label: '历史后指令占位', max: 120 },
      { key: 'quick_replies_label', label: '快捷回复标题', max: 40 },
      { key: 'quick_replies_hint', label: '快捷回复说明', max: 140 },
      { key: 'quick_reply_name_prefix', label: '快捷回复名称前缀', max: 40 },
      { key: 'quick_reply_enable_title', label: '启用快捷回复', max: 40 },
      { key: 'quick_reply_label_placeholder', label: '快捷回复按钮占位', max: 60 },
      { key: 'quick_reply_order_placeholder', label: '快捷回复顺序占位', max: 40 },
      { key: 'quick_reply_message_placeholder', label: '快捷回复内容占位', max: 80 },
      { key: 'add_quick_reply_text', label: '添加快捷回复', max: 50 },
      { key: 'regex_label', label: 'Regex 标题', max: 40 },
      { key: 'regex_hint', label: 'Regex 说明', max: 140 },
      { key: 'regex_name_prefix', label: 'Regex 名称前缀', max: 40 },
      { key: 'regex_enable_title', label: '启用 Regex', max: 40 },
      { key: 'regex_name_placeholder', label: 'Regex 名称占位', max: 60 },
      { key: 'regex_flags_placeholder', label: 'Regex flags 占位', max: 40 },
      { key: 'regex_find_placeholder', label: 'Regex 查找占位', max: 60 },
      { key: 'regex_replace_placeholder', label: 'Regex 替换占位', max: 60 },
      { key: 'add_regex_text', label: '添加 Regex', max: 40 },
      { key: 'default_model_label', label: '默认模型标签', max: 40 },
      { key: 'default_model_option', label: '默认模型空选项', max: 60 },
      { key: 'sampling_temperature_label', label: '温度标签', max: 30 },
      { key: 'sampling_temperature_hint', label: '温度说明', max: 120 },
      { key: 'sampling_top_p_label', label: 'Top P 标签', max: 30 },
      { key: 'sampling_top_p_hint', label: 'Top P 说明', max: 120 },
      { key: 'sampling_presence_label', label: '存在惩罚标签', max: 40 },
      { key: 'sampling_presence_hint', label: '存在惩罚说明', max: 120 },
      { key: 'sampling_frequency_label', label: '频率惩罚标签', max: 40 },
      { key: 'sampling_frequency_hint', label: '频率惩罚说明', max: 120 },
      { key: 'sampling_history_label', label: '历史长度标签', max: 40 },
      { key: 'sampling_history_hint', label: '历史长度说明', max: 180 },
      { key: 'voice_assign_text', label: '语音分配按钮', max: 80 },
      { key: 'share_duration_label', label: '分享有效期标签', max: 40 },
      { key: 'share_duration_option', label: '分享有效期选项', max: 30 },
      { key: 'share_button_text', label: '创建分享按钮', max: 80 },
      { key: 'cover_uploaded', label: '封面上传成功', max: 60 },
      { key: 'cover_upload_failed', label: '封面上传失败', max: 80 },
      { key: 'bg_uploaded', label: '背景上传成功', max: 60 },
      { key: 'bg_upload_failed', label: '背景上传失败', max: 80 },
      { key: 'import_invalid_file', label: '导入文件无效', max: 100 },
      { key: 'import_success', label: '导入成功提示', max: 80 },
      { key: 'import_failed', label: '导入失败提示', max: 80 },
      { key: 'export_success', label: '导出成功提示', max: 60 },
      { key: 'export_failed', label: '导出失败提示', max: 80 },
      { key: 'png_export_success', label: 'PNG 导出成功', max: 80 },
      { key: 'png_export_failed', label: 'PNG 导出失败', max: 80 },
      { key: 'load_existing_failed', label: '读取角色失败', max: 80 },
    ],
    groupChatCopyItems: [
      { key: 'page_title', label: '页面标题', max: 40 },
      { key: 'empty_groups', label: '无群聊提示', max: 80 },
      { key: 'member_count_suffix', label: '成员数量后缀', max: 20 },
      { key: 'last_message_default', label: '列表默认预览', max: 60 },
      { key: 'empty_current_title', label: '未选群聊标题', max: 80 },
      { key: 'empty_current_hint', label: '未选群聊说明', max: 120 },
      { key: 'delete_group_button', label: '删除群聊按钮', max: 40 },
      { key: 'no_current_text', label: '空态提示', max: 100 },
      { key: 'user_speaker', label: '用户发言人', max: 30 },
      { key: 'assistant_speaker', label: '角色发言人兜底', max: 30 },
      { key: 'loading_speaker', label: '生成中发言人', max: 30 },
      { key: 'force_reply_label', label: '指定发言标签', max: 40 },
      { key: 'input_placeholder', label: '输入框占位', max: 120 },
      { key: 'send_button', label: '发送按钮', max: 30 },
      { key: 'create_panel_title', label: '创建面板标题', max: 50 },
      { key: 'group_name_placeholder', label: '群聊名称占位', max: 80 },
      { key: 'create_button', label: '创建按钮', max: 40 },
      { key: 'search_placeholder', label: '搜索占位', max: 80 },
      { key: 'search_button', label: '搜索按钮', max: 30 },
      { key: 'role_card_fallback', label: '角色卡兜底', max: 60 },
      { key: 'max_roles_error', label: '最多角色提示', max: 80 },
      { key: 'min_roles_error', label: '最少角色提示', max: 80 },
      { key: 'create_success', label: '创建成功提示', max: 80 },
      { key: 'create_failed', label: '创建失败提示', max: 80 },
      { key: 'delete_confirm_template', label: '删除确认模板', max: 120 },
      { key: 'delete_success', label: '删除成功提示', max: 60 },
      { key: 'send_failed', label: '发送失败提示', max: 80 },
      { key: 'reply_failed', label: '回复失败提示', max: 80 },
    ],

    stats: null,
    lastStatsRefreshed: null,

    users: [],
    userTotal: 0,
    userPage: 1,
    userLimit: 20,
    userSearch: '',

    logs: [],
    logTotal: 0,
    logPage: 1,
    logLimit: 50,
    logFilters: { method: '', path: '' },
    logDetail: null,

    orders: [],
    orderTotal: 0,
    orderPage: 1,
    orderLimit: 50,

    redeemCodes: [],
    redeemTotal: 0,
    redeemPage: 1,
    redeemLimit: 50,
    redeemStatus: '',
    redeemForm: {
      count: 1,
      points: 100000,
      point_type: 'paid',
      note: '',
      expires_at_local: '',
    },
    createdRedeemCodes: [],

    contests: [],
    contestActive: null,
    contestForm: { title: '', content: '', reward: '', start_at_local: '', end_at_local: '' },
    contestSaving: false,

    siteSettings: null,
    siteForm: null,

    llmSettings: null,
    globalPresets: null,
    globalPresetKind: 'prompt',
    globalPresetEditor: null,
    globalPresetSearch: '',
    globalPresetFilter: 'all',
    llmForm: {
      enabled: true,
      base_url: '',
      model: '',
      temperature: 0.8,
      api_key: '',
      clear_api_key: false,
      default_model_preset_id: 'default',
      presets: [],
      global_prompt_preset: { enabled: false, name: '全局提示词预设', source: 'manual', blocks: [], stats: {} },
      image_model: {
        enabled: false,
        name: 'CelestiAI 图片模型',
        base_url: 'https://api.celestiai.xyz/v1',
        model: 'gpt-image-1',
        size: '1024x1024',
        quality: '',
        response_format: '',
        endpoint_path: '/images/generations',
        n: 1,
        timeout: 90,
        api_key: '',
        clear_api_key: false,
        has_api_key: false,
        api_key_preview: '',
      },
      memory_settings: {
        enabled: true,
        auto_summary_enabled: true,
        auto_summary_message_threshold: 10,
        auto_summary_delta_messages: 8,
        bind_memories_to_conversation: true,
        include_role_memories: true,
        max_memories: 6,
      },
    },
    globalPromptImportRaw: '',

    tavoPlugins: [],
    tavoPluginUploading: false,
    tavoPluginFileName: '',
    tavoPluginDetail: null,

    apps: [],
    appTotal: 0,
    appPage: 1,
    appLimit: 30,
    appSearch: '',
    appSource: 'admin',
    appOfficialFilter: 'all',
    appDialog: null,
    appImportDialog: false,
    appImportRaw: '',
    appImportFileName: '',
    appImportResult: null,
    selectedAppIds: [],
    appBulkDialog: false,
    appBulkForm: null,
    appBulkResult: null,
    appCoverUploading: false,

    pointsDialog: null,

    async init() {
      if (!isLoggedIn()) {
        this.errorMessage = '需要登录';
        this.errorDetail = '请先在用户中心登录管理员账号';
        this.state = 'unauthorized';
        return;
      }
      try {
        const result = await api.admin.whoami();
        this.adminInfo = result.data || result;
        this.state = 'ready';
        await this.loadStats();
        this.$nextTick(() => this.installMobileTableLabels());
      } catch (err) {
        if (err instanceof ApiError && err.code === 403) {
          this.errorMessage = '权限不足';
          this.errorDetail = '当前账号不是管理员，无法访问后台';
        } else if (err instanceof ApiError && err.code === 401) {
          this.errorMessage = '登录已过期';
          this.errorDetail = '请重新登录后再试';
        } else {
          this.errorMessage = '验证失败';
          this.errorDetail = err.message || '请稍后再试';
        }
        this.state = 'unauthorized';
      }
    },

    installMobileTableLabels() {
      const applyLabels = () => {
        document.querySelectorAll('.xy-table').forEach(table => {
          const labels = Array.from(table.querySelectorAll('thead th')).map(item => String(item.textContent || '').trim());
          table.querySelectorAll('tbody tr').forEach(row => {
            Array.from(row.children).forEach((cell, index) => {
              if (cell instanceof HTMLElement) cell.dataset.label = labels[index] || `字段 ${index + 1}`;
            });
          });
        });
      };
      applyLabels();
      this.mobileTableObserver?.disconnect?.();
      this.mobileTableObserver = new MutationObserver(() => window.requestAnimationFrame(applyLabels));
      const root = document.querySelector('.xy-admin-main');
      if (root) this.mobileTableObserver.observe(root, { childList: true, subtree: true });
    },

    showToast(message, type = 'info', duration = 2800) {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toast = { message, type };
      this.toastTimer = setTimeout(() => { this.toast = null; }, duration);
    },

    formatTime(ts) { return ts ? formatDateTime(ts) : '-'; },

    prettyJson(value) {
      if (!value) return '';
      if (typeof value === 'string') {
        try { return JSON.stringify(JSON.parse(value), null, 2); }
        catch { return value; }
      }
      try { return JSON.stringify(value, null, 2); }
      catch { return String(value); }
    },

    prettyJsonDefault(value, fallback) {
      const source = value === undefined || value === null ? fallback : value;
      try { return JSON.stringify(source, null, 2); }
      catch { return JSON.stringify(fallback, null, 2); }
    },

    parseJsonEditor(label, raw, fallback) {
      const text = String(raw || '').trim();
      if (!text) return fallback;
      try { return JSON.parse(text); }
      catch (err) { throw new Error(`${label} JSON 解析失败：${err.message || err}`); }
    },

    parseJsonArrayEditor(label, raw) {
      const value = this.parseJsonEditor(label, raw, []);
      if (!Array.isArray(value)) throw new Error(`${label} 必须是 JSON 数组`);
      return value;
    },

    parseWorldInfoEditor(raw) {
      const value = this.parseJsonEditor('世界书', raw, []);
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        const data = value.data && typeof value.data === 'object' ? value.data : {};
        const book = value.character_book && typeof value.character_book === 'object' ? value.character_book : {};
        const dataBook = data.character_book && typeof data.character_book === 'object' ? data.character_book : {};
        for (const list of [value.world_info, value.entries, value.items, book.entries, dataBook.entries]) {
          if (Array.isArray(list)) return list;
        }
        if ('content' in value || 'entry' in value) return [value];
      }
      throw new Error('世界书必须是 JSON 数组、{entries:[...]} 或 Character Book 对象');
    },

    parseJsonObjectEditor(label, raw) {
      const value = this.parseJsonEditor(label, raw, {});
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
      return value;
    },

    methodBadge(method) {
      const map = { GET: 'xy-badge-blue', POST: 'xy-badge-green', PUT: 'xy-badge-yellow', DELETE: 'xy-badge-red', PATCH: 'xy-badge-purple' };
      return map[method] || 'xy-badge-gray';
    },

    statusBadge(status) {
      const code = parseInt(status, 10);
      if (code >= 500) return 'xy-badge-red';
      if (code >= 400) return 'xy-badge-yellow';
      if (code >= 200 && code < 300) return 'xy-badge-green';
      return 'xy-badge-gray';
    },

    chartMax(items) {
      const values = (items || []).map(item => Number(item.value || 0));
      return Math.max(1, ...values);
    },

    chartPercent(value, items) {
      const max = this.chartMax(items);
      const numeric = Number(value || 0);
      if (numeric <= 0) return 0;
      return Math.max(3, Math.round((numeric / max) * 100));
    },

    distributionTotal(items) {
      return Math.max(1, (items || []).reduce((sum, item) => sum + Number(item.value || 0), 0));
    },

    distributionPercent(value, items) {
      return Math.max(0, Math.round((Number(value || 0) / this.distributionTotal(items)) * 100));
    },

    toneBarClass(tone) {
      return {
        green: 'bg-emerald-400',
        blue: 'bg-sky-400',
        yellow: 'bg-amber-400',
        red: 'bg-rose-400',
        purple: 'bg-violet-400',
      }[tone] || 'bg-slate-400';
    },

    adminBadgeClass(user) {
      if (user?.admin_source === 'env') return 'xy-badge-red';
      if (user?.is_admin) return 'xy-badge-purple';
      return 'xy-badge-gray';
    },

    adminLabel(user) {
      if (user?.admin_source === 'env') return '环境管理员';
      if (user?.is_admin) return '后台授权';
      return '普通用户';
    },

    async switchTab(id) {
      this.activeTab = id;
      if (id === 'notifications') await this.loadNotifications();
      if (id === 'stats' && !this.stats) await this.loadStats();
      if (id === 'users' && this.users.length === 0) await this.loadUsers(1);
      if (id === 'logs' && this.logs.length === 0) await this.loadLogs(1);
      if (id === 'orders' && this.orders.length === 0) await this.loadOrders(1);
      if (id === 'redeem' && this.redeemCodes.length === 0) await this.loadRedeemCodes(1);
      if (id === 'contests' && this.contests.length === 0) await this.loadContests();
      if (id === 'site' && !this.siteSettings) await this.loadSiteSettings();
      if (id === 'llm') {
        if (!this.globalPresets) await this.loadGlobalPresets();
        if (!this.llmSettings) await this.loadLlmSettings();
      }
      if (id === 'global-presets' && !this.globalPresets) await this.loadGlobalPresets();
      if (id === 'plugins' && this.tavoPlugins.length === 0) await this.loadTavoPlugins();
      if (id === 'apps' && this.apps.length === 0) await this.loadApps(1);
    },

    async loadNotifications() {
      this.notificationError = '';
      try {
        const result = await api.admin.notifications();
        this.notifications = result?.data?.list || result?.list || [];
      } catch (error) { this.notificationError = error.message || '通知读取失败'; }
    },
    editNotification(item = null) {
      this.notificationError = '';
      this.notificationForm = item ? { ...item } : { title: '', content: '', enabled: true };
    },
    async saveNotification() {
      if (this.notificationBusy || !this.notificationForm) return;
      if (!this.notificationForm.title.trim() || !this.notificationForm.content.trim()) {
        this.notificationError = '请填写通知标题和正文'; return;
      }
      this.notificationBusy = true;
      this.notificationError = '';
      try {
        await api.admin.saveNotification(this.notificationForm);
        this.notificationForm = null;
        await this.loadNotifications();
      } catch (error) { this.notificationError = error.message || '保存失败'; }
      finally { this.notificationBusy = false; }
    },
    async deleteNotification(item) {
      if (this.notificationBusy || !confirm('确定删除这条通知？删除后用户将不再看到它。')) return;
      this.notificationBusy = true;
      this.notificationError = '';
      try {
        await api.admin.deleteNotification(item.id);
        if (this.notificationForm?.id === item.id) this.notificationForm = null;
        await this.loadNotifications();
      } catch (error) { this.notificationError = error.message || '删除失败'; }
      finally { this.notificationBusy = false; }
    },

    contestPhaseLabel(contest) {
      const phase = contest?.status === 'closed' ? 'closed' : contest?.phase;
      return { upcoming: '未开始', active: '进行中', ended: '已结束', closed: '已关闭' }[phase] || contest?.status || '未知';
    },

    contestPhaseClass(contest) {
      const phase = contest?.status === 'closed' ? 'closed' : contest?.phase;
      return { active: 'xy-badge-green', upcoming: 'xy-badge-blue', ended: 'xy-badge-gray', closed: 'xy-badge-red' }[phase] || 'xy-badge-gray';
    },

    async loadContests() {
      this.loading = true;
      try {
        const result = await api.admin.communityContests();
        const data = result?.data || result || {};
        this.contests = Array.isArray(data.list) ? data.list : [];
        this.contestActive = data.active || this.contests.find(item => item.phase === 'active' && item.status === 'active') || null;
      } catch (error) {
        this.showToast(error.message || '赛事列表加载失败', 'error');
      } finally { this.loading = false; }
    },

    contestTimeMs(value) {
      const ms = new Date(String(value || '')).getTime();
      return Number.isFinite(ms) ? ms : 0;
    },

    async createContest() {
      if (this.contestSaving) return;
      const title = String(this.contestForm.title || '').trim();
      const startAt = this.contestTimeMs(this.contestForm.start_at_local);
      const endAt = this.contestTimeMs(this.contestForm.end_at_local);
      if (!title || !startAt || !endAt || endAt <= startAt) {
        this.showToast('请填写标题，并确保结束时间晚于开始时间', 'error');
        return;
      }
      this.contestSaving = true;
      try {
        await api.admin.createCommunityContest({
          title,
          content: String(this.contestForm.content || '').trim(),
          reward: String(this.contestForm.reward || '').trim(),
          start_at: startAt,
          end_at: endAt,
        });
        this.contestForm = { title: '', content: '', reward: '', start_at_local: '', end_at_local: '' };
        this.showToast('赛事已发布', 'success');
        await this.loadContests();
      } catch (error) { this.showToast(error.message || '赛事发布失败', 'error'); }
      finally { this.contestSaving = false; }
    },

    async closeContest(contest) {
      if (!contest?.id || contest.status === 'closed' || !confirm(`确定关闭赛事“${contest.title || contest.id}”？关闭后将停止报名和投票。`)) return;
      try {
        await api.admin.closeCommunityContest(contest.id);
        this.showToast('赛事已关闭', 'success');
        await this.loadContests();
      } catch (error) { this.showToast(error.message || '关闭赛事失败', 'error'); }
    },

    stripGlobalPresetPrivate(value) {
      if (Array.isArray(value)) return value.map(item => this.stripGlobalPresetPrivate(item));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, item]) => [key, this.stripGlobalPresetPrivate(item)]));
    },

    globalPresetLibrary(kind = this.globalPresetKind) {
      return this.globalPresets?.[kind] || { active_id: '', items: [] };
    },

    globalPresetItems(kind = this.globalPresetKind) {
      return this.globalPresetLibrary(kind).items || [];
    },

    prepareGlobalPresetEditor(preset, kind = this.globalPresetKind) {
      const editor = JSON.parse(JSON.stringify(preset || {}));
      editor._kind = kind;
      const entries = kind === 'prompt' ? ((editor.prompts || []).length ? editor.prompts : (editor.blocks || [])) : (editor.scripts || []);
      entries.forEach(entry => {
        entry._raw_json = JSON.stringify(this.stripGlobalPresetPrivate(entry), null, 2);
      });
      editor._preset_json = JSON.stringify(this.stripGlobalPresetPrivate(editor), null, 2);
      return editor;
    },

    openGlobalPreset(kind, presetId) {
      this.globalPresetKind = kind;
      const preset = this.globalPresetItems(kind).find(item => item.id === presetId) || this.globalPresetItems(kind)[0];
      this.globalPresetEditor = preset ? this.prepareGlobalPresetEditor(preset, kind) : null;
    },

    async loadGlobalPresets(selectId = '') {
      this.loading = true;
      try {
        const response = await api.admin.globalPresets();
        this.globalPresets = response.data || response || { prompt: { items: [] }, regex: { items: [] } };
        const library = this.globalPresetLibrary();
        const target = selectId || this.globalPresetEditor?.id || library.active_id || library.items?.[0]?.id || '';
        this.openGlobalPreset(this.globalPresetKind, target);
      } catch (err) {
        this.showToast(err.message || '加载全局预设失败', 'error');
      } finally { this.loading = false; }
    },

    switchGlobalPresetKind(kind) {
      this.globalPresetKind = kind === 'regex' ? 'regex' : 'prompt';
      this.globalPresetSearch = '';
      this.globalPresetFilter = 'all';
      const library = this.globalPresetLibrary();
      this.openGlobalPreset(this.globalPresetKind, library.active_id || library.items?.[0]?.id || '');
    },

    globalPresetEntries() {
      if (!this.globalPresetEditor) return [];
      const source = this.globalPresetKind === 'prompt'
        ? ((this.globalPresetEditor.prompts || []).length ? this.globalPresetEditor.prompts : (this.globalPresetEditor.blocks || []))
        : (this.globalPresetEditor.scripts || []);
      const query = String(this.globalPresetSearch || '').trim().toLowerCase();
      return source.filter(entry => {
        const enabled = this.isGlobalPresetEntryEnabled(entry);
        if (this.globalPresetFilter === 'enabled' && !enabled) return false;
        if (this.globalPresetFilter === 'disabled' && enabled) return false;
        if (this.globalPresetFilter === 'marker' && !entry.marker) return false;
        if (!query) return true;
        return [entry.name, entry.identifier, entry.scriptName, entry.id, entry.content, entry.findRegex]
          .some(value => String(value || '').toLowerCase().includes(query));
      });
    },

    isGlobalPresetEntryEnabled(entry) {
      if (this.globalPresetKind === 'regex') return !entry?.disabled;
      if (this.globalPresetEditor?.format === 'legacy-blocks' || !(this.globalPresetEditor?.prompts || []).length) return entry?.enabled !== false;
      return !!entry?.in_order && entry?.order_enabled !== false;
    },

    globalPresetStats() {
      const editor = this.globalPresetEditor;
      if (!editor) return { total: 0, enabled: 0, markers: 0, unlisted: 0 };
      const entries = this.globalPresetKind === 'prompt' ? ((editor.prompts || []).length ? editor.prompts : (editor.blocks || [])) : (editor.scripts || []);
      return {
        total: entries.length,
        enabled: entries.filter(entry => this.isGlobalPresetEntryEnabled(entry)).length,
        markers: entries.filter(entry => !!entry.marker).length,
        unlisted: entries.filter(entry => this.globalPresetKind === 'prompt' && entry.in_order === false).length,
      };
    },

    applyGlobalEntryJson(entry) {
      try {
        const parsed = JSON.parse(String(entry?._raw_json || '{}'));
        const privateJson = entry._raw_json;
        Object.keys(entry).forEach(key => delete entry[key]);
        Object.assign(entry, parsed, { _raw_json: privateJson });
        this.showToast('完整条目 JSON 已应用', 'success');
      } catch {
        this.showToast('条目 JSON 格式错误', 'error');
      }
    },

    parseGlobalArrayField(entry, key, rawValue, label) {
      try {
        const parsed = JSON.parse(String(rawValue || '[]'));
        if (!Array.isArray(parsed)) throw new Error('not array');
        entry[key] = parsed;
      } catch {
        this.showToast(`${label || key} JSON 错误`, 'error');
      }
    },

    applyGlobalPresetJson() {
      try {
        const parsed = JSON.parse(String(this.globalPresetEditor?._preset_json || '{}'));
        parsed.id = this.globalPresetEditor.id;
        this.globalPresetEditor = this.prepareGlobalPresetEditor(parsed, this.globalPresetKind);
        this.showToast('完整预设 JSON 已应用', 'success');
      } catch {
        this.showToast('预设 JSON 格式错误', 'error');
      }
    },

    async importGlobalPromptFile(event) {
      const file = event?.target?.files?.[0];
      if (!file) return;
      this.loading = true;
      try {
        const raw = await file.text();
        const preset = JSON.parse(raw);
        const response = await api.admin.importGlobalPresetBundle({ preset, filename: file.name });
        this.globalPresetKind = 'prompt';
        const data = response.data || response;
        await this.loadGlobalPresets(data?.prompt_preset?.id || '');
        const promptCount = data?.prompt_preset?.stats?.entry_count || 0;
        const regexCount = data?.regex_preset?.stats?.entry_count || 0;
        this.showToast(`已导入 ${promptCount} 个提示词条目和 ${regexCount} 条正则`, 'success');
      } catch (err) {
        this.showToast(err.message || '预设 JSON 导入失败', 'error');
      } finally {
        this.loading = false;
        if (event?.target) event.target.value = '';
      }
    },

    fileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
        reader.readAsDataURL(file);
      });
    },

    async importGlobalRegexFile(event) {
      const file = event?.target?.files?.[0];
      if (!file) return;
      this.loading = true;
      try {
        let response;
        if (file.name.toLowerCase().endsWith('.json') || file.type === 'application/json') {
          const preset = JSON.parse(await file.text());
          response = await api.admin.importGlobalRegexJson({ preset, filename: file.name });
        } else {
          const dataUrl = await this.fileAsDataUrl(file);
          response = await api.admin.importGlobalRegexPreset({ data_url: dataUrl, filename: file.name });
        }
        this.globalPresetKind = 'regex';
        await this.loadGlobalPresets((response.data || response)?.preset?.id || '');
        this.showToast(`已导入全部 ${(response.data || response)?.preset?.stats?.entry_count || 0} 条正则`, 'success');
      } catch (err) {
        this.showToast(err.message || '正则预设导入失败', 'error');
      } finally {
        this.loading = false;
        if (event?.target) event.target.value = '';
      }
    },

    async saveGlobalPreset() {
      if (!this.globalPresetEditor?.id) return;
      this.loading = true;
      try {
        const payload = this.stripGlobalPresetPrivate(this.globalPresetEditor);
        await api.admin.saveGlobalPreset(this.globalPresetKind, this.globalPresetEditor.id, payload);
        await this.loadGlobalPresets(this.globalPresetEditor.id);
        this.showToast('全局预设已保存', 'success');
      } catch (err) {
        this.showToast(err.message || '全局预设保存失败', 'error');
      } finally { this.loading = false; }
    },

    async activateGlobalPreset(kind, presetId) {
      this.loading = true;
      try {
        await api.admin.activateGlobalPreset(kind, presetId);
        this.globalPresetKind = kind;
        await this.loadGlobalPresets(presetId);
        this.showToast('已设为当前全局预设，其余同类预设已停用', 'success');
      } catch (err) {
        this.showToast(err.message || '启用全局预设失败', 'error');
      } finally { this.loading = false; }
    },

    async loadStats() {
      this.loading = true;
      try {
        const r = await api.admin.stats();
        this.stats = r.data || r;
        this.lastStatsRefreshed = Date.now();
      } catch (err) {
        this.showToast(err.message || '加载失败', 'error');
      } finally { this.loading = false; }
    },

    async loadUsers(page) {
      if (page < 1) page = 1;
      this.loading = true;
      try {
        const r = await api.admin.users(page, this.userLimit, this.userSearch.trim());
        const data = r.data || r;
        this.users = data.users || [];
        this.userTotal = data.total || 0;
        this.userPage = data.page || page;
      } catch (err) {
        this.showToast(err.message || '加载失败', 'error');
      } finally { this.loading = false; }
    },

    async loadLogs(page) {
      if (page < 1) page = 1;
      this.loading = true;
      try {
        const r = await api.admin.requestLog(page, this.logLimit, this.logFilters);
        const data = r.data || r;
        this.logs = data.logs || [];
        this.logTotal = data.total || 0;
        this.logPage = data.page || page;
      } catch (err) {
        this.showToast(err.message || '加载失败', 'error');
      } finally { this.loading = false; }
    },

    async showLogDetail(id) {
      try {
        const r = await api.admin.requestLogDetail(id);
        this.logDetail = r.data || r;
      } catch (err) {
        this.showToast(err.message || '加载详情失败', 'error');
      }
    },

    async loadOrders(page) {
      if (page < 1) page = 1;
      this.loading = true;
      try {
        const r = await api.admin.rechargeOrders(page, this.orderLimit);
        const data = r.data || r;
        this.orders = data.orders || [];
        this.orderTotal = data.total || 0;
        this.orderPage = data.page || page;
      } catch (err) {
        this.showToast(err.message || '加载失败', 'error');
      } finally { this.loading = false; }
    },

    async loadRedeemCodes(page) {
      if (page < 1) page = 1;
      this.loading = true;
      try {
        const r = await api.admin.redeemCodes(page, this.redeemLimit, this.redeemStatus);
        const data = r.data || r;
        this.redeemCodes = data.codes || data.list || [];
        this.redeemTotal = data.total || 0;
        this.redeemPage = data.page || page;
      } catch (err) {
        this.showToast(err.message || '加载兑换码失败', 'error');
      } finally { this.loading = false; }
    },

    redeemExpiresMs() {
      const value = String(this.redeemForm.expires_at_local || '').trim();
      if (!value) return null;
      const ts = new Date(value).getTime();
      return Number.isFinite(ts) ? ts : null;
    },

    async createRedeemCodes() {
      const count = parseInt(this.redeemForm.count, 10);
      const points = parseInt(this.redeemForm.points, 10);
      if (!count || count < 1 || !points || points < 1) {
        this.showToast('请填写有效数量和额度', 'error');
        return;
      }
      this.loading = true;
      try {
        const r = await api.admin.createRedeemCodes({
          count,
          points,
          point_type: this.redeemForm.point_type || 'paid',
          note: String(this.redeemForm.note || '').trim(),
          expires_at: this.redeemExpiresMs(),
        });
        const data = r.data || r;
        this.createdRedeemCodes = data.codes || [];
        this.showToast(`已生成 ${this.createdRedeemCodes.length} 个兑换码`, 'success');
        await this.loadRedeemCodes(1);
      } catch (err) {
        this.showToast(err.message || '生成兑换码失败', 'error');
      } finally { this.loading = false; }
    },

    async disableRedeemCode(item) {
      if (!item?.code || !confirm(`禁用兑换码 ${item.code}？`)) return;
      this.loading = true;
      try {
        await api.admin.disableRedeemCode(item.code);
        this.showToast('兑换码已禁用', 'success');
        await this.loadRedeemCodes(this.redeemPage);
      } catch (err) {
        this.showToast(err.message || '禁用失败', 'error');
      } finally { this.loading = false; }
    },

    redeemStatusBadge(status) {
      const map = {
        unused: 'xy-badge-green',
        used: 'xy-badge-purple',
        disabled: 'xy-badge-red',
        expired: 'xy-badge-yellow',
      };
      return map[status] || 'xy-badge-gray';
    },

    redeemStatusLabel(status) {
      return { unused: '未使用', used: '已使用', disabled: '已禁用', expired: '已过期' }[status] || status || '-';
    },

    cloneJson(value) {
      try { return JSON.parse(JSON.stringify(value || {})); }
      catch { return {}; }
    },

    normalizeSiteForm(settings) {
      const form = this.cloneJson(settings);
      form.home = form.home || {};
      form.app = form.app || {};
      form.app_home = form.app_home || {};
      form.auth = form.auth || {};
      form.dashboard = form.dashboard || {};
      form.account = form.account || {};
      form.my_apps = form.my_apps || {};
      form.character = form.character || {};
      form.chat = form.chat || {};
      form.creator = form.creator || {};
      form.group_chat = form.group_chat || {};
      form.rewards = form.rewards || {};
      form.deposit = form.deposit || {};
      form.empty_states = form.empty_states || {};
      form.app.nav_labels = form.app.nav_labels || {};
      form.app.mobile_nav_labels = form.app.mobile_nav_labels || {};
      form.app_home.category_labels = form.app_home.category_labels || {};
      form.app_home.rank_labels = form.app_home.rank_labels || {};
      form.app_home.sort_labels = form.app_home.sort_labels || {};
      form.home.feature_cards = Array.isArray(form.home.feature_cards) ? form.home.feature_cards : [];
      form.home.download_facts = Array.isArray(form.home.download_facts) ? form.home.download_facts : [];
      form.home.faq_items = Array.isArray(form.home.faq_items) ? form.home.faq_items : [];
      form.rewards.tasks = Array.isArray(form.rewards.tasks) ? form.rewards.tasks : [];
      form.deposit.steps = Array.isArray(form.deposit.steps) ? form.deposit.steps : [];
      form.deposit.packages = Array.isArray(form.deposit.packages) ? form.deposit.packages : [];
      form.deposit.subscriptions = Array.isArray(form.deposit.subscriptions) ? form.deposit.subscriptions : [];
      return form;
    },

    async loadSiteSettings() {
      this.loading = true;
      try {
        const r = await api.admin.siteSettings();
        const data = r.data || r;
        this.siteSettings = data;
        this.siteForm = this.normalizeSiteForm(data);
      } catch (err) {
        this.showToast(err.message || '加载运营配置失败', 'error');
      } finally { this.loading = false; }
    },

    async saveSiteSettings() {
      if (!this.siteForm) return;
      this.loading = true;
      try {
        const r = await api.admin.saveSiteSettings(this.siteForm);
        const data = r.data || r;
        this.siteSettings = data;
        this.siteForm = this.normalizeSiteForm(data);
        this.showToast('运营配置已保存', 'success');
      } catch (err) {
        this.showToast(err.message || '保存运营配置失败', 'error');
      } finally { this.loading = false; }
    },

    newConfigId(prefix = 'item') {
      return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    },

    addFeatureCard() {
      if (!this.siteForm?.home) return;
      this.siteForm.home.feature_cards.push({
        title: '新功能',
        description: '填写这项功能的用户价值。',
      });
    },

    removeFeatureCard(index) {
      this.siteForm?.home?.feature_cards?.splice(index, 1);
    },

    addDownloadFact() {
      if (!this.siteForm?.home) return;
      this.siteForm.home.download_facts.push({ label: '信息项', value: '填写内容' });
    },

    removeDownloadFact(index) {
      this.siteForm?.home?.download_facts?.splice(index, 1);
    },

    addFaqItem() {
      if (!this.siteForm?.home) return;
      this.siteForm.home.faq_items.push({ q: '新问题', a: '填写回答内容。' });
    },

    removeFaqItem(index) {
      this.siteForm?.home?.faq_items?.splice(index, 1);
    },

    addRewardTask() {
      if (!this.siteForm?.rewards) return;
      this.siteForm.rewards.tasks.push({
        key: this.newConfigId('task'),
        label: '新奖励任务',
        points: 10,
        status: 'available',
      });
    },

    removeRewardTask(index) {
      this.siteForm?.rewards?.tasks?.splice(index, 1);
    },

    addDepositStep() {
      if (!this.siteForm?.deposit) return;
      this.siteForm.deposit.steps.push('新的购买步骤');
    },

    removeDepositStep(index) {
      this.siteForm?.deposit?.steps?.splice(index, 1);
    },

    addDepositPackage() {
      if (!this.siteForm?.deposit) return;
      this.siteForm.deposit.packages.push({
        id: this.newConfigId('pkg'),
        label: '新套餐',
        price_cny: 20,
        points: 22000,
        bonus_rate: 0,
      });
    },

    removeDepositPackage(index) {
      this.siteForm?.deposit?.packages?.splice(index, 1);
    },

    addDepositSubscription() {
      if (!this.siteForm?.deposit) return;
      this.siteForm.deposit.subscriptions.push({
        id: this.newConfigId('sub'),
        label: '新月卡',
        price_cny: 19.9,
        points: 22000,
        period: '月',
        description: '月度额度包，不承诺无限使用。',
      });
    },

    removeDepositSubscription(index) {
      this.siteForm?.deposit?.subscriptions?.splice(index, 1);
    },

    emptyGlobalPromptPreset() {
      return { enabled: false, name: '全局提示词预设', source: 'manual', blocks: [], stats: {} };
    },

    normalizeGlobalPromptBlocks(value) {
      const allowedPositions = new Set(['system_before', 'system_after', 'post_history']);
      const allowedRoles = new Set(['system', 'user', 'assistant']);
      const seen = new Set();
      return (Array.isArray(value) ? value : [])
        .map((raw, idx) => {
          const content = String(raw?.content || '').trim();
          if (!content) return null;
          let id = String(raw?.id || raw?.identifier || `global-prompt-${idx + 1}`).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
          if (!id) id = `global-prompt-${idx + 1}`;
          if (seen.has(id)) id = `${id}-${idx + 1}`;
          seen.add(id);
          let position = String(raw?.position || 'system_before');
          if (!allowedPositions.has(position)) position = 'system_before';
          let role = String(raw?.role || 'system').toLowerCase();
          if (!allowedRoles.has(role)) role = 'system';
          const order = Number.isFinite(Number(raw?.order)) ? Math.max(0, Math.min(9999, Number(raw.order))) : idx + 1;
          return {
            id,
            name: String(raw?.name || `全局提示词 ${idx + 1}`).slice(0, 120),
            position,
            role,
            order,
            enabled: raw?.enabled !== false && !['0', 'false', 'no', 'off', 'disabled'].includes(String(raw?.enabled ?? 'true').toLowerCase()),
            content: content.slice(0, 16000),
          };
        })
        .filter(Boolean)
        .sort((a, b) => String(a.position).localeCompare(String(b.position)) || Number(a.order) - Number(b.order));
    },

    sillyPresetToGlobalPrompt(data) {
      const prompts = Array.isArray(data?.prompts) ? data.prompts : [];
      const byId = Object.fromEntries(prompts.map(p => [String(p?.identifier || p?.id || ''), p]).filter(([id]) => id));
      let orderItems = [];
      if (Array.isArray(data?.prompt_order) && data.prompt_order[0]?.order) orderItems = data.prompt_order[0].order;
      if (!orderItems.length) {
        orderItems = prompts.map(p => ({ identifier: p?.identifier || p?.id, enabled: p?.enabled !== false }));
      }
      let afterHistory = false;
      let markerCount = 0;
      let enabledCount = 0;
      const blocks = [];
      for (const item of orderItems) {
        const ident = String(item?.identifier || item?.id || '').trim();
        if (!ident) continue;
        const prompt = byId[ident] || {};
        const enabled = item?.enabled ?? prompt?.enabled ?? true;
        if (enabled === false || ['0', 'false', 'no', 'off', 'disabled'].includes(String(enabled).toLowerCase())) continue;
        enabledCount += 1;
        const content = String(prompt?.content || '').trim();
        const isMarker = !!prompt?.marker || (!content && !!prompt?.system_prompt);
        if (ident === 'chatHistory') afterHistory = true;
        if (isMarker || !content) {
          markerCount += 1;
          continue;
        }
        blocks.push({
          id: ident,
          name: String(prompt?.name || ident),
          position: afterHistory ? 'post_history' : 'system_before',
          role: String(prompt?.role || 'system').toLowerCase(),
          order: blocks.length + 1,
          enabled: true,
          content,
        });
      }
      return {
        enabled: true,
        name: String(data?.name || data?.preset_name || 'SillyTavern 全局预设').slice(0, 120),
        source: 'sillytavern',
        blocks: this.normalizeGlobalPromptBlocks(blocks),
        stats: {
          source_prompt_count: prompts.length,
          enabled_prompt_count: enabledCount,
          marker_count: markerCount,
          block_count: blocks.length,
        },
      };
    },

    normalizeGlobalPromptPreset(data) {
      if (!data || typeof data !== 'object') return this.emptyGlobalPromptPreset();
      if (Array.isArray(data.prompts)) return this.sillyPresetToGlobalPrompt(data);
      const preset = {
        enabled: !!data.enabled,
        name: String(data.name || '全局提示词预设').slice(0, 120),
        source: String(data.source || 'manual').slice(0, 40),
        blocks: this.normalizeGlobalPromptBlocks(data.blocks || []),
        stats: data.stats && typeof data.stats === 'object' ? { ...data.stats } : {},
      };
      preset.stats.block_count = preset.blocks.length;
      preset.stats.enabled_block_count = preset.blocks.filter(b => b.enabled !== false).length;
      preset.stats.system_before = preset.blocks.filter(b => b.position === 'system_before').length;
      preset.stats.system_after = preset.blocks.filter(b => b.position === 'system_after').length;
      preset.stats.post_history = preset.blocks.filter(b => b.position === 'post_history').length;
      return preset;
    },

    importGlobalPromptPreset() {
      const raw = String(this.globalPromptImportRaw || '').trim();
      if (!raw) {
        this.showToast('请先粘贴 SillyTavern 预设 JSON', 'error');
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        this.llmForm.global_prompt_preset = this.normalizeGlobalPromptPreset(parsed);
        this.showToast(`已导入 ${this.llmForm.global_prompt_preset.blocks.length} 个全局提示词块`, 'success');
      } catch (err) {
        this.showToast('JSON 解析失败，请检查文件内容', 'error');
      }
    },

    addGlobalPromptBlock(position = 'system_before') {
      if (!this.llmForm.global_prompt_preset) this.llmForm.global_prompt_preset = this.emptyGlobalPromptPreset();
      const next = this.llmForm.global_prompt_preset.blocks.length + 1;
      this.llmForm.global_prompt_preset.blocks.push({
        id: `global-prompt-${Date.now().toString(36)}-${next}`,
        name: `全局提示词 ${next}`,
        position,
        role: 'system',
        order: next,
        enabled: true,
        content: '',
      });
    },

    removeGlobalPromptBlock(index) {
      this.llmForm.global_prompt_preset?.blocks?.splice(index, 1);
    },

    globalPromptBlocks(position = '') {
      const blocks = this.llmForm.global_prompt_preset?.blocks || [];
      return position ? blocks.filter(block => block.position === position) : blocks;
    },

    globalPromptStats() {
      const blocks = this.llmForm.global_prompt_preset?.blocks || [];
      return {
        total: blocks.length,
        enabled: blocks.filter(block => block.enabled !== false).length,
        before: blocks.filter(block => block.position === 'system_before').length,
        after: blocks.filter(block => block.position === 'system_after').length,
        post: blocks.filter(block => block.position === 'post_history').length,
      };
    },

    serializeGlobalPromptPreset() {
      const current = this.llmForm.global_prompt_preset || this.emptyGlobalPromptPreset();
      const clean = this.normalizeGlobalPromptPreset(current);
      clean.enabled = !!current.enabled;
      clean.name = String(current.name || clean.name || '全局提示词预设').trim();
      clean.source = String(current.source || clean.source || 'manual').trim();
      return clean;
    },

    emptyImageModelSettings() {
      return {
        enabled: false,
        name: 'CelestiAI 图片模型',
        base_url: 'https://api.celestiai.xyz/v1',
        model: 'gpt-image-1',
        size: '1024x1024',
        quality: '',
        response_format: '',
        endpoint_path: '/images/generations',
        n: 1,
        timeout: 90,
        api_key: '',
        clear_api_key: false,
        has_api_key: false,
        api_key_preview: '',
      };
    },

    normalizeImageModelSettings(data = {}) {
      const base = this.emptyImageModelSettings();
      const value = data && typeof data === 'object' ? data : {};
      return {
        ...base,
        enabled: !!value.enabled,
        name: String(value.name || base.name).slice(0, 120),
        base_url: String(value.base_url || base.base_url).trim(),
        model: String(value.model || base.model).trim(),
        size: String(value.size || base.size).trim(),
        quality: String(value.quality || '').trim(),
        response_format: ['', 'url', 'b64_json'].includes(String(value.response_format || '').trim()) ? String(value.response_format || '').trim() : '',
        endpoint_path: String(value.endpoint_path || base.endpoint_path).trim() || base.endpoint_path,
        n: Math.max(1, Math.min(4, Number(value.n || base.n))),
        timeout: Math.max(10, Math.min(300, Number(value.timeout || base.timeout))),
        api_key: '',
        clear_api_key: false,
        has_api_key: !!value.has_api_key,
        api_key_preview: value.api_key_preview || '',
      };
    },

    serializeImageModelSettings() {
      const current = this.llmForm.image_model || this.emptyImageModelSettings();
      return {
        enabled: !!current.enabled,
        name: String(current.name || '').trim(),
        base_url: String(current.base_url || '').trim(),
        model: String(current.model || '').trim(),
        size: String(current.size || '1024x1024').trim(),
        quality: String(current.quality || '').trim(),
        response_format: String(current.response_format || '').trim(),
        endpoint_path: String(current.endpoint_path || '/images/generations').trim(),
        n: Math.max(1, Math.min(4, Number(current.n || 1))),
        timeout: Math.max(10, Math.min(300, Number(current.timeout || 90))),
        api_key: String(current.api_key || '').trim(),
        clear_api_key: !!current.clear_api_key,
      };
    },

    emptyMemorySettings() {
      return {
        enabled: true,
        auto_summary_enabled: true,
        auto_summary_message_threshold: 10,
        auto_summary_delta_messages: 8,
        bind_memories_to_conversation: true,
        include_role_memories: true,
        max_memories: 6,
      };
    },

    normalizeMemorySettings(data = {}) {
      const base = this.emptyMemorySettings();
      const value = data && typeof data === 'object' ? data : {};
      return {
        enabled: value.enabled !== false,
        auto_summary_enabled: value.auto_summary_enabled !== false,
        auto_summary_message_threshold: Math.max(2, Math.min(200, Number(value.auto_summary_message_threshold || base.auto_summary_message_threshold))),
        auto_summary_delta_messages: Math.max(1, Math.min(200, Number(value.auto_summary_delta_messages || base.auto_summary_delta_messages))),
        bind_memories_to_conversation: value.bind_memories_to_conversation !== false,
        include_role_memories: value.include_role_memories !== false,
        max_memories: Math.max(0, Math.min(20, Number(value.max_memories ?? base.max_memories))),
      };
    },

    defaultModelPricing() {
      return { mode: 'per_request', input_price: 25, output_price: 25 };
    },

    normalizeModelPricing(value = {}) {
      const mode = value?.mode === 'per_token' ? 'per_token' : 'per_request';
      const fallback = this.defaultModelPricing();
      return {
        mode,
        input_price: Math.max(0, Number(value?.input_price ?? fallback.input_price) || 0),
        output_price: Math.max(0, Number(value?.output_price ?? fallback.output_price) || 0),
      };
    },

    syncModelConfigs(preset) {
      const models = this.parseModelsText(preset?.modelsText || preset?.model);
      const existing = new Map((preset?.modelConfigs || []).map(item => [String(item?.model || ''), item]));
      const promptOptions = this.globalPromptPresetOptions();
      const fallbackPresetId = String(this.globalPresets?.prompt?.active_id || promptOptions[0]?.id || '');
      preset.modelConfigs = models.map(model => {
        const current = existing.get(model) || {};
        return {
          model,
          display_name: String(current.display_name || current.name || model),
          preset_id: String(current.preset_id || fallbackPresetId),
          pricing: this.normalizeModelPricing(current.pricing || current),
        };
      });
      if (models.length && !models.includes(String(preset.model || '').trim())) preset.model = models[0];
      return preset.modelConfigs;
    },

    globalPromptPresetOptions() {
      return this.globalPresets?.prompt?.items || [];
    },

    modelPricingHint(config) {
      const pricing = this.normalizeModelPricing(config?.pricing || {});
      if (pricing.mode === 'per_token') {
        return `输入 ${pricing.input_price} / 输出 ${pricing.output_price} 惑梦币 / 1M Token`;
      }
      return `每轮 ${pricing.input_price + pricing.output_price} 惑梦币`;
    },

    async loadLlmSettings() {
      this.loading = true;
      try {
        const r = await api.admin.llmSettings();
        const data = r.data || r;
        this.llmSettings = data;
        const presets = (data.presets && data.presets.length ? data.presets : [{
          id: 'default',
          name: '默认模型',
          enabled: data.enabled !== false,
          protocol: data.protocol || 'openai',
          base_url: data.base_url || '',
          model: data.model || '',
          models: data.models || (data.model ? [data.model] : []),
          temperature: data.temperature ?? 0.8,
          has_api_key: !!data.has_api_key,
          api_key_preview: data.api_key_preview || '',
        }]).map(p => ({
          id: p.id || this.newPresetId(),
          name: p.name || p.model || '模型预设',
          enabled: p.enabled !== false,
          protocol: p.protocol || 'openai',
          base_url: p.base_url || '',
          model: p.model || '',
          modelsText: (Array.isArray(p.models) && p.models.length ? p.models : [p.model || '']).filter(Boolean).join('\n'),
          temperature: p.temperature ?? 0.8,
          api_key: '',
          clear_api_key: false,
          has_api_key: !!p.has_api_key,
          api_key_preview: p.api_key_preview || '',
          catalog_loading: false,
          probe_loading: false,
          auto_loading: false,
          catalog_meta: null,
          probe_summary: null,
          probe_results: [],
          modelConfigs: Array.isArray(p.model_configs) ? p.model_configs.map(item => ({
            model: String(item.model || ''),
            display_name: String(item.display_name || item.name || item.model || ''),
            preset_id: String(item.preset_id || ''),
            pricing: this.normalizeModelPricing(item.pricing || item),
          })) : [],
        }));
        presets.forEach(preset => this.syncModelConfigs(preset));
        this.llmForm = {
          enabled: data.enabled !== false,
          protocol: data.protocol || 'openai',
          base_url: data.base_url || '',
          model: data.model || '',
          temperature: data.temperature ?? 0.8,
          api_key: '',
          clear_api_key: false,
          default_model_preset_id: data.default_model_preset_id || presets[0]?.id || 'default',
          presets,
          global_prompt_preset: this.normalizeGlobalPromptPreset(data.global_prompt_preset || {}),
          image_model: this.normalizeImageModelSettings(data.image_model || {}),
          memory_settings: this.normalizeMemorySettings(data.memory_settings || {}),
        };
        this.globalPromptImportRaw = '';
      } catch (err) {
        this.showToast(err.message || '加载模型配置失败', 'error');
      } finally { this.loading = false; }
    },

    async saveLlmSettings() {
      this.loading = true;
      try {
        const payload = {
          enabled: !!this.llmForm.enabled,
          base_url: String(this.llmForm.base_url || '').trim(),
          model: String(this.llmForm.model || '').trim(),
          temperature: Number(this.llmForm.temperature || 0.8),
          clear_api_key: !!this.llmForm.clear_api_key,
          default_model_preset_id: this.llmForm.default_model_preset_id,
          image_model: this.serializeImageModelSettings(),
          memory_settings: this.normalizeMemorySettings(this.llmForm.memory_settings || {}),
          presets: this.llmForm.presets.map(p => {
            this.syncModelConfigs(p);
            return ({
            id: String(p.id || '').trim(),
            name: String(p.name || '').trim(),
            enabled: !!p.enabled,
            protocol: String(p.protocol || 'openai').trim(),
            base_url: String(p.base_url || '').trim(),
            model: this.parseModelsText(p.modelsText || p.model)[0] || String(p.model || '').trim(),
            models: this.parseModelsText(p.modelsText || p.model),
            temperature: Number(p.temperature || 0.8),
            api_key: String(p.api_key || '').trim(),
            clear_api_key: !!p.clear_api_key,
            model_configs: (p.modelConfigs || []).map(item => ({
              model: String(item.model || '').trim(),
              display_name: String(item.display_name || item.model || '').trim(),
              preset_id: String(item.preset_id || '').trim(),
              pricing: this.normalizeModelPricing(item.pricing || {}),
            })),
          }); }),
        };
        if (!payload.presets.length) {
          this.showToast('至少保留一个模型预设', 'error');
          this.loading = false;
          return;
        }
        if (payload.presets.some(p => !p.name || !p.model)) {
          this.showToast('每个模型预设都需要名称和模型名', 'error');
          this.loading = false;
          return;
        }
        if (String(this.llmForm.api_key || '').trim()) {
          payload.api_key = String(this.llmForm.api_key || '').trim();
        }
        const r = await api.admin.saveLlmSettings(payload);
        this.llmSettings = r.data || r;
        this.llmForm.image_model = this.normalizeImageModelSettings(this.llmSettings.image_model || payload.image_model);
        this.llmForm.memory_settings = this.normalizeMemorySettings(this.llmSettings.memory_settings || payload.memory_settings);
        const savedPresets = Array.isArray(this.llmSettings.presets) ? this.llmSettings.presets : [];
        this.llmForm.presets.forEach((preset) => {
          const saved = savedPresets.find(item => item.id === preset.id);
          preset.api_key = '';
          preset.clear_api_key = false;
          preset.has_api_key = saved ? !!saved.has_api_key : !!preset.has_api_key;
          preset.api_key_preview = saved?.api_key_preview || preset.api_key_preview || '';
        });
        this.llmForm.api_key = '';
        this.llmForm.clear_api_key = false;
        this.llmForm.image_model.api_key = '';
        this.llmForm.image_model.clear_api_key = false;
        this.showToast('模型配置已保存', 'success');
      } catch (err) {
        this.showToast(err.message || '保存模型配置失败', 'error');
      } finally { this.loading = false; }
    },

    newPresetId() {
      return 'preset-' + Math.random().toString(36).slice(2, 10);
    },

    addModelPreset() {
      const id = this.newPresetId();
      this.llmForm.presets.push({
        id,
        name: '新 API 节点',
        enabled: true,
        protocol: 'openai',
        base_url: '',
        model: '',
        modelsText: '',
        temperature: 0.8,
        api_key: '',
        clear_api_key: false,
        has_api_key: false,
        api_key_preview: '',
        catalog_loading: false,
        probe_loading: false,
        auto_loading: false,
        catalog_meta: null,
        probe_summary: null,
        probe_results: [],
        modelConfigs: [],
      });
      if (!this.llmForm.default_model_preset_id) this.llmForm.default_model_preset_id = id;
    },

    modelNodePayload(preset) {
      return {
        preset_id: String(preset?.id || '').trim(),
        protocol: String(preset?.protocol || 'openai').trim(),
        base_url: String(preset?.base_url || '').trim(),
        api_key: String(preset?.api_key || '').trim(),
        clear_api_key: !!preset?.clear_api_key,
      };
    },

    async discoverPresetModels(preset, { quiet = false } = {}) {
      if (!String(preset?.base_url || '').trim()) {
        const err = new Error('请先填写 Base URL');
        if (!quiet) this.showToast(err.message, 'error');
        throw err;
      }
      preset.catalog_loading = true;
      preset.catalog_meta = null;
      try {
        const response = await api.admin.discoverLlmModels(this.modelNodePayload(preset));
        const data = response.data || response;
        const models = this.parseModelsText(data.models || []);
        if (!models.length) throw new Error('模型目录没有返回可用的模型 ID');
        preset.modelsText = models.join('\n');
        if (!models.includes(String(preset.model || '').trim())) preset.model = models[0];
        this.syncModelConfigs(preset);
        preset.catalog_meta = {
          total: Number(data.total || models.length),
          elapsed_ms: Number(data.elapsed_ms || 0),
          truncated: !!data.truncated,
        };
        preset.probe_summary = null;
        preset.probe_results = [];
        if (!quiet) this.showToast(`已读取 ${models.length} 个候选模型`, 'success');
        return models;
      } catch (err) {
        if (!quiet) this.showToast(err.message || '读取模型目录失败', 'error');
        throw err;
      } finally {
        preset.catalog_loading = false;
      }
    },

    async probePresetModels(preset, models = null, { quiet = false, apply = true } = {}) {
      const candidates = this.parseModelsText(models || preset?.modelsText || preset?.model);
      if (!candidates.length) {
        const err = new Error('请先填写或读取模型列表');
        if (!quiet) this.showToast(err.message, 'error');
        throw err;
      }
      preset.probe_loading = true;
      preset.probe_summary = null;
      preset.probe_results = [];
      try {
        const results = [];
        let elapsedMs = 0;
        for (let offset = 0; offset < candidates.length; offset += 12) {
          const batch = candidates.slice(offset, offset + 12);
          const response = await api.admin.probeLlmModels({
            ...this.modelNodePayload(preset),
            models: batch,
            timeout: 45,
          });
          const data = response.data || response;
          results.push(...(Array.isArray(data.results) ? data.results : []));
          elapsedMs += Number(data.elapsed_ms || 0);
          const currentAvailable = results.filter(item => item.available).length;
          preset.probe_results = [...results];
          preset.probe_summary = {
            total: results.length,
            available: currentAvailable,
            failed: results.length - currentAvailable,
            elapsed_ms: elapsedMs,
          };
        }
        const availableModels = this.parseModelsText(results.filter(item => item.available).map(item => item.model));
        if (apply && availableModels.length) this.applyAvailableModels(preset, availableModels, false);
        const message = availableModels.length
          ? `检测完成：${availableModels.length}/${results.length || candidates.length} 个模型可对话，已填入当前节点`
          : '检测完成：没有模型通过真实对话探测，原列表未改动';
        if (!quiet) this.showToast(message, availableModels.length ? 'success' : 'error');
        return {
          results,
          available_models: availableModels,
          total: results.length,
          available: availableModels.length,
          failed: results.length - availableModels.length,
          elapsed_ms: elapsedMs,
        };
      } catch (err) {
        if (!quiet) this.showToast(err.message || '模型检测失败', 'error');
        throw err;
      } finally {
        preset.probe_loading = false;
      }
    },

    async autoConfigurePreset(preset) {
      preset.auto_loading = true;
      try {
        const models = await this.discoverPresetModels(preset, { quiet: true });
        const result = await this.probePresetModels(preset, models, { quiet: true, apply: true });
        const available = Number(result.available || 0);
        this.showToast(
          available
            ? `自动接入完成：${available} 个可用模型已填入，点击“保存模型配置”后对用户生效`
            : '自动接入完成，但没有模型通过真实对话探测',
          available ? 'success' : 'error',
        );
      } catch (err) {
        this.showToast(err.message || '自动接入模型节点失败', 'error');
      } finally {
        preset.auto_loading = false;
      }
    },

    applyAvailableModels(preset, models = null, notify = true) {
      const available = this.parseModelsText(
        models || (preset?.probe_results || []).filter(item => item.available).map(item => item.model),
      );
      if (!available.length) {
        if (notify) this.showToast('当前没有通过检测的模型', 'error');
        return;
      }
      preset.modelsText = available.join('\n');
      if (!available.includes(String(preset.model || '').trim())) preset.model = available[0];
      this.syncModelConfigs(preset);
      preset.enabled = true;
      if (notify) this.showToast(`已仅保留 ${available.length} 个可用模型`, 'success');
    },

    modelProbeStatusLabel(item) {
      if (item?.available) return '可用';
      return {
        timeout: '超时',
        http_error: 'HTTP 失败',
        empty_response: '空回复',
        incomplete_stream: '截流',
      }[item?.status] || '失败';
    },

    removeModelPreset(index) {
      if (this.llmForm.presets.length <= 1) {
        this.showToast('至少保留一个模型预设', 'error');
        return;
      }
      const [removed] = this.llmForm.presets.splice(index, 1);
      if (removed?.id === this.llmForm.default_model_preset_id) {
        this.llmForm.default_model_preset_id = this.llmForm.presets[0]?.id || '';
      }
    },

    setDefaultModelPreset(preset) {
      this.llmForm.default_model_preset_id = preset.id;
    },

    parseModelsText(value) {
      return String(value || '')
        .split(/[,\n，;；]+/)
        .map(s => s.trim())
        .filter((s, idx, arr) => s && arr.indexOf(s) === idx);
    },

    readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
    },

    async loadTavoPlugins() {
      this.loading = true;
      try {
        const r = await api.admin.tavoPlugins();
        const data = r.data || r;
        this.tavoPlugins = data.list || [];
      } catch (err) {
        this.showToast(err.message || '加载对话扩展失败', 'error');
      } finally { this.loading = false; }
    },

    async onTavoPluginFileChange(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.tavoPluginUploading = true;
      this.tavoPluginFileName = file.name;
      try {
        const dataUrl = await this.readFileAsDataUrl(file);
        const r = await api.admin.importTavoPlugin({ filename: file.name, package_file: dataUrl });
        const plugin = (r.data || r).extension || {};
        this.tavoPluginDetail = plugin;
        this.showToast(`扩展已导入：${plugin.display_name || plugin.name || file.name}`, 'success');
        await this.loadTavoPlugins();
      } catch (err) {
        this.showToast(err.message || '扩展导入失败', 'error');
      } finally {
        this.tavoPluginUploading = false;
        event.target.value = '';
      }
    },

    async toggleTavoPlugin(plugin) {
      if (!plugin?.id) return;
      this.loading = true;
      try {
        const nextEnabled = !plugin.enabled;
        const r = await api.admin.toggleTavoPlugin(plugin.id, nextEnabled);
        const updated = (r.data || r).extension;
        const idx = this.tavoPlugins.findIndex(item => item.id === plugin.id);
        if (idx >= 0 && updated) this.tavoPlugins.splice(idx, 1, updated);
        if (this.tavoPluginDetail?.id === plugin.id && updated) this.tavoPluginDetail = updated;
        this.showToast(nextEnabled ? '扩展已启用' : '扩展已停用', 'success');
      } catch (err) {
        this.showToast(err.message || '扩展状态更新失败', 'error');
      } finally { this.loading = false; }
    },

    async deleteTavoPlugin(plugin) {
      if (!plugin?.id) return;
      if (!confirm(`删除对话扩展「${plugin.display_name || plugin.name || plugin.id}」？`)) return;
      this.loading = true;
      try {
        await api.admin.deleteTavoPlugin(plugin.id);
        this.tavoPlugins = this.tavoPlugins.filter(item => item.id !== plugin.id);
        if (this.tavoPluginDetail?.id === plugin.id) this.tavoPluginDetail = null;
        this.showToast('扩展已删除', 'success');
      } catch (err) {
        this.showToast(err.message || '扩展删除失败', 'error');
      } finally { this.loading = false; }
    },

    showTavoPluginDetail(plugin) {
      this.tavoPluginDetail = plugin || null;
    },

    tavoPluginFeatureBadges(plugin) {
      const badges = [];
      if (plugin?.js) badges.push({ key: 'js', label: 'JavaScript', count: 1 });
      if (plugin?.css) badges.push({ key: 'css', label: 'CSS', count: 1 });
      const hookCount = Object.keys(plugin?.hooks || {}).length;
      if (hookCount) badges.push({ key: 'hooks', label: '生命周期', count: hookCount });
      const requiredCount = Array.isArray(plugin?.requires) ? plugin.requires.length : 0;
      if (requiredCount) badges.push({ key: 'requires', label: '必需依赖', count: requiredCount });
      return badges;
    },

    emptyAppForm() {
      return {
        id: '',
        source: 'admin',
        name: '',
        summary: '',
        description: '',
        opening_statement: '',
        pre_prompt: '',
        tagsText: '',
        cover_url: '',
        llm_model: '',
        sort_weight: 100,
        official_recommended: false,
        is_public: true,
        status: 'published',
        creator_notes: '',
        creator: '',
        character_version: '',
        personality: '',
        scenario: '',
        mes_example: '',
        post_history_instructions: '',
        alternate_greetings_raw: '[]',
        world_info_raw: '[]',
        regex_scripts_raw: '[]',
        prompt_blocks_raw: '[]',
        quick_replies_raw: '[]',
        extensions_raw: '{}',
        sampling_raw: '{}',
        full_json_raw: '{}',
        merge_full_json: false,
      };
    },

    emptyBulkForm() {
      return {
        tags_mode: 'none',
        tagsText: '',
        summary_enabled: false,
        summary: '',
        description_enabled: false,
        description: '',
        world_mode: 'none',
        worldRaw: '',
      };
    },

    async loadApps(page = 1) {
      if (page < 1) page = 1;
      this.loading = true;
      try {
        const r = await api.admin.apps({
          page,
          page_size: this.appLimit,
          source: this.appSource,
          q: this.appSearch.trim(),
          lightweight: 1,
          official_recommended: this.appOfficialFilter === 'all' ? '' : this.appOfficialFilter,
        });
        const data = r.data || r;
        this.apps = data.list || [];
        this.appTotal = data.total || 0;
        this.appPage = data.page || page;
        const visible = new Set(this.apps.map(app => app.id));
        this.selectedAppIds = this.selectedAppIds.filter(id => visible.has(id));
      } catch (err) {
        this.showToast(err.message || '加载角色卡失败', 'error');
      } finally { this.loading = false; }
    },

    isAppSelected(app) {
      return !!app?.id && this.selectedAppIds.includes(app.id);
    },

    currentAppIds() {
      return (this.apps || []).map(app => app.id).filter(Boolean);
    },

    currentAppsAllSelected() {
      const ids = this.currentAppIds();
      return ids.length > 0 && ids.every(id => this.selectedAppIds.includes(id));
    },

    toggleAppSelection(app) {
      if (!app?.id) return;
      if (this.selectedAppIds.includes(app.id)) {
        this.selectedAppIds = this.selectedAppIds.filter(id => id !== app.id);
      } else {
        this.selectedAppIds = [...this.selectedAppIds, app.id];
      }
    },

    toggleSelectCurrentApps(checked) {
      const ids = this.currentAppIds();
      if (checked) {
        const set = new Set([...this.selectedAppIds, ...ids]);
        this.selectedAppIds = Array.from(set);
      } else {
        const visible = new Set(ids);
        this.selectedAppIds = this.selectedAppIds.filter(id => !visible.has(id));
      }
    },

    clearAppSelection() {
      this.selectedAppIds = [];
    },

    openBulkDialog() {
      if (!this.selectedAppIds.length) {
        this.showToast('请先勾选角色卡', 'error');
        return;
      }
      this.appBulkForm = this.emptyBulkForm();
      this.appBulkResult = null;
      this.appBulkDialog = true;
    },

    parseBulkTags() {
      return String(this.appBulkForm?.tagsText || '')
        .split(/[，,\n;；|]/)
        .map(s => s.trim())
        .filter(Boolean);
    },

    parseBulkWorldInfo() {
      const raw = String(this.appBulkForm?.worldRaw || '').trim();
      if (!raw) throw new Error('请填写世界书 JSON');
      return JSON.parse(raw);
    },

    async submitBulkUpdate() {
      if (!this.appBulkForm || !this.selectedAppIds.length) return;
      const form = this.appBulkForm;
      const tagsMode = form.tags_mode || 'none';
      const worldMode = form.world_mode || 'none';
      const hasOperation = tagsMode !== 'none' || form.summary_enabled || form.description_enabled || worldMode !== 'none';
      if (!hasOperation) {
        this.showToast('请选择至少一种批量修改内容', 'error');
        return;
      }
      const payload = {
        ids: [...this.selectedAppIds],
        tags_mode: tagsMode,
        summary_enabled: !!form.summary_enabled,
        summary: form.summary || '',
        description_enabled: !!form.description_enabled,
        description: form.description || '',
        world_mode: worldMode,
      };
      try {
        if (tagsMode !== 'none') {
          const tags = this.parseBulkTags();
          if (!tags.length) throw new Error('请填写要处理的标签');
          payload.tags = tags;
        }
        if (worldMode !== 'none') {
          payload.world_info = this.parseBulkWorldInfo();
        }
      } catch (err) {
        this.showToast(err.message || '批量参数解析失败', 'error');
        return;
      }
      if (!confirm(`确认批量修改 ${payload.ids.length} 张角色卡？`)) return;
      this.loading = true;
      try {
        const r = await api.admin.bulkUpdateApps(payload);
        this.appBulkResult = r.data || r;
        this.showToast(`批量编辑完成：更新 ${this.appBulkResult.updated || 0} 张`, 'success');
        await this.loadApps(this.appPage);
      } catch (err) {
        this.showToast(err.message || '批量编辑失败', 'error');
      } finally { this.loading = false; }
    },

    createAppDialog() {
      this.appDialog = this.emptyAppForm();
    },

    async editAppDialog(app) {
      let detail = app || {};
      if (app?.id) {
        try {
          const r = await api.admin.appDetail(app.id);
          detail = r.data || r;
        } catch (err) {
          this.showToast(err.message || '读取角色详情失败', 'error');
        }
      }
      this.appDialog = {
        ...this.emptyAppForm(),
        id: detail.id || app?.id || '',
        source: detail.source || app?.source || 'admin',
        name: detail.name || app?.name || '',
        summary: detail.summary || app?.summary || '',
        description: detail.description || app?.description || '',
        opening_statement: detail.opening_statement || '',
        pre_prompt: detail.pre_prompt || '',
        tagsText: (detail.tags || app?.tags || []).join('，'),
        cover_url: detail.cover || detail.cover_url || detail.icon || app?.cover || app?.cover_url || app?.icon || '',
        llm_model: detail.llm_model || '',
        sort_weight: detail.sort_weight ?? app?.sort_weight ?? 100,
        official_recommended: !!(detail.official_recommended ?? app?.official_recommended),
        is_public: detail.is_public !== false,
        status: detail.status || app?.status || 'published',
        creator_notes: detail.creator_notes || '',
        creator: detail.creator || '',
        character_version: detail.character_version || '',
        personality: detail.personality || '',
        scenario: detail.scenario || '',
        mes_example: detail.mes_example || '',
        post_history_instructions: detail.post_history_instructions || '',
        alternate_greetings_raw: this.prettyJsonDefault(detail.alternate_greetings || [], []),
        world_info_raw: this.prettyJsonDefault(detail.world_info || [], []),
        regex_scripts_raw: this.prettyJsonDefault(detail.regex_scripts || [], []),
        prompt_blocks_raw: this.prettyJsonDefault(detail.prompt_blocks || [], []),
        quick_replies_raw: this.prettyJsonDefault(detail.quick_replies || [], []),
        extensions_raw: this.prettyJsonDefault(detail.extensions || {}, {}),
        sampling_raw: this.prettyJsonDefault(detail.sampling || {}, {}),
        full_json_raw: this.prettyJsonDefault(detail || {}, {}),
        merge_full_json: false,
      };
    },

    appPayload() {
      const app = this.appDialog || {};
      const payload = {
        name: String(app.name || '').trim(),
        summary: String(app.summary || '').trim(),
        description: String(app.description || '').trim(),
        opening_statement: String(app.opening_statement || '').trim(),
        pre_prompt: String(app.pre_prompt || '').trim(),
        tags: String(app.tagsText || '').split(/[，,\n]/).map(s => s.trim()).filter(Boolean),
        cover_url: String(app.cover_url || '').trim(),
        llm_model: String(app.llm_model || '').trim(),
        sort_weight: Number(app.sort_weight || 0),
        official_recommended: !!app.official_recommended,
        is_public: !!app.is_public,
        status: app.status || 'published',
      };
      payload.creator_notes = String(app.creator_notes || '').trim();
      payload.creator = String(app.creator || '').trim();
      payload.character_version = String(app.character_version || '').trim();
      payload.personality = String(app.personality || '').trim();
      payload.scenario = String(app.scenario || '').trim();
      payload.mes_example = String(app.mes_example || '').trim();
      payload.post_history_instructions = String(app.post_history_instructions || '').trim();
      payload.alternate_greetings = this.parseJsonArrayEditor('备用开场', app.alternate_greetings_raw);
      payload.world_info = this.parseWorldInfoEditor(app.world_info_raw);
      payload.regex_scripts = this.parseJsonArrayEditor('Regex/TavernHelper 脚本', app.regex_scripts_raw);
      payload.prompt_blocks = this.parseJsonArrayEditor('Prompt Blocks', app.prompt_blocks_raw);
      payload.quick_replies = this.parseJsonArrayEditor('Quick Replies', app.quick_replies_raw);
      payload.extensions = this.parseJsonObjectEditor('Extensions', app.extensions_raw);
      payload.sampling = this.parseJsonObjectEditor('Sampling', app.sampling_raw);
      if (app.merge_full_json) {
        const full = this.parseJsonObjectEditor('完整 JSON', app.full_json_raw);
        Object.assign(payload, full, {
          name: payload.name,
          summary: payload.summary,
          description: payload.description,
          opening_statement: payload.opening_statement,
          pre_prompt: payload.pre_prompt,
          tags: payload.tags,
          cover_url: payload.cover_url,
          llm_model: payload.llm_model,
          sort_weight: payload.sort_weight,
          official_recommended: payload.official_recommended,
          is_public: payload.is_public,
          status: payload.status,
        });
      }
      return payload;
    },

    async saveAppDialog() {
      if (!this.appDialog) return;
      let payload;
      try {
        payload = this.appPayload();
      } catch (err) {
        this.showToast(err.message || '角色卡 JSON 解析失败', 'error');
        return;
      }
      if (!payload.name) {
        this.showToast('请填写角色名称', 'error');
        return;
      }
      this.loading = true;
      try {
        if (this.appDialog.id) {
          await api.admin.updateApp(this.appDialog.id, payload);
          this.showToast('角色卡已保存', 'success');
        } else {
          await api.admin.createApp(payload);
          this.showToast('角色卡已发布', 'success');
        }
        this.appDialog = null;
        await this.loadApps(this.appPage);
      } catch (err) {
        this.showToast(err.message || '保存角色卡失败', 'error');
      } finally { this.loading = false; }
    },

    async deleteApp(app) {
      if (!confirm(`删除角色卡「${app.name || app.id}」？来源：${app.source || '-'}。此操作不可恢复。`)) return;
      this.loading = true;
      try {
        await api.admin.deleteApp(app.id);
        this.showToast('角色卡已删除', 'success');
        await this.loadApps(this.appPage);
      } catch (err) {
        this.showToast(err.message || '删除角色卡失败', 'error');
      } finally { this.loading = false; }
    },

    async quickToggleAppPublic(app) {
      if (!app?.id) return;
      this.loading = true;
      try {
        await api.admin.updateApp(app.id, { is_public: app.is_public === false });
        this.showToast(app.is_public === false ? '已公开' : '已设为私有', 'success');
        await this.loadApps(this.appPage);
      } catch (err) {
        this.showToast(err.message || '状态更新失败', 'error');
      } finally { this.loading = false; }
    },

    async quickSetAppStatus(app, status) {
      if (!app?.id) return;
      this.loading = true;
      try {
        await api.admin.updateApp(app.id, { status });
        this.showToast(status === 'published' ? '已发布' : '已保存为草稿', 'success');
        await this.loadApps(this.appPage);
      } catch (err) {
        this.showToast(err.message || '状态更新失败', 'error');
      } finally { this.loading = false; }
    },

    async quickToggleOfficialRecommendation(app) {
      if (!app?.id) return;
      this.loading = true;
      try {
        const next = !app.official_recommended;
        await api.admin.updateApp(app.id, { official_recommended: next });
        this.showToast(next ? '已加入官推卡池' : '已移出官推卡池', 'success');
        await this.loadApps(this.appPage);
      } catch (err) {
        this.showToast(err.message || '官推卡池更新失败', 'error');
      } finally { this.loading = false; }
    },

    openImportDialog() {
      this.appImportDialog = true;
      this.appImportRaw = '';
      this.appImportFileName = '';
      this.appImportResult = null;
    },

    async onAppImportFileChange(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.appImportFileName = file.name;
      try {
        this.appImportRaw = await file.text();
        this.appImportResult = null;
      } catch (err) {
        this.showToast('读取 JSON 文件失败', 'error');
      } finally {
        event.target.value = '';
      }
    },

    parseImportItems() {
      const raw = String(this.appImportRaw || '').trim();
      if (!raw) throw new Error('请上传或粘贴角色卡 JSON');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        for (const key of ['items', 'list', 'cards', 'apps', 'characters', 'data']) {
          if (Array.isArray(parsed[key])) return parsed[key];
        }
        return [parsed];
      }
      throw new Error('JSON 格式不支持');
    },

    async submitAppImport() {
      let items = [];
      try {
        items = this.parseImportItems();
      } catch (err) {
        this.showToast(err.message || 'JSON 解析失败', 'error');
        return;
      }
      this.loading = true;
      try {
        const r = await api.admin.importApps({ items });
        this.appImportResult = r.data || r;
        this.showToast(`导入完成：成功 ${this.appImportResult.count || 0} 条`, 'success');
        await this.loadApps(1);
      } catch (err) {
        this.showToast(err.message || '导入失败', 'error');
      } finally { this.loading = false; }
    },

    async onAppCoverChange(event) {
      const file = event.target.files?.[0];
      if (!file || !this.appDialog) return;
      this.appCoverUploading = true;
      try {
        const dataUrl = await this.readFileAsDataUrl(file);
        const r = await api.uploadCover(dataUrl, file.name);
        const data = r.data || r;
        this.appDialog.cover_url = data.url || data.path || '';
        this.showToast('封面已上传', 'success');
      } catch (err) {
        this.showToast(err.message || '封面上传失败', 'error');
      } finally {
        this.appCoverUploading = false;
        event.target.value = '';
      }
    },

    adjustPointsPrompt(user) {
      this.pointsDialog = { id: user.id, name: user.name, email: user.email, points: user.points, delta: 0 };
    },

    async confirmAdjustPoints() {
      const dialog = this.pointsDialog;
      if (!dialog || !dialog.delta) return;
      this.loading = true;
      try {
        await api.admin.adjustPoints(dialog.id, dialog.delta);
        this.showToast(`积分已${dialog.delta > 0 ? '增加' : '扣减'} ${Math.abs(dialog.delta)}`, 'success');
        this.pointsDialog = null;
        await this.loadUsers(this.userPage);
      } catch (err) {
        this.showToast(err.message || '操作失败', 'error');
      } finally { this.loading = false; }
    },

    async toggleUserAdmin(user) {
      if (!user?.id || user.can_toggle_admin === false) return;
      const next = !user.is_admin;
      if (this.adminInfo?.id === user.id && !next) {
        this.showToast('不能撤销当前登录账号自己的管理员权限', 'error');
        return;
      }
      const action = next ? '开放管理员权限给' : '撤销管理员权限：';
      if (!confirm(`${action}${user.email || user.name || user.id}？`)) return;
      this.loading = true;
      try {
        await api.admin.setUserAdmin(user.id, next);
        this.showToast(next ? '已开放管理员权限' : '已撤销管理员权限', 'success');
        await this.loadUsers(this.userPage);
        await this.loadStats();
      } catch (err) {
        this.showToast(err.message || '权限更新失败', 'error');
      } finally { this.loading = false; }
    },

    advancedCreationLabel(user) {
      const access = user?.advanced_creation || {};
      if (access.source === 'admin') return '后台开放';
      if (access.source === 'farm') return '农场全解锁';
      return `未开放 · ${access.unlocked_plots || 0}/8`;
    },

    advancedCreationBadge(user) {
      const source = user?.advanced_creation?.source;
      return source === 'admin' ? 'xy-badge-purple' : (source === 'farm' ? 'xy-badge-green' : 'xy-badge-gray');
    },

    async toggleAdvancedCreation(user) {
      if (!user?.id) return;
      const next = !user?.advanced_creation?.admin_override;
      const action = next ? '后台开放高级创作给' : '收回后台高级创作权限：';
      if (!confirm(`${action}${user.email || user.name || user.id}？`)) return;
      this.loading = true;
      try {
        await api.admin.setAdvancedCreation(user.id, next);
        this.showToast(next ? '已开放高级创作' : '已收回后台开放权限', 'success');
        await this.loadUsers(this.userPage);
      } catch (err) {
        this.showToast(err.message || '高级创作权限更新失败', 'error');
      } finally { this.loading = false; }
    },
  };
}

window.adminPanel = adminPanel;

document.addEventListener('alpine:init', () => {
  if (window.Alpine && typeof window.Alpine.data === 'function') {
    window.Alpine.data('adminPanel', adminPanel);
  }
});
