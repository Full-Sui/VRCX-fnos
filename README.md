# VRCX fnOS CI 仓库

这是给 GitHub Actions 用的精简构建仓库，只包含构建 FPK 所需的源码和脚本。

## 一次性准备

1. 在 GitHub 新建一个空仓库（例如 `yourname/vrcx-fnos`）。
2. 把本目录（`ci-repo/`）里的全部内容推到该仓库的 `main` 分支。
3. 仓库的 **Settings → Actions → General → Workflow permissions** 选择
   **Read and write permissions**，否则 Release 无法上传。

## 构建 FPK

进入仓库的 **Actions → Build VRCX fnOS FPK → Run workflow**，填写版本号（例如 `1.0.16`），
运行完成后会自动：

- 构建 VRCX Vue 前端
- 发布 .NET 10 自包含后端
- 组装 `app.tgz`
- 生成 `vrcx_<version>_x86.fpk`
- 创建 `v<version>` Release 并上传 FPK

## 管理器一键更新

在 VRCX 管理器的「检查更新」里填写：

```text
你的GitHub用户名/vrcx-fnos
```

保存后点「检查更新」；如果 Release 版本高于当前安装版本，会出现「一键更新」按钮。
管理器会下载对应 FPK，校验 sha256 后调用 `appcenter-cli` 完成升级。

## 版本约定

- Release tag 必须是 `v<version>`，例如 `v1.0.16`
- FPK 文件名必须是 `vrcx_<version>_x86.fpk`
- Release 中必须包含该 FPK 资产

## 本地构建（可选）

```bash
npm ci --ignore-scripts --prefix vrcx-src
(cd vrcx-src && npx vite build src)
(cd vrcx-src/WebHost && dotnet publish -c Release -r linux-x64 --self-contained true -p:Platform=x64 -o ../../app/bin)
npm ci --ignore-scripts --prefix app/server
rm -rf app/webui && cp -a vrcx-src/build/html app/webui
rm -rf app/ui && cp -a fpk/ui app/ui
bash build-fpk.sh 1.0.16
```
