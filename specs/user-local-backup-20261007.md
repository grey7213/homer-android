# 用户本地备份

范围：主 Web 工作区提供个人数据 ZIP 下载/预览/私有副本导入；Android 增加仅由当前本站 `/app/backup.html` 页面调用的 `HomerNative.downloadUserBackup()`，使用 DownloadManager 保存到 Downloads，复用当前 Cookie。URL 固定为本站备份接口，不接受任意下载地址。文件导入复用既有 onShowFileChooser。

保留原包名、签名、Cookie、用户本地缓存与会话数据库，版本递增为 1.18.1 (354)。新网页入口随 APK 同步，不重复应用 R353 累计补丁。

验收：编译/单测/lint、资源检查；模拟器实际下载 ZIP，验证成员/JSON，选择同一文件预览并导入；353→354 覆盖升级保留登录。Web/backend 范围和测试见主工作区 `specs/user-backup-20261007/`。尚未完成验收前不能标记发布。

本地已验证：7 项 strict patches、2161 个 Web 文件与主工作区一致；Node 1698 通过、0 失败，Gradle 单测/lint/debug/release 通过，1758 项资源清单/524 个前端文件完整。Pixel 6 API 33 从当前备份页通过 DownloadManager 保存 4418 字节 ZIP，真实系统文件选择器选择同一文件并成功预览/恢复；原始包有 backup.json 和 README.txt，格式为 homer-user-backup。生产部署、覆盖升级、正式发布另行记录。
