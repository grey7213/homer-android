# Plan

按用户要求交付本地手机联网 debug 验收包，不把内部 loopback QA 包当作可用手机包。仅打包已经验证的当前实现，不声称原版主工程恢复或整个玩法验收完成。

## Scope

- In: 正式 HTTPS 账号接口、独立验收包身份、优香内置启动素材、其余人物私有 LAN 按需素材、横屏与键盘修正、本地安装包交付。
- Out: 正式提交/部署/发布、用户账号/历史数据复用、原版恢复完成声明、公共媒体上传。

## Action items

- [x] 核对当前源树、已完成浏览器与 Android 验证、LAN 地址和已有 R359 包；保留所有无关改动和旧证据。
- [x] 启动仅散列白名单的私有素材服务，核对同网段地址及完整响应摘要。192.168.1.101:8796，67个白名单包；GET 优香文件摘要与固定清单一致。服务进程59232；防火墙配置未修改，三个配置文件均显示disabled，端口过滤规则查询被拒绝。
- [x] 用 `.uireview` / 360、正式 HTTPS API、优香 starter 与 LAN 素材地址运行单元、lint、assembleDebug；不改正式构建默认值。33秒SUCCESS；104单元、0失败；lint0error/7warning。
- [x] 验证 APK 资源与源码映射、构建地址、身份、旧包签名一致；资源1848/612通过，签名与R359相同，主服务https://patcher.villainy.top/，新包88,107,753字节。隔离API35模拟器R359安装→R360覆盖安装均Success；联网配置新包3项原生方向/实际媒体/触摸键盘测试PASS（16.017秒），仍为合成外宿主/供应商，不冒充真实账号生成。
- [x] 复制到新的不可变验收目录，核对摘要，记录使用入口与已知限制，直接提供 APK 链接；无账号冷启动正式HTTPS登录页可见、全部输入为空、安全上下文true，未登录/读取玩家数据。

## Acceptance criteria / risks

- 手机包不含回环主服务地址；优香素材无需搬文件，未缓存其他人物素材需手机与电脑同 Wi-Fi、素材服务在线。
- 旧 R359 debug 包可按同包名同证书覆盖升级；正式版独立保留。签名不匹配则停止，不卸载或清数据。
- APK 验证通过且复制前后哈希一致；合成供应商/浏览器证据不冒充真实模型或手机端供应商结果。
- 独立重建的原版等价性、真实 CG/TTS/模型供应商和游戏域额外云备份仍未完整验收；用户本次索要的属于可安装预览验收包，不是完成版发布。

## Open questions

- 无需用户提供凭据或手动搬素材。

## Handoff evidence

- 文件：D:/网站/验收包/ChatArchive-R360/惑梦-基沃托斯-横屏验收-R360-debug.apk。
- 大小88,107,753字节；源码产物与交付副本SHA256相同：5492CA20CA5698B7E4B2819B47F03C89AF8B85FB627D74BD2540AFC0397C4DC7。
- 命令/证据：gradle-phone-handoff.log、apk-assets-phone-handoff.log、android-phone-handoff.log、android-phone-handoff-evidence/、phone-login-check.log及phone-login.png；素材服务stdout/stderr留在同一output目录。
- Playwright连接Android CDP时Browser.setDownloadBehavior被设备协议拒绝，这是工具能力限制，不是应用失败；改用只读Runtime.evaluate检查登录页，未降低产品安全检查。浏览器UI6/6沿用同源已完成证据，本轮未改UI源码。
- 本机未实际连接用户手机；LAN完整GET与摘要通过，不外推所有路由器的客户端隔离/跨网可达性。素材服务保持运行，仅散列路径，未公开上传。
- 本次用户明确要求安装包，交付为阶段性可安装验收预览；更大的完整玩法/真实供应商/游戏域云备份验收仍未完成，不把本次APK交付改称整体完成。
