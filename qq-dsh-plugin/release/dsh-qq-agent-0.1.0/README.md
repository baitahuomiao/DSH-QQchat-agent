# dsh-qq-agent

DSH 插件：让你的电脑端 QQ 变成一个会自己聊天的角色。

接入本机的 NapCat / OneBot 11，用 DSH 自己的大模型服务思考，能联网、能看图、能发语音、会主动找人说话，还会去 B 站刷视频并把看过的内容记下来。

## 它做什么

- **自动回复**：授权过的群和私聊里，按人设回应；群里可以设成「@ 我才回」「命中关键词才回」或「每条都回」。
- **人设**：一段人格提示词 + 名字，拼进每次对话的系统提示。内置 6 个预设（鲸鱼娘 / 猫娘 / 管家 / 傲娇学妹 / 技术大佬 / 普通朋友），也可以完全自己写。
- **主人**：指定一个 QQ 号为「主人」。主人权重最高——主动搭话时优先找主人，且拥有全部管理指令权限。
- **识图**：有人发图片时会先看图再回，图片走 DSH 的附件服务存成 ImageBlock 交给多模态路由。如果聊天用的模型看不了图，会自动跨到别的 provider 找一条支持视觉的路由（面板「能力 → 看图」里能看到实际走的是哪条）。
- **联网**：需要查资料时自己去搜（优先 DSH 的 `ctx.web.search`，不可用时回落到自抓 Bing RSS，无需 API key）。
- **主动发言**：不需要有人先说话，她会自己来搭话。间隔、每小时上限、免打扰时段都可调；对主人和对别人的权重分开设置。
- **B 站**：去热门里翻视频看，写下一句内容描述暂存起来（默认 2 小时过期），之后聊天时可以聊到。**默认需要主人批准才能刷**。
- **语音回复**：把回复转成 MP3 语音发出去。合成走百度翻译的免费 TTS 接口，不依赖本地语音引擎，也不限长度。支持按设定词替换读音（例如把「B站」读成「哔哩哔哩」）。
- **思考走 DSH**：模型调用用的是 `ctx.llm.stream`，不需要自己配置 API key，也不需要额外的模型账号。

## 前置条件

1. **DSH 桌面版**（0.1.7-rc 以上）。
2. **能用的模型路由**：DSH 里已经配好至少一个 provider + model。
3. **NapCat / LLOneBot**：电脑端 QQ 已经注入 OneBot，且开着 WebSocket 端口（默认 `ws://127.0.0.1:3001`）。

## 安装

**发给别人用**：解压后双击 `安装.cmd`，然后重启 DeepSeek Harness。装完左栏会出现 QQ 图标。
详见 [安装说明.md](安装说明.md)。

**手工装 / 命令行装**：插件目录放到 `~/.dsh/plugins/dsh-qq-agent`（Windows 上是
`%USERPROFILE%\.dsh\plugins\dsh-qq-agent`），然后在 profile 的 `package.json` 里登记：

```json
{
  "dependencies": {
    "dsh-qq-agent": "file:C:/Users/你/.dsh/plugins/dsh-qq-agent"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...其它插件...",
        "dsh-qq-agent"
      ]
    }
  }
}
```

改完在 profile 目录（`~/.dsh/profiles/desktop`）跑一次 `pnpm install`，然后**重启 DSH**
（宿主入口的改动必须重启，客户端的改动刷新页面即可）。

两件事都可以让脚本代劳：

```bash
node tools/install.mjs              # 装（自动找 DSH 与 profile）
node tools/install.mjs --dry-run    # 只看会做什么
node tools/install.mjs --uninstall  # 卸载
```

已经装过一次、只想更新到新版本：

```bash
node tools/sync.mjs   # 构建 + 同步到 profile，然后重启 DSH
```

（`tools/sync.mjs` 会替你处理 pnpm 不重抄 `file:` 依赖、以及硬链接不跟进新增文件这两个坑。
它是给自己这台机器用的；打给别人用见下面「打包」。）

## 打包给别人

```bash
node tools/pack.mjs        # 生成 release/dsh-qq-agent-<version>/ 与同名 .zip
node tools/pack.mjs --no-zip
```

产物只含运行时必需的文件（不含 `test/`、`build/`、`data/`），入口固定 `lib/index.js`，
并会在结束时扫描一遍本机路径、密钥与真实 QQ 号，发现残留就中止。

打完包建议再验一遍「别人那边能不能用」——把 zip 解到一个空目录，
指一个临时的 `DSH_HOME` 装一遍，然后用假宿主加载：

```bash
# 解压后进目录，装到一个临时 DSH_HOME（不会碰你真实的 ~/.dsh）
set DSH_HOME=%TEMP%\qqhome && 安装.cmd

# 用假宿主把装出来的那份跑起来：注册路由、响应 /state、清理
node tools/smoke-installed.mjs %TEMP%\qqhome
```

`smoke-installed.mjs` 会断言解析出的入口**不在开发目录里**，
所以它能证明发布包独立可用，而不是又跑了一遍本机源码。

## 配置

打开左侧栏的 **QQ** 图标进入面板，八个标签页：

| 标签 | 内容 |
| --- | --- |
| 总览 | 连接状态、回复/主动发言计数、下一次主动发言倒计时、待批准的 B 站请求 |
| 主人与人设 | 主人 QQ 号与称呼、人格提示词、内置预设一键切换 |
| 连接 | OneBot 的 WS/HTTP 地址、令牌、重连间隔；拉取群列表与好友列表，点一下加进白名单 |
| 回复 | 群聊触发方式与授权群、私聊白名单、单条字数、打字速度、停顿区间、记忆轮数、冷却、回复概率、主动发言全套参数、管理员权限 |
| 能力 | 联网搜索时机、图片识别（含单独的识图路由）、语音（概率/关键词/语速/读音替换/试听）、模型路由 |
| B 站 | 批准与撤销、每次刷几条、暂存时长、是否用模型写观后感、手动刷一次、视频书架 |
| 记忆 | 每个会话的上下文条数与最后活跃时间，可单独清空 |
| 日志 | 最近 60 条运行日志，按级别过滤 |

配置落在 **`~/.dsh/qq-agent/config.json`**，视频书架落同目录的 `videos.json`。

> 数据不放在插件包内：装进 `node_modules` 之后 `pnpm update` 会重建包目录，放在里面的配置会丢。
> 需要换位置就设环境变量 `DSH_QQ_AGENT_DATA`（或 `DSH_HOME`）。

## QQ 里的管理指令

只有主人和 `admin.uins` 里的人能下指令。指令以 `.` 开头，中英文别名都行：

| 指令 | 作用 |
| --- | --- |
| `.help` / `.帮助` | 列出所有指令 |
| `.status` / `.状态` | 看一眼运行状态 |
| `.pause` / `.暂停` | 暂停自动回复 |
| `.resume` / `.恢复` | 恢复自动回复 |
| `.persona <文本>` / `.人设` | 临时改人设 |
| `.say <文本>` / `.说` | 让它原样说一句 |
| `.voice on\|off` / `.语音` | 开关语音 |
| `.search auto\|always\|off` / `.联网` | 切联网模式 |
| `.bili` / `.b站` | 请求刷一轮 B 站（非主人只记录请求，等主人批准） |
| `.videos` / `.视频` | 看当前暂存了哪些视频 |
| `.memory` / `.记忆` | 看记忆状态 |
| `.reset` / `.清空` | 清空会话记忆 |
| `.reload` / `.重载` | 重载配置 |

## 数据与隐私

- 所有配置、视频书架都只存在本机插件目录下。
- 对话内容会作为上下文发给 DSH 当前选用的模型路由，和你在 DSH 里正常聊天没有区别。
- 语音合成会把待朗读的文本 POST 给 `fanyi.baidu.com` 的公开 TTS 接口。介意的话把语音关掉。

## 开发

```bash
cd ~/.dsh/plugins/dsh-qq-agent    # Windows: %USERPROFILE%\.dsh\plugins\dsh-qq-agent
node tools/sync.mjs        # 构建 + 同步到 profile（改完源码就这一条）
node test/all.mjs          # 全部离线测试
node test/all.mjs --live   # 再加连真 NapCat 的实测
```

`tools/sync.mjs` 干三件事：build 客户端、把源码复制到 `~/.dsh/plugins/dsh-qq-agent`、
删掉 `node_modules` 里的包目录再 `pnpm update`（pnpm 对 `file:` 依赖只按版本号判断是否重抄，
小改它会一律回 `Already up to date`；而且它抄过去的 `lib/*.js` 是硬链接，新增文件根本不会跟过来）。

### 改完为什么不生效：宿主代码只能靠重启

**客户端（`src/ui.js` → `lib/client.js`）改完，build 一下刷新页面就行。**

**宿主代码（`lib/index.js`、`src/*.cjs`）改完必须重启 DSH。** 热挂载救不了 ——
`/dsh-market/toggle` 那条通道有两道按 URL 固定的缓存，都在宿主进程内且没有失效手段：

1. dshmarket 的 `hotMount` 用 `createRequire(profileDir/package.json).resolve(包名)` 取入口
   （`node_modules/dshmarket/lib/hot.js:64`），结果落在 Node 的 `Module._pathCache` 里。
   进程内第一次解析出 `lib/index.js` 之后，就算 `package.json` 的 `main` 换成
   `lib/index.<hash>.js`，这里照样返回旧路径。
2. 就算 URL 变对了，Node 的 ESM 缓存也按 URL 存，且无法失效。

所以「卸载再重挂」只是重建插件实例，跑的还是第一次 import 的那份模块。
这两条都实测过（loader 壳、带内容哈希的入口文件名，两种绕法都无效），
`lib/index.<hash>.js` 的命名保留下来只是为了**跨重启**时换进程读到新代码，不是为了热挂载。

判断「装进去的到底是不是新代码」，用新进程直接导入安装位置：

```bash
node test/installed.check.mjs   # 绕过宿主缓存，验证安装产物内容
```

会连真 NapCat 或真网络的测试（都不烧 token，也不会发消息给陌生人）：

```bash
node test/host.smoke.mjs       # 假 ctx 跑 apply()，验证路由注册与生命周期
node test/client.smoke.mjs     # 假浏览器跑 lib/client.js，验证插槽注册
node test/e2e.live.mjs         # 连 ws://127.0.0.1:3001，桩模型跑完整回复链路（加 --send 才真发）
node test/proactive.live.mjs   # 主动发言排期 / 主人权重 / 语音回复
node test/abilities.live.mjs   # B 站接口 + 视频书架过期 + 语音合成（加 --send 才真发语音）
```

这些测试都会把数据目录指到临时目录，不碰你真实的 `~/.dsh/qq-agent`。

### 文件结构

```
lib/index.js          宿主入口：注册 HTTP 路由、把 DSH 服务包成普通函数、管 Engine 生命周期
lib/index.<hash>.js   同一文件的带哈希副本（sync.mjs 生成，仅供本机绕过宿主模块缓存）
lib/client.js         构建产物（由 src/ui.js 生成，不要手改）
安装.cmd / 卸载.cmd   双击入口（自动找 node，转调 tools/install.mjs）
安装说明.md           给最终用户看的图文步骤与排错
tools/install.mjs     安装/卸载：找 DSH、复制包、改 profile、跑 pnpm、校验
tools/smoke-installed.mjs 用假宿主把「已安装的那份」跑一遍，证明它能独立加载
tools/sync.mjs        本机开发用：构建 + 同步到 profile
tools/pack.mjs        打发布包（release/ 下的目录与 zip）
tools/restart-dsh.ps1 本机重启 DSH 用（不是给别人用的）
src/config.cjs        默认配置 + 归一化 + 原子读写
src/core.cjs          纯逻辑：该不该回、怎么切段、提示词怎么拼、主动发言怎么排期
src/engine.cjs        把 OneBot / 记忆 / 模型 / 联网 / B站 / 语音串起来
src/onebot.cjs        OneBot 11 客户端（全局 WebSocket，无第三方依赖）
src/memory.cjs        会话记忆 + 视频书架
src/bilibili.cjs      B 站公开接口
src/tts.cjs           语音合成
src/search.cjs        联网兜底（Bing RSS）
src/net.cjs           能扛住本机 MITM 代理的 fetch
src/presets.cjs       内置人格
src/ui.js             客户端面板（React.createElement，无 JSX）
build/build.mjs       把 src/ui.js 拼成 lib/client.js
test/all.mjs          一把跑完
test/core.test.cjs    单测
test/contract.check.mjs 面板与宿主的字段/动作/路由对齐自检
test/llm.bridge.mjs   简单参数 → GenerateOptions 的翻译，含跨 provider 识图
test/host.smoke.mjs   宿主入口冒烟
test/client.smoke.mjs 客户端冒烟
test/installed.check.mjs 安装产物是不是新的（绕过宿主缓存）
test/route.check.mjs  自签 cookie 探路由
test/hot.mjs          热挂载（只对「已装但未加载」有用，改不了宿主代码）
test/e2e.live.mjs     端到端（真 NapCat + 桩模型）
test/vision.live.mjs  识图链路（真调模型读一张图）
test/proactive.live.mjs 主动发言与语音
test/abilities.live.mjs B 站与语音合成
```

## 已知限制

- 只支持 OneBot 11 的 WebSocket 正向连接，不支持反向 WS。
- 语音发送依赖 NapCat 对 MP3 的兼容；实测 NapCat 4.18 直接接受 MP3 作为 `record`。
- 本机若有 TLS 中间人代理，`src/net.cjs` 会自动用 `rejectUnauthorized:false` 重试出网请求。
- 主动发言的间隔是概率排期，不是精确定时。
- 宿主代码的改动必须重启 DSH 才生效，热挂载读不到新模块（原因见上面「改完为什么不生效」）。
- 推理模型（如 `deepseek-flash`）的思考也算在 Max Tokens 里。预算给太小会只剩一段空白回复 ——
  桥接层遇到「思考有内容、正文为空、finish 是 max-tokens」时会把预算翻倍重试一次，
  但默认值仍建议留在 1600 以上。
