# 用户本地备份

范围：主 Web 工作区提供个人数据 ZIP 下载/预览/私有副本导入；Android 增加仅由当前本站 `/app/backup.html` 页面调用的 `HomerNative.downloadUserBackup()`，使用 DownloadManager 保存到 Downloads，复用当前 Cookie。URL 固定为本站备份接口，不接受任意下载地址。文件导入复用既有 onShowFileChooser。

保留原包名、签名、Cookie、用户本地缓存与会话数据库，版本递增为 1.18.1 (354)。新网页入口随 APK 同步，不重复应用 R353 累计补丁。

验收：编译/单测/lint、资源检查；模拟器实际下载 ZIP，验证成员/JSON，选择同一文件预览并导入；353→354 覆盖升级保留登录。Web/backend 范围和测试见主工作区 `specs/user-backup-20261007/`。尚未完成验收前不能标记发布。

本地已验证：7 项 strict patches、2161 个 Web 文件与主工作区一致；Node 1698 通过、0 失败，Gradle 单测/lint/debug/release 通过，1758 项资源清单/524 个前端文件完整。Pixel 6 API 33 从当前备份页通过 DownloadManager 保存 4418 字节 ZIP，真实系统文件选择器选择同一文件并成功预览/恢复；原始包有 backup.json 和 README.txt，格式为 homer-user-backup。生产部署、覆盖升级、正式发布另行记录。

正式交付：PR #20 的 pull_request build 和 main build 均通过，`465e2a9` 已合并，生产接口和页面已部署。正式 353→354 覆盖安装保留 firstInstallTime `2026-09-22 11:04:46` 与原登录；设置中的备份入口可见，无 FATAL EXCEPTION。官网两个 URL 均完整下载校验，与 GitHub asset digest 和本地签名包相同：63,856,687 bytes，SHA-256 `bd0bf3c2f07f7ff18892e38206c63603fe22f4605c378ea56aabe1b8b097ce44`；release.json=354/no-cache。

下载：`https://patcher.villainy.top/download/homer-android-1.18.1-354-release.apk`；Release：`https://github.com/grey7213/homer-android-apk/releases/tag/release-1.18.1-354`。生产临时测试数据已清理，backend/dialogue/Nginx active，数据库 quick_check=ok。图片/音频/Spine 独立文件当前保留引用；备份界面明确说明实际覆盖范围。
