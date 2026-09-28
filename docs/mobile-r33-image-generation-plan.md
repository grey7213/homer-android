# R33 · 聊天气泡生图

## 范围与验收

后台独立管理 OpenAI-compatible 图片模型；聊天长按菜单增加「生图」。按已授权分析的风月行为独立实现底部弹层，不复制第三方代码。保留已有聊天配置与 R25–R32 修复，不提交或部署。

1. [完成] 检查现有单模型配置、消息标识、代理、扣费事务与风月行为。
2. [完成] 增加多图片模型管理、认证接口、持久任务、私有图片与成功后原子结算。
3. [完成] 接入长按菜单、弹层、任务反馈与消息下方结果恢复。
4. [完成] 10项生图单元测试、5项R32计费回归、43项Android单元测试、lint和打包通过；双视口实际APK资源链路、暗色、普通用户权限、历史恢复通过。

## 行为规格

- 风月已确认：标题「生成图片」；UTF-8 长度和模型积分；「图片内容」多行输入；默认展开「图片模型」；取消/生成；提交成功后关闭；结果关联原消息。初始内容为空，默认首个可用模型。
- 本次不臆造风月服务端扩写；只发送用户确认的描述，不发送完整角色、世界书或历史。未添加风月无证据的扩写/负面词 UI。
- 移动端底部弹层，桌面居中限宽；使用本站主题、圆角、单色主按钮、44px 点击区域、安全区、键盘和返回键取消。无模型、断网、积分不足、生成失败均有明确状态。
- 管理员管理显示名、API 地址/密钥、模型、尺寸、质量、启用和单张积分；普通用户仅看公开名/说明/积分，不见密钥或上游模型标识。
- 客户端只创建任务并查询；生成不阻塞进入聊天。结果持久关联账号/会话/消息，重进恢复；重复提交标识不重复生成或扣分。

## 风险与验证

- 上游失败、空响应、伪图片、超时不扣积分；成功存图与积分/流水同事务，仅扣一次。
- 图片任务/内容必须验证登录和消息所有权；改请求不能跨账号取图。密钥不出现在日志或响应。
- 外部地址仅 HTTPS 公网；禁重定向转发密钥；有限响应大小、数量和超时。测试使用本机注入供应商，不请求付费上游。
- 单用户最多一项运行中任务，全局并发受限；重启遗留任务标记失败且不扣分。
- 验证后台保存/重新打开/空密钥保留、普通用户禁止修改、模型列表不泄密、成功/失败/重复/跨账号/历史恢复。
- 当前无风月设备截图基线，不能声称逐像素一致；以已确认控件结构和交互为验收，渲染截图人工检查。

## 已验证结果与交接

运行命令（仓库根目录）：

```powershell
python tools/tests/test_mobile_r33_images.py
$env:HOMER_BACKEND_SOURCE='C:/CodexWork/homer-community-r9/output/mobile-r31-submission/server/ai_fengyue_local_server.py'
python tools/tests/test_mobile_r32_billing.py
./android-app/gradlew.bat -p android-app testDebugUnitTest lintDebug assembleDebug
python tools/verify_apk_assets.py
python tools/tests/mobile_r33_e2e.py --credentials <本机凭据文件>
python tools/verify_cumulative_server.py --baseline output/mobile-r32/baseline --package server-patches/cumulative-r33 --destination <新的验证目录>
```

- 单元/回归：10 + 5 + 43 全通过；Android lint/build 通过。
- 浏览器使用真实 APK 内资源、真实 Python/Node 路由、真实任务库与积分事务；仅上游图片由隔离的本机供应商生成。390×844、1440×900 均通过。
- 实际表单配置 → 长按消息 → 描述/模型/费用 → 生成 → 图片回到原消息 → 重进恢复 → 失败/取消不扣积分。普通用户可以读模型和本人图片，不能读写管理配置；匿名请求401。公开列表不含上游标识、地址或密钥。
- 脚本、控制台、非导航取消网络失败和意外HTTP错误均为0。浅色/暗色截图已人工查看。证据：`output/mobile-r33/browser/report.json`、`sheet-390.png`、`sheet-dark-390.png`、`success-390.png` 等。
- 新版本281 / 1.17.3-debug，APK：`android-app/app/build/outputs/apk/debug/app-debug.apk`。SHA256：`AA06FBBD0C8D17A0C4A656E38D0F55EB2786791A172405CE6C588F18FE7B275E`。
- 前端完整累计交付：`web-patches/20260927-2330-cumulative-r25-r33-image-generation.patch`。不能与旧累计补丁叠加；后续用户已授权替代旧PR，提交状态以 [mobile-r33-submission.md](mobile-r33-submission.md) 为准。
- 后端完整累计快照：`server-patches/cumulative-r33/backend.patch`，8个文件在干净基线应用、逐一哈希验证通过。

## 上线边界（本轮未上线）

1. APK 默认仍连接既有正式服务器。本轮只改本地源文件/测试服务，没有给正式服配置密钥，也未再次调用付费上游。**仅安装新APK，不会自动把新接口部署到正式服。**
2. 正式上线需一并部署前端、Node代理、Python累计补丁；在后端环境执行 `python -m pip install -r tools/requirements-images.txt`，再重启服务。管理员在「生图模型」配置真实接口、模型、密钥与单张积分后才会对用户开放。
3. 目前生图绑定已保存的普通会话消息；临时管理员预览会话没有普通消息存档，入口会明确提示改用已保存会话，不会伪造消息或偷偷收费。
4. `adb devices` 未发现连接设备，本轮没有Android手机/模拟器操作验收。浏览器手机视口不是手机实测。未取得风月运行截图，不宣称像素级相同，也未假定其服务端扩写逻辑。
5. 默认只向图片服务发送用户填写的描述，不自动上传角色源文件、世界书或完整聊天。没有暗中加入额外文字扩写请求。
