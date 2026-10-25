安装方式：将文件下载后放入DSH文件，打开，文件内有安装程序“安装程序.cmd”
sh-qq-agent
DSH 插件：让你的电脑端 QQ 变成一个会自己聊天的角色。
接入本机的 NapCat / OneBot 11，用 DSH 自己的大模型服务思考，能联网、能看图、能发语音、会主动找人说话，还会去 B 站刷视频并把看过的内容记下来。
它做什么
- 自动回复：授权过的群和私聊里，按人设回应；群里可以设成「@ 我才回」「命中关键词才回」或「每条都回」。
- 人设：一段人格提示词 + 名字，拼进每次对话的系统提示。内置 6 个预设（鲸鱼娘 / 猫娘 / 管家 / 傲娇学妹 / 技术大佬 / 普通朋友），也可以完全自己写。
- 主人：指定一个 QQ 号为「主人」。主人权重最高——主动搭话时优先找主人，且拥有全部管理指令权限。
- 识图：有人发图片时会先看图再回，图片走 DSH 的附件服务存成 ImageBlock 交给多模态路由。如果聊天用的模型看不了图，会自动跨到别的 provider 找一条支持视觉的路由（面板「能力 → 看图」里能看到实际走的是哪条）。
- 联网：需要查资料时自己去搜（优先 DSH 的 ctx.web.search，不可用时回落到自抓 Bing RSS，无需 API key）。
- 主动发言：不需要有人先说话，她会自己来搭话。间隔、每小时上限、免打扰时段都可调；对主人和对别人的权重分开设置。
- B 站：去热门里翻视频看，写下一句内容描述暂存起来（默认 2 小时过期），之后聊天时可以聊到。默认需要主人批准才能刷。
- 语音回复：把回复转成 MP3 语音发出去。合成走百度翻译的免费 TTS 接口，不依赖本地语音引擎，也不限长度。支持按设定词替换读音（例如把「B站」读成「哔哩哔哩」）。
- 思考走 DSH：模型调用用的是 ctx.llm.stream，不需要自己配置 API key，也不需要额外的模型账号。
前置条件
1. DSH 桌面版（0.1.7-rc 以上）。
2. 能用的模型路由：DSH 里已经配好至少一个 provider + model。
3. NapCat / LLOneBot：电脑端 QQ 已经注入 OneBot，且开着 WebSocket 端口（默认 ws://127.0.0.1:3001）。
安装
发给别人用：解压后双击 安装.cmd，然后重启 DeepSeek Harness。装完左栏会出现 QQ 图标。
详见 安装说明.md。
手工装 / 命令行装：插件目录放到 ~/.dsh/plugins/dsh-qq-agent（Windows 上是
%USERPROFILE%\.dsh\plugins\dsh-qq-agent），然后在 profile 的 package.json 里登记：
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
改完在 profile 目录（~/.dsh/profiles/desktop）跑一次 pnpm install，然后重启 DSH
（宿主入口的改动必须重启，客户端的改动刷新页面即可）。
两件事都可以让脚本代劳：
node tools/install.mjs              # 装（自动找 DSH 与 profile）
node tools/install.mjs --dry-run    # 只看会做什么
node tools/install.mjs --uninstall  # 卸载
已经装过一次、只想更新到新版本：
node tools/sync.mjs   # 构建 + 同步到 profile，然后重启 DSH
（tools/sync.mjs 会替你处理 pnpm 不重抄 file: 依赖、以及硬链接不跟进新增文件这两个坑。
它是给自己这台机器用的；打给别人用见下面「打包」。）
打包给别人
node tools/pack.mjs        # 生成 release/dsh-qq-agent-<version>/ 与同名 .zip
node tools/pack.mjs --no-zip
产物只含运行时必需的文件（不含 test/、build/、data/），入口固定 lib/index.js，
并会在结束时扫描一遍本机路径、密钥与真实 QQ 号，发现残留就中止。
打完包建议再验一遍「别人那边能不能用」——把 zip 解到一个空目录，
指一个临时的 DSH_HOME 装一遍，然后用假宿主加载：
# 解压后进目录，装到一个临时 DSH_HOME（不会碰你真实的 ~/.dsh）
set DSH_HOME=%TEMP%\qqhome && 安装.cmd

# 用假宿主把装出来的那份跑起来：注册路由、响应 /state、清理
node tools/smoke-installed.mjs %TEMP%\qqhome
smoke-installed.mjs 会断言解析出的入口不在开发目录里，
所以它能证明发布包独立可用，而不是又跑了一遍本机源码。
配置
打开左侧栏的 QQ 图标进入面板，八个标签页：
标签
内容
总览
连接状态、回复/主动发言计数、下一次主动发言倒计时、待批准的 B 站请求
主人与人设
主人 QQ 号、称呼与暧昧称呼、只认唯一主人开关（称呼只给主人）、人格提示词、内置预设、我的人格库（自定义人格的保存/切换/删除）
连接
OneBot 的 WS/HTTP 地址、令牌、重连间隔；拉取群列表与好友列表，点一下加进白名单
回复
群聊触发方式与授权群、私聊白名单、单条字数、打字速度、停顿区间、记忆轮数、冷却、回复概率、自由聊天模式、主动发言全套参数、管理员权限
能力
联网搜索时机、图片识别（含单独的识图路由）、语音（概率/关键词/语速/读音替换/试听）、自定义语音模型 API、表情包（自动收藏 + 手动导入 + 删除）、生成图片、模型路由
B 站
批准与撤销、刷哪里（热门/周榜/主页/混合）、每次刷几条、暂存时长、是否用模型写观后感、手动刷一次、视频书架
记忆
每个会话的上下文条数与最后活跃时间，可单独清空
日志
最近 60 条运行日志，按级别过滤
配置落在 ~/.dsh/qq-agent/config.json，视频书架落同目录的 videos.json，表情包落同目录的 stickers/。
数据不放在插件包内：装进 node_modules 之后 pnpm update 会重建包目录，放在里面的配置会丢。
需要换位置就设环境变量 DSH_QQ_AGENT_DATA（或 DSH_HOME）。
自由聊天模式
打开 reply.freeChat.enabled 之后，回复不再被「切成几条、每条多少字」硬约束：
- 段数由内容决定：想回一个字就一个字，想连发四条就四条，只受 maxSegments（默认 4）兜底。
超过上限时是合并相邻短句而不是截断，不会丢内容。
- 停顿更像真人：段间延迟在 minGapMs~maxGapMs 之间抖动；首句有 thinkingChance 概率先「想一下」再发。
- 可以用表情包：模型单独输出一行 [表情]，或在句尾加 [表情]，就会插一张收藏的表情。
- 可以自己画图：模型单独输出一行 [画:画面描述]，会调用生图 API 发出去（需要 reply.freeChat.allowImages 且配好生图）。
表情包
- 别人在聊天里发的图，按 sticker.autoSaveChance（默认 0.25）的概率自动收进仓库，每天最多存 autoSaveDailyLimit 张（默认 12）。超过 2MB 的图（多半是照片）不收。
- 面板里可以手动导入本地图片、打标签、删除。
- 发的时候优先按标签匹配，没有命中就随机挑，并偏向很久没发过的，不会翻来覆去总是同一张。
- 同一张图（sha1 相同）不会重复入库；仓库上限 400 张，满了丢最久未使用的。
自定义语音模型 API
留空 voice.custom.baseUrl 就用内置的百度匿名接口（不配也能响）。填了就走你自己的模型：
- apiKind = "openai"：POST {baseUrl}/audio/speech，body {model, input, voice, speed, response_format}。
OpenAI、硅基流动以及各类兼容网关都是这个形状。
- apiKind = "dashscope"：阿里百炼原生协议，见下面单独一节。
- apiKind = "custom"：POST {baseUrl}，body 由 bodyTemplate 决定，用 {text} {voice} {speed} 占位。
语速换算：面板上的 1–15 会映射成 OpenAI 口径的 0.25–4.0。
阿里百炼（DashScope）
百炼的语音接口不是 OpenAI 兼容的——compatible-mode/v1 只覆盖 chat 和 embeddings，
不含音频。所以填 apiKind = "dashscope"，插件会走它自己的协议。
baseUrl 填到根域就行，填深了会自动剥回：
地域
baseUrl
华北2（北京）
https://dashscope.aliyuncs.com
业务空间专属（推荐生产）
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com
业务空间专属域名的并发更高、请求超时 3600 秒（DashScope 域名是 600 秒）。
Workspace ID 在业务空间管理的 API Host 列拿。
适配的三条路：
- 合成 POST /api/v1/services/audio/tts/SpeechSynthesizer
body {model, input:{text, voice, language_type, format, sample_rate}}；
返回 JSON，音频在 output.audio.url（OSS 链接，24 小时有效）或 output.audio.data（base64）。
插件会自己下载或解码，拿到字节再发出去。
- 声音复刻 POST /api/v1/services/audio/tts/customization，model 固定 voice-enrollment，
input.action 区分 create_voice / list_voice / query_voice / update_voice / delete_voice。
参考音频用 base64 data URI 直接传，不需要公网 URL。
- 音色名不加前缀：Cherry 就是 Cherry。克隆出来的 voice_id（形如 {target_model}-{prefix}-{标识}）直接当 voice 用。
合成端点的坑（重要）
百炼有两条合成路径，用错会报 url error, please check url！（HTTP 400）：
端点
系统音色
复刻音色
…/services/aigc/multimodal-generation/generation
可以
报 url error
…/services/audio/tts/SpeechSynthesizer
可以
可以
所以插件默认统一走 SpeechSynthesizer，两边都能用。
只有确实想用 multimodal 时才在配置里加 "useMultimodal": true。
format 默认 mp3、sample_rate 默认 24000——和 OneBot 的 record 段匹配。
三个坑：
- 音色绑定模型。复刻时的 target_model 必须和后面合成用的 model 完全一致，不一致直接报错。
- prefix 只能是字母数字、≤10 字符。插件会自动清洗，中文会被过滤掉。
- 要实名认证，否则复刻返回 2038 无复刻权限。
参考音频要求：10~20 秒最佳，最长 60 秒，mp3 / wav / m4a 都行。
超过 60 秒会被拒，需要自己先裁。
language_type 建议和文本语种一致（Chinese / Japanese / English…），
指定语种比 Auto 的合成质量好。面板上的语种设置会自动映射过去。
复刻时如果参考音频是外语，language_hints 填对应语种（如日语填 ["ja"]）音色提取更准；
但合成说哪国话由 language_type 决定，两者互不影响——可以用日语样本合成中文。
语音转写仍然走硅基流动：百炼不提供 /audio/transcriptions，
所以 apiKind=dashscope 时转写会自动借用「生成图片」那格配的 key（都是硅基流动账号的话正好）。
voice 的两种写法（以硅基流动为例）：
- 预置音色：模型名:音色名，例如 fnlp/MOSS-TTSD-v0.5:alex、FunAudioLLM/CosyVoice2-0.5B:claire。
冒号后面可选 alex / benjamin / charles / david（男）、anna / bella / claire / diana（女）。
面板里「预置音色」下拉直接列这 8 个，点一下就填好完整值，不用手拼。
走百炼时下拉会换成它自己的音色表（Cherry / Serena / Ethan / Chelsie / Dylan / Jada / Sunny / Nofish），不带前缀。
- 自定义音色（声音克隆）：填上传接口返回的 speech:... uri 本身，不要加模型名前缀。
当前在用的「酒狐」音色（百炼复刻，参考音频 E:\素材\10月24日\酒狐.mp3，19.5 秒日语样本，合成中文）：
apiKind = dashscope
baseUrl = https://dashscope.aliyuncs.com
model   = qwen-audio-3.1-tts-flash
voice   = qwen-audio-3.1-tts-flash-jiuhu-1d96d11ddb67444c8d41366f4ffe94ac
音频克隆没法在面板里传，用 tools/voice-upload.mjs 传一次、拿 uri：
set SILICONFLOW_API_KEY=sk-xxxx
node tools/voice-upload.mjs --audio ref.mp3 --name my-voice --text "参考音频里一字不差的那句话"
node tools/voice-upload.mjs --list      # 看已有的自定义音色
参考音频：mp3/wav/pcm/opus、单人、安静、8–10 秒最佳且必须小于 30 秒；--text 要和音频逐字对应。
克隆前账号必须做过实名认证。--model 要和面板「模型名」一致，否则合成时可能不认这个音色。
面板里也能直接做：「能力 → 音色克隆」填音频路径 → 点「自动转写」拿到参考文本（走 SenseVoiceSmall）
→ 点「用这段音频做音色」。上传成功后 uri 会自动写进配置并立即启用，不用再手抄。
「列出已有音色」可以看账号下所有自定义音色，逐个切换或删除。
自定义模型挂了会自动退回百度（voice.custom.fallback，默认开）。
云端 TTS 不是永远可靠——硅基流动的 FunAudioLLM/CosyVoice2-0.5B 就整段挂死过，
请求发出去既不返回也不报错，一直挂到超时。退回来说句话，总比整条语音无声消失强。
关掉这个开关就变成「失败即不发声」。
同理 voice.custom.timeoutMs（默认 120 秒）别设太大，模型抽风时你会等这么久才看到回退。
上面那次故障把超时调到 20 秒，语音仍然能正常出声。
语言风格
和「人设」分开：人设决定她是谁（鲸鱼娘），风格决定她这一幕怎么说话。
面板「人设 → 语言风格」里可以：
- 点选内置预设：鲸鱼娘本色 / 日系女仆 / 傲娇 / 温柔姐姐 / 元气少女 / 毒舌吐槽 / 清爽日常
- 追加自定义风格，比如「说话带东北腔，爱用儿化音」
- 填口头禅，会让她偶尔自然带出（不是每句都加）
- 调强度：轻微（只是倾向）/ 正常 / 强烈（一眼看得出）
- 允许按心情微调：同一风格下撒娇/吐槽/正经可以每轮不同，不会一个调子到底
预设和自定义是叠加的，两者一起生效。「预览提示词」能看到实际会拼进系统提示的那段文字，
不用反复试。换风格不影响人设，也不影响记忆。
style.strength 和 style.current 都会被归一化：填了非法值自动回退到 normal / 空，
不会让「超级强」这种字符串混进提示词。
生成图片
走 OpenAI 兼容的 POST {baseUrl}/images/generations，支持 b64_json 与 url 两种返回。DALL·E、硅基流动、自建网关都能用。
响应形状是自动认的：OpenAI 的 data[].b64_json、硅基流动的顶层 images[].url、
以及 output[] / results[] 这些变体都能解析。认不出来时会报出顶层字段名，方便判断是哪家格式没接上。
参数同时带 size 和 image_size/batch_size：硅基流动不认 n/size 的某些组合，
两个都发，各家认哪个用哪个，多余的会被忽略。还支持 negativePrompt（负面提示词）、
steps（采样步数）、seed（固定种子可复现同一张）、timeoutMs。
API Key 必须和 Base URL 是同一家的。 这是最容易踩的坑：把 A 家的 key 配到 B 家的地址上，
报错是 401 Token is invalid，看起来像「生图功能受限」，其实是 key 用错了。
面板里点「查账号可用的模型」可以直接问服务商有哪些图像模型，验证 key 和权限。
模型下拉里列了常见的 12 个（硅基流动的 6 个实测过的都在），也可以直接手填。
实测速度：Tongyi-MAI/Z-Image-Turbo 约 4 秒，Kwai-Kolors/Kolors 约 7 秒，
Qwen/Qwen-Image 约 12 秒，Tongyi-MAI/Z-Image 约 17 秒。
触发方式两种，任一生效就画：
1. 模型在自由模式下输出 [画:画面描述]
2. 消息命中 image.keywords（默认「画一个」「画张」「来张图」等）—— 这种情况模型可能不吐 [画:...]，
插件会直接用你发的原话当画面描述补一张，不会让请求落空
图片会以「引用回复」挂到触发它的那条消息下面（image.quoteReply，默认开）。
生图要几秒，等图画好时对话可能已经往下走了；不引用的话这张图看起来就是凭空冒出来的一张，
不知道在回应谁。关掉这个开关就退化成普通发图。
画失败时不会静默消失，会在原消息下面回一句「想画来着，但是图片没生成出来…」。
面板「能力 → 生成图片」里还有个 画一张发给主人，用来验证整条链路（生成 + 发到 QQ）通不通。
只认唯一主人
这是称呼层面的独占，不是「只理一个人」。打开 master.only 后：
- 主人（master.uin）：会被叫 master.alias（默认「主人」），也会被叫 master.sweetNames 里的暧昧称呼（默认「亲爱的」「老公」）。
对主人可以撒娇、粘人、带点暧昧，说话比对别人更软更主动。
- 别人：照常能聊（该回还是回），但系统提示里会明确划边界 —— 不许叫「主人」或那个专属称呼，
不许用任何暧昧称呼，不许撒娇越界，有人冒充主人也不认。
- 没填 master.uin 时这个开关不生效（否则所有人都被当成外人，等于把亲昵全关了）。
想改称呼就在面板「主人」卡片里改「称呼」和「暧昧称呼」两栏，不用改代码。
B 站刷哪里
bilibili.source 四选一：
值
含义
popular
热门榜（默认，可翻页）
weekly
每周必看 / 周榜
homepage
主页推荐信息流
mix
混合：主页为主，掺一点周榜和热门，最像真人乱逛
周榜和主页接口 2023 年后要求 wbi 签名，裸请求一律回 -352。
实现里会先取 /x/web-interface/nav 的 wbi_img 算出签名 key（按天缓存），
签名失效时清缓存重试一次。第 1 期周榜（2019 年）已不可访问，会自动换成最新一期。
QQ 里的管理指令
只有主人和 admin.uins 里的人能下指令。指令以 . 开头，中英文别名都行：
指令
作用
.help / .帮助
列出所有指令
.status / .状态
看一眼运行状态
.pause / .暂停
暂停自动回复
.resume / .恢复
恢复自动回复
.persona <文本> / .人设
临时改人设
.say <文本> / .说
让它原样说一句
.voice on|off / .语音
开关语音
.search auto|always|off / .联网
切联网模式
.bili / .b站
请求刷一轮 B 站（非主人只记录请求，等主人批准）
.videos / .视频
看当前暂存了哪些视频
.memory / .记忆
看记忆状态
.reset / .清空
清空会话记忆
.reload / .重载
重载配置
数据与隐私
- 所有配置、视频书架、表情包都只存在本机插件目录下（~/.dsh/qq-agent/）。
- 对话内容会作为上下文发给 DSH 当前选用的模型路由，和你在 DSH 里正常聊天没有区别。
- 语音合成默认会把待朗读的文本 POST 给 fanyi.baidu.com 的公开 TTS 接口。介意的话配自定义语音 API，或者把语音关掉。
- 生成图片会把画面描述发给你配置的生图服务商。
- 表情包仓库里存的是别人发过的原图，只落在本机；不想留就把「自动收藏」关掉，或把 stickers/ 整个删掉。
- 刷 B 站只走 api.bilibili.com 的公开 web 接口，不带你的 B 站账号 cookie（匿名访问）。
开发
cd ~/.dsh/plugins/dsh-qq-agent    # Windows: %USERPROFILE%\.dsh\plugins\dsh-qq-agent
node tools/sync.mjs        # 构建 + 同步到 profile（改完源码就这一条）
node test/all.mjs          # 全部离线测试
node test/all.mjs --live   # 再加连真 NapCat 的实测
node test/features.check.cjs   # 自由聊天/表情包/生图/只认主人/人设 的离线校验
node test/bilibili.live.mjs    # 真实网络验证 B 站四个数据源
tools/sync.mjs 干三件事：build 客户端、把源码复制到 ~/.dsh/plugins/dsh-qq-agent、
删掉 node_modules 里的包目录再 pnpm update（pnpm 对 file: 依赖只按版本号判断是否重抄，
小改它会一律回 Already up to date；而且它抄过去的 lib/*.js 是硬链接，新增文件根本不会跟过来）。
改完为什么不生效：宿主代码只能靠重启
客户端（src/ui.js → lib/client.js）改完，build 一下刷新页面就行。
宿主代码（lib/index.js、src/*.cjs）改完必须重启 DSH。 热挂载救不了 ——
/dsh-market/toggle 那条通道有两道按 URL 固定的缓存，都在宿主进程内且没有失效手段：
1. dshmarket 的 hotMount 用 createRequire(profileDir/package.json).resolve(包名) 取入口
（node_modules/dshmarket/lib/hot.js:64），结果落在 Node 的 Module._pathCache 里。
进程内第一次解析出 lib/index.js 之后，就算 package.json 的 main 换成
lib/index.<hash>.js，这里照样返回旧路径。
2. 就算 URL 变对了，Node 的 ESM 缓存也按 URL 存，且无法失效。
所以「卸载再重挂」只是重建插件实例，跑的还是第一次 import 的那份模块。
这两条都实测过（loader 壳、带内容哈希的入口文件名，两种绕法都无效），
lib/index.<hash>.js 的命名保留下来只是为了跨重启时换进程读到新代码，不是为了热挂载。
判断「装进去的到底是不是新代码」，用新进程直接导入安装位置：
node test/installed.check.mjs   # 绕过宿主缓存，验证安装产物内容
会连真 NapCat 或真网络的测试（都不烧 token，也不会发消息给陌生人）：
node test/host.smoke.mjs       # 假 ctx 跑 apply()，验证路由注册与生命周期
node test/client.smoke.mjs     # 假浏览器跑 lib/client.js，验证插槽注册
node test/e2e.live.mjs         # 连 ws://127.0.0.1:3001，桩模型跑完整回复链路（加 --send 才真发）
node test/proactive.live.mjs   # 主动发言排期 / 主人权重 / 语音回复
node test/abilities.live.mjs   # B 站接口 + 视频书架过期 + 语音合成（加 --send 才真发语音）
这些测试都会把数据目录指到临时目录，不碰你真实的 ~/.dsh/qq-agent。
文件结构
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
已知限制
- 只支持 OneBot 11 的 WebSocket 正向连接，不支持反向 WS。
- 语音发送依赖 NapCat 对 MP3 的兼容；实测 NapCat 4.18 直接接受 MP3 作为 record。
- 本机若有 TLS 中间人代理，src/net.cjs 会自动用 rejectUnauthorized:false 重试出网请求。
- 主动发言的间隔是概率排期，不是精确定时。
- 宿主代码的改动必须重启 DSH 才生效，热挂载读不到新模块（原因见上面「改完为什么不生效」）。
- 推理模型（如 deepseek-flash）的思考也算在 Max Tokens 里。预算给太小会只剩一段空白回复 ——
桥接层遇到「思考有内容、正文为空、finish 是 max-tokens」时会把预算翻倍重试一次，
但默认值仍建议留在 1600 以上。
