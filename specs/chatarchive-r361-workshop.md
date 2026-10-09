# Plan

在用户已认可的R360普通玩法上，移动探索页入口、打磨剧场UI，接入用户提供的ChatArchive模组工坊，并让账号存档独立于可重新下载的本机素材。全部验收通过后提交完整累计源码与服务端增量，不以仅APK/前端PR冒充服务器部署。

## Scope

- In: Android软件内探索通知旁剧场入口、现有横屏玩法UI打磨、工坊浏览/合法下载/导入、素材按需与稳定版本身份、游戏/分支云备份和重装恢复、本地优先与普通聊天回归、完整PR交接。
- Out: 把第三方账号自动绑定惑梦、绕过下载登录/验证码/许可、下载全部素材进入APK、上传第三方媒体到公共镜像、删除旧存档、未授权的其他功能或主题重做。

## Action items

- [x] 核对R360工程、入口、素材加载与游戏IDB边界，保留脏树与旧不可变验收包。
- [x] 核对工坊公开API及登录后实际ZIP内CAPK格式，记录行为合同与SHA256；未记录账号密码。
- [x] 移动探索通知旁入口、移除个人中心重复入口；紧凑大厅和人物选择，保留已认可的横屏玩法，待下面渲染验收。
- [x] 实现独立第三方浏览与CAPK/ZIP显式下载、校验/原子安装/取消；固定修订与哈希，不预下载素材进安装包。7Z/RAR尚不支持，不声称支持。
- [x] 实现账号隔离的完整游戏/分支同步与恢复：本机先提交、持久幂等云保存、离线待同步、CAS冲突不覆盖；服务端增量尚未部署。
- [x] 完成本地分层验证：Node2105通过/1跳过，Python77通过，Java107通过；三尺寸明暗工坊完整备份/分支恢复6/6，普通玩法6/6，1101消息完整运行时双尺寸通过。真实工坊浏览器下载、原生解析及Spine渲染已测；手机内工坊真实登录下载全链和正式服务器恢复仍未验收，不能冒称已完成。
- [x] 导出累计源码并在干净固定基线上应用九份补丁，2252个文件0差异；从新原生checkout重跑Node2105通过/1跳过、Python78通过、Java106通过/1可选样本跳过与lint，最终APK资源双哈希通过；原生3/3通过。最终不可变APK与R360同证书，覆盖安装成功。两份后端补丁在真实提供者副本上顺序应用/编译/规范化SHA通过。
- [ ] 活动：推送分支与PR并附真实检查结果；服务器增量单独交接，尚未部署，生产重装恢复不宣称完成。

## Acceptance criteria / risks

- 探索页通知紧邻剧场入口，个人中心不重复新增入口；普通探索布局与配色不变，手机点击区不小于44px。
- APK没有角色素材包；用户主动选择下载，失败/取消保留既有素材和存档。第三方页面不具备HomerNative权限，不携带惑梦Cookie/凭据。
- 工坊公开元数据包括资源UUID、不可变修订UUID、文件字节数/扩展名/SHA256；下载需该站自己的登录。站点支持ZIP/7Z/RAR/CAPK，不能把它们误称为当前内部HCAP。
- 素材、人物设定与游戏身份分离。卸载后登录同账号能恢复已确认云备份的游戏/回合/分支，缺素材时提供重新下载，不重新创建角色会话或重新收费生成。
- 断网期间尚未成功上传的手机私有数据无法在卸载后凭空恢复，UI必须如实显示待同步；不声称零网络也能恢复已被系统删除的未备份数据。
- 真实工坊包格式未获取前，不把合成ZIP验收当成实际CAPK/RAR兼容；缺登录只阻塞真实下载验收，不阻塞其他实现。
- 云端CAS/幂等保存不重复生成/计费，不覆盖较新本机数据；错误、冲突、下架和缺失版本明确反馈。

## Clean-room workshop contract (public observation 2026-10-09)

- Origin: https://chatarchivemods.org/，只读公开目录/详情；不联系作者、不操作投稿/举报/管理。
- 页面：首页、/characters/、/presets/、/mods/{resourceId}/、/login/。
- API: GET /api/resources/?category=characters&page=1&q=，GET /api/resources/{id}/；JSON外层ok/data，分页items/total/page/pages。
- 公开file包含revision_id/name/size/extension/sha256。受控下载地址/download/{revisionId}/；未登录展示“登录后下载”，不得猜测直链绕过登录。
- 当前第一页公开目录有ZIP/7Z/RAR，站点声明素材也支持CAPK，上限50,000,000字节。只提取接口/行为，不复制第三方页面实现。
- 更完整角色格式、加密/许可边界、原包到Homer稳定映射等待用户合法下载样本实证；不擅自剥离保护。

## Authenticated sample (2026-10-09)

- 用户自己的已登录工坊会话，正常详情页“下载文件”获得ZIP；未填写新账号条款、未绕过登录。
- Resource `608761ee-d235-437d-90f7-aa22d97786d8`, revision `d7c8d252-8f12-433c-acb2-f8d02daa6963`，13,494,935 bytes，SHA256 `3092b83304b64e7367274adb5379598e1b21f61daf93599d06ab1f97819033f2`。
- 外层ZIP只有一个CAPK。CAPK明文数据容器：ASCII `KPAC`、little-endian uint32 version=1、.NET七位长度UTF8名称、uint32 entryCount；每条为七位长度UTF8路径、uint32 length、数据。manifest schema_version=1。
- manifest role提供稳定role_uid/name/private_setting/organization/signature；spines列出骨骼、atlas、贴图、头像、animation_names、emotion_names及装束/情绪映射。只解析数据与受支持媒体，不执行包内代码。
