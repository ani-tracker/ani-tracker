# GitHub Release 发布令牌配置

Android、iOS 与桌面发布工作流统一从 GitHub Actions Secret `RELEASE_TOKEN` 读取发布令牌。令牌只需配置一次，不需要在每次构建时传入。

## 方案一：Fine-grained PAT（推荐）

1. 打开 [Fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new)。
2. 设置令牌名称和有效期。
3. `Resource owner` 选择 `ani-tracker` 仓库所属的账号或组织。
4. `Repository access` 选择 `Only select repositories`，只添加 `ani-tracker`。
5. 在 `Repository permissions` 中将 `Contents` 设置为 `Read and write`。
6. 生成令牌并立即复制。令牌离开页面后不会再次完整显示。

如果仓库属于要求审批的组织，需要等待组织管理员批准令牌后再使用。

## 方案二：Tokens (classic)

Classic PAT 也可以用于当前工作流。创建页面的权限按仓库可见性选择：

- 公开仓库：只勾选 `public_repo`。
- 私有仓库：勾选顶层 `repo`，不必再单独选择其子项。

创建 Release 不需要 `workflow`、`security_events`、`write:packages` 或组织管理权限。应取消与发布无关的权限。

## 保存到仓库 Secret

1. 打开仓库的 `Settings`。
2. 进入 `Secrets and variables` -> `Actions`。
3. 在 `Repository secrets` 中选择 `New repository secret`。
4. `Name` 填写 `RELEASE_TOKEN`。
5. `Secret` 粘贴刚生成的令牌并保存，不要添加引号或前后空格。

不要把令牌写入工作流文件、构建参数、Issue 或日志。令牌泄露后应立即撤销并重新生成。

## 验证发布

代码推送到 GitHub 后，进入 `Actions`，选择对应的 Tauri Release 工作流并通过 `Run workflow` 发起新构建。不要直接重跑修改前的失败任务，因为旧任务仍可能使用失败提交中的工作流定义。

发布成功后应满足：

- `Validate GitHub release token` 步骤通过。
- Release Action 不再出现 Node 20 弃用警告。
- `v0.1.3` 标签与对应 GitHub Release 创建成功。

如果仍然出现 `403 Resource not accessible by integration`，依次检查令牌是否过期、资源所有者和仓库是否选对、`Contents` 是否为读写权限，以及组织是否尚未批准令牌。
