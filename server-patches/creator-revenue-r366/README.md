# R366 积分创作收益增量

这不是 APK 内就能生效的功能。此前客户端已经调用收益/比例接口，但服务端没有相应路由或结算。此包需要维护者在独立测试服务器验证后，另行部署 Python 服务；本轮不连接或改写正式服务器。

## 输入与应用

基于已应用 `cumulative-r41`（并保留后续存档补丁）的工具目录。将 `homer_revenue.py` 放到服务端 `tools/`，先在副本运行 `git apply --check integration.patch`。检查成功后再应用；任何冲突都人工核对，不能以完整文件覆盖现有服务器源码。启动服务时只新增四张 `homer_creator_revenue_*` 表和默认 3500 基点配置；不读取或回写历史消费。

`integration.patch` 将模块挂在 Store 建表后、认证路由后和既有成功生成扣费事务里。模型请求、真实扣费、发放创作积分、收益账本和最终回复发送保持同一回滚边界；生成/发送异常不发放收益。没有生成重试、积分充值或提现接口。

## 合同

- `GET /console/api/web/earnings`：本人创作总积分及按卡累计积分；不泄露谁用了卡、消费记录或模型请求。无收益返回真实 0 和空列表。
- `GET /admin/api/creator-revenue`：当前 `rate_bps`，默认 3500。
- `PUT /admin/api/creator-revenue`：仅实时认证的管理员，整数 `rate_bps` 0–10000；修改记录到独立操作日志。修改只对之后消费生效。
- 创作者由服务端 `local_apps.owner_user_id` 确定，不接受客户端指定收款人。没有真实站内创作者的官方/上游卡不产生创作收益；有站内创作者的本人消费也按当前比例结算，不擅自改变“每个玩卡的人”的要求。
- 每次成功生成的真实消耗积分乘当次比例；不足 1 积分的部分按创作者和卡累计。重复生成请求标识不会重复发放分成；不意味着重新发送生成请求是安全或免费操作。
- 充值、签到、农场积分不计为创作收益或邀请收益。
- 当前服务没有可确认的邀请关系与奖励政策，因此 `invite_points:null`、`invite_available:false`，保留明确未接入状态；不虚构邀请收益。

## 验证与部署限制

本地测试使用独立内存 SQLite 及合成账号，不使用正式账号、存档或模型。测试结算精度、倍率变更、重复标识、创作者隔离、外部卡、回滚、角色校验、路由权限和无充值收益。

2026-10-11 本地验证：`python tools/tests/creator_revenue_test.py` 13 项通过，`python tools/tests/generation_intent_test.py` 4 项通过，`node --test tools/tests/backend-contracts-r366.test.mjs` 5 项通过。两个补丁在仓库外的现有服务源码副本依次真实应用成功，patched `ai_fengyue_local_server.py` 与累计 r41 `homer_generation.py` 均通过 `py_compile`。没有实际启动/部署正式服务，没有调用真实模型或付费接口；最终设备与服务端集成验收仍由本轮主任务继续完成。

正式 APK 354 的收益问题要在上述服务包上线后才能在真实账号验收。尚未部署不能声称“正式收益已修好”；邀请结算仍需产品确认的奖励规则和后端接入。

## 同包续写输入修复

`continuation.patch` 和 `homer_generation_intent.py` 是独立增量，依次在收益补丁后应用。旧后端的 Anthropic 适配在尾消息不是 user 时再次追加上一轮用户问题，使续写可能变成重复回答；新版本使用明确的续写意图，不按用户输入内容猜测操作类型、不截断模型输出来掩盖重复。

客户端实际生成发送点需将 `homer_generation_type`（`continue`、`normal` 等）放入发送给 Homer 的 JSON body，并保留 `homer_preview`。Node 的 custom include body 应透传此字段；无该字段的旧客户端保持原行为。模块统一在适配后确保续写的最后一条 user 消息明确要求接着写，不重复原文；普通生成、重写、摘要不改输入。

此处只验证真实 provider payload 的构造合同。模型仍可能忽略指令，最终 APK 需实测普通生成、重写、续写、停止、重新进入与实际正文推进；不能将合成合同测试作为真实模型体验通过。
