# 同步脚本使用说明（用户身份方案）

数据从飞书多维表格同步到 `index.html`，由 GitHub Actions 每天 09:05 / 14:05 / 20:05（北京时间）自动跑。

**鉴权方式**：用户身份（user_access_token），不需要把应用加为表格协作者。

## ⚠️ 关键约束

飞书的 `refresh_token` 有效期 **30 天**，且**每次使用后会换发新的**。机制要求：

1. 必须**至少每 30 天**成功跑一次同步，否则 refresh_token 过期、整个链条断掉，需要重新走 OAuth。
2. 每次跑完，脚本会把飞书发的新 refresh_token 通过 GitHub API **自动覆盖回 `FEISHU_REFRESH_TOKEN` Secret**——这就是为什么需要一个 PAT。
3. 如果连续多次失败（飞书 API 抽风、PAT 过期、网络问题等），30 天窗口关掉就要重新 bootstrap。

## 一次性配置

### 1. 飞书自建应用

1. [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用 → 拿到 `App ID` / `App Secret`。
2. 「权限管理」开通：
   - `base:app:read`、`base:table:read`、`base:record:retrieve`（多维表格读权限）
   - `wiki:node:read`（你的链接是 `/wiki/` 开头，必要）
3. 「安全设置」→「重定向 URL」→ 添加 `http://localhost:8765/callback`。
4. 「版本管理与发布」发布应用，等管理员审批通过。

### 2. 准备 GitHub PAT（用来轮转 Secret）

仓库 → Settings → Secrets and variables → Actions，加一个 PAT：

1. 头像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token。
2. Resource owner = `wlgan-workspace`；Repository access = Only `concert-dashboard`。
3. Repository permissions → **Secrets: Read and write**（其他不开）。
4. 有效期建议 1 年；快过期前 GitHub 会提醒。
5. 把生成的 token 加为仓库 Secret `GH_PAT`。

### 3. 本地拿到种子 refresh_token

```bash
cd ~/concert-dashboard
npm install
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npm run bootstrap
```

它会自动开浏览器跳到飞书授权页面，授权后回调到本地，控制台打印出 `refresh_token`。

### 4. 写入 GitHub Secrets

仓库 Settings → Secrets and variables → Actions → New repository secret，逐个添加：

| Secret name | 值 |
|---|---|
| `FEISHU_APP_ID` | `cli_xxx` |
| `FEISHU_APP_SECRET` | (从飞书应用获取) |
| `FEISHU_REFRESH_TOKEN` | 上一步 bootstrap 打印的那串 |
| `FEISHU_APP_TOKEN` | `JV5twvpBniUIwIk9Jj0cbeM0njc` |
| `FEISHU_TABLE_ID` | `tbl1DG9onb9LFJKU` |
| `FEISHU_VIEW_ID` | `vewsAKaDCP` |
| `FEISHU_WIKI_NODE` | `1` |
| `GH_PAT` | 上面创建的 fine-grained PAT |

### 5. 校准字段映射

`scripts/field-map.json` 是猜的常规中文列名，实际列名很可能不一样。本地跑 discover 模式确认：

```bash
FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=xxx \
FEISHU_REFRESH_TOKEN=（从 .feishu-refresh-token 文件读，或刚才 bootstrap 的） \
FEISHU_APP_TOKEN=JV5twvpBniUIwIk9Jj0cbeM0njc \
FEISHU_TABLE_ID=tbl1DG9onb9LFJKU \
FEISHU_WIKI_NODE=1 \
npm run discover
```

注意：每次跑（包括 discover）都会消耗一次 refresh_token，新的会被写到 `.feishu-refresh-token`。**下次跑要用这个文件里的新值**，旧的就废了。

把输出的字段列表对照 `scripts/field-map.json` 改 `from` 字段。

### 6. 本地试跑一次完整同步

```bash
FEISHU_REFRESH_TOKEN=$(cat .feishu-refresh-token) \
FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=xxx \
FEISHU_APP_TOKEN=JV5twvpBniUIwIk9Jj0cbeM0njc \
FEISHU_TABLE_ID=tbl1DG9onb9LFJKU \
FEISHU_VIEW_ID=vewsAKaDCP \
FEISHU_WIKI_NODE=1 \
npm run sync
```

浏览器打开 `index.html` 看效果。OK 后：
- 把 `.feishu-refresh-token` 里**最新的值**更新到 GitHub Secret `FEISHU_REFRESH_TOKEN`（覆盖第 4 步设的初始值）。
- `git add -A && git commit && git push`。

### 7. 手动触发一次 GitHub Actions

仓库 → Actions → `sync-feishu` → Run workflow。看日志确认：
- `Fetched N records, M fields.`
- `Rotated FEISHU_REFRESH_TOKEN in GitHub Secrets.`

如果第二行没出现，说明 PAT 配错了——这非常重要，Secret 没轮转下次就用旧 token 跑，30 天必废。

## 日常运维

- 表里加新字段 → 改 `field-map.json` → push。
- **30 天检查一次**：去 Actions 看最近的运行有没有报错。
- 停同步 → Actions → `sync-feishu` → Disable workflow。
- 失败常见原因：
  - **`code=20029` / `invalid refresh_token`**：refresh_token 过期或被覆盖丢了——重新 bootstrap，更新 `FEISHU_REFRESH_TOKEN`。
  - **`GitHub secret PUT failed: 403`**：PAT 过期或权限不足——重新生成。
  - **字段缺失**：表里改了列名——跑 `npm run discover` 重新对一遍。

## 文件结构

```
scripts/
  sync.mjs            主同步脚本
  bootstrap-auth.mjs  首次 OAuth 授权（一次性）
  field-map.json      飞书中文列名 → 前端 JSON key 映射
.github/workflows/
  sync.yml            cron 触发的 GitHub Actions
.feishu-refresh-token （gitignored）本地跑时滚动写入的最新 refresh_token
```
