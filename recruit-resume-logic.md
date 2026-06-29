# Hermes Recruit 招聘简历获取与评估逻辑剖析

> 本文基于 `hermes-recruit/` 仓库源码梳理，旨在提炼一套**可复用、可借鉴**的"AI 招聘 Agent"工程实现思路：从浏览器自动化抓取简历，到 LLM 多维评分，再到风险检测与持久化排名的端到端流程。
>
> 适用读者：想搭建类似招聘自动化系统、或对"LLM + 浏览器自动化 + 规则引擎"组合架构感兴趣的研发同学。

---

## 1. 项目定位与两条技术路线

`hermes-recruit` 是从开源 `hermes-agent` fork 出来的招聘向定制版，保留通用 coding chat，新增"招聘工作台"作为并列导航。仓库内同时存在**两条实现路线**，理解它们的差异是借鉴本文的前提：

| 路线 | 位置 | 爬虫方案 | 评估调用 | 适用场景 |
|---|---|---|---|---|
| **A. 深嵌核心（主线）** | [agent/recruitment/](../agent/recruitment/) | `boss-cli`（Node.js + CDP）子进程 | 进程内直调 `agent.auxiliary_client.call_llm`，走 Hermes 模型 | 与 Hermes 强耦合，单进程内闭环 |
| **B. 独立模块（备选）** | [boss-recruit/](../boss-recruit/) | Python + DrissionPage（接口监听） | 经 MCP `sampling/createMessage` 回调 Hermes，或直连 DeepSeek | 解耦部署，可独立运行，亦可被任意 MCP 客户端调用 |

两者**评估算法完全一致**（同样的维度权重、同样的风险规则、同样的 prompt），区别仅在"如何抓简历"和"如何调 LLM"。本文以主线 A 为主、备选 B 为辅，分别剖析。

---

## 2. 整体架构：三层流水线

招聘评估被刻意设计成**结构化四阶段流水线**，而非单次 LLM 调用，目的是让每个阶段可独立测试、可缓存、可降级。

```
┌────────────────────────────────────────────────────────────────────┐
│  Stage 1  结构化采集    │  Stage 2  JD 准备    │  Stage 3  多维评分 + 风险 │  Stage 4  落库 + 排名  │
│  crawler.search_       │  storage.get_job    │  evaluator.score_with_   │  storage.save_        │
│  candidates            │  或调用方传入        │  llm  +  risk.detect_    │  evaluation           │
│  crawler.fetch_resume  │  jd_text            │  risks                   │  batch.rank_          │
│  (boss-cli / DrissionPage)│                  │  (call_llm + 规则引擎)   │  evaluations          │
└────────────────────────────────────────────────────────────────────┘
                          pipeline.evaluate_candidate 编排
```

编排函数 [pipeline.py:evaluate_candidate](../agent/recruitment/pipeline.py) 是关键：

1. **采集**：若调用方未提供 `resume_text`，则用 `crawler.fetch_resume` 抓取（截图 + OCR / 视觉提取）。
2. **JD 准备**：优先用 `job_id` 从库里取 JD，其次用调用方传入的 `jd_text`；两者都没有则报错。
3. **评分 + 风险**：`evaluator.evaluate_resume` 一次性完成 LLM 评分与规则风险检测。
4. **持久化**：写 `evaluations` 表，返回带 `candidate_id` / `job_id` / `evaluation_id` 的完整 payload。

> **设计要点**：流水线刻意做成**同步**。桌面端工具直接调用，Cron 批量循环也按顺序执行——目的是控制对 BOSS 的请求频率，避免触发反爬（详见 §7）。

---

## 3. 简历获取逻辑（核心剖析）

### 3.1 主线 A：boss-cli 子进程方案

[agent/recruitment/crawler.py](../agent/recruitment/crawler.py) 定义了 `BossZhipinCrawler`，它不直接驱动浏览器，而是通过 `subprocess.run` 调用外部 `boss-cli`（一个独立的 Node.js + CDP 工程）：

```python
def _run_cli(self, *args: str, timeout: int = 120) -> str:
    env = os.environ.copy()
    env["BOSS_BROWSER_HEADLESS"] = "true" if self.headless else "false"
    env["BOSS_RESUME_OCR"] = "0"  # 禁用 boss-cli 自带 OCR，改由 Hermes LLM 视觉模型提取
    cmd = ["node", self._cli_path, *args]
    result = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout, ...)
    ...
```

**两个核心动作**：

| 动作 | boss-cli 命令 | Python 解析函数 | 返回 |
|---|---|---|---|
| 搜索候选人 | `boss recommend [keyword]` | `parse_recommend_output` | `List[Candidate]` |
| 获取简历 | `boss preview <姓名\|序号>` | `parse_preview_output` | `Resume`（含截图路径 + OCR 文本） |

#### 3.1.1 候选人列表解析

`boss recommend` 输出的是**人类可读文本**（非 JSON），格式形如：

```
推荐列表（按来源分组）：共 20 人。

常规推荐（18）
  - 1. 张三｜薪资:8-12K｜信息:25岁 / 5年 / 大专｜期望:全栈开发｜可打招呼
    优势: 精通 React/Vue
```

`parse_recommend_output` 用正则逐行解析（[crawler.py:74-160](../agent/recruitment/crawler.py#L74-L160)）：

- **分组识别**：`^(常规推荐|打招呼产生的推荐)` 区分推荐来源。
- **候选人行**：`^-\s+(\d+)\.\s+(.+?)(?:\s*\|\s*看过)?(?:｜(.+))?$` 捕获序号、姓名、字段串。
- **字段切分**：以 `｜` 切分，按前缀（`薪资:` / `信息:` / `期望:` / `经历:`）归类。
- **基础信息二次提取**：从 `信息:` 字段切 `/` 后，分别匹配 `(\d+)岁`、`(\d+)年`、学历枚举、应届生标记。
- **去重**：以姓名为 key 去重（boss-cli 推荐列表可能重复）。

> **借鉴点**：当外部工具产出是文本而非 JSON 时，**用结构化正则按行解析**比试图整体 JSON 化更稳健；同时保留 `raw` 字段把原始 payload 透传到上游，便于事后回溯。

#### 3.1.2 简历预览解析

`boss preview` 输出格式（OCR 启用时）：

```
当前岗位：默认
简历预览截图：/path/to/screenshot.png

在线简历 OCR 正文：

[简历文本内容]

说明：平台对在线简历的每日可查看次数有限...
```

`parse_preview_output` 做两件事（[crawler.py:163-230](../agent/recruitment/crawler.py#L163-L230)）：

1. 正则提取 `简历预览截图：(.+)` 拿到截图路径。
2. 正则提取 `在线简历 OCR 正文：\s*\n(.*?)(?:\n说明：|$)`（`re.DOTALL`）拿到 OCR 文本。
3. 从 OCR 文本中"尽力"提取姓名、求职意向、工作年限、学历、年龄等结构化字段。

#### 3.1.3 关键设计：禁用 boss-cli OCR，改用 LLM 视觉提取

主线 A 的一个**亮点设计**：在 `_run_cli` 里强制 `BOSS_RESUME_OCR=0`，不用 boss-cli 自带的百度 OCR，而是把截图交给 Hermes 的 LLM 视觉模型（[evaluator.py:_extract_text_from_screenshot](../agent/recruitment/evaluator.py#L30-L82)）：

```python
prompt_content = [
    {"type": "text", "text": "这是一份在线简历的截图。请提取其中的全部文本内容，保持原有的结构和层次..."},
    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
]
# 优先视觉模型，失败则回退主模型
for task in ("vision", "mcp"):
    try:
        resp = call_llm(task=task, messages=[...], temperature=0.1, max_tokens=4096)
        ...
```

**借鉴理由**：
- **少一个外部依赖**：无需部署百度 OCR / Tesseract。
- **质量更高**：LLM 能理解简历结构（区分工作经历、项目经历、教育背景），纯 OCR 只能得到平面文本。
- **优雅降级**：`vision` 任务失败自动回退到 `mcp`（主模型），保证可用性。

### 3.2 备选 B：DrissionPage 接口监听方案

[boss-recruit/crawler/boss_crawler.py](../boss-recruit/crawler/boss_crawler.py) 走的是另一条路：**直接监听浏览器网络响应**，从 BOSS 接口返回的 `zpData` 字段中提取结构化 JSON，无需逆向加密算法、无需 OCR。

```python
class BossZhipinCrawler:
    API_PATTERNS = {
        "candidate_list": "boss/r/geek",
        "resume_detail": "geek/resume",
    }
    def __init__(self, headless=False, user_data_dir=None):
        co = ChromiumOptions()
        co.headless(headless)
        co.set_argument("--disable-blink-features=AutomationControlled")
        if user_data_dir:
            co.user_data_path(user_data_dir)
        self.page = ChromiumPage(co)
```

**两个核心动作**：

| 动作 | 监听的 URL 模式 | 取值路径 |
|---|---|---|
| 搜索候选人 | `boss/r/geek` | `zpData.list` / `jobList` / `geekList` / `recommendList`（多字段兜底） |
| 获取简历 | `geek/resume` | `zpData` 整体（含 `geekCard`） |

**反爬策略**（[boss_crawler.py:91-110](../boss-recruit/crawler/boss_crawler.py#L91-L110)）：
- 随机延时 `random.uniform(2, 5)`
- 拟人滚动 `_human_like_scroll`（3-8 次、每次 100-300px、间隔 0.3-0.8s）
- **复用已登录 Chrome profile**（`CHROME_PROFILE_DIR`），保持登录态
- **默认有头模式**（`headless=False`），规避自动化检测
- 接口监听超时 20s + 异常捕获

**桥接方式**：[boss-recruit/server/src/services/crawlerBridge.ts](../boss-recruit/server/src/services/crawlerBridge.ts) 通过 `child_process.spawn` 拉起 `python main.py --task search|resume`，120s 超时，stdout 末尾打印 JSON 信封 `{"status":"ok","data":{...}}`，日志走 stderr 避免污染解析。

### 3.3 两条路线对比与选型建议

| 维度 | A：boss-cli 子进程 | B：DrissionPage 接口监听 |
|---|---|---|
| 数据形态 | 文本输出（需正则解析） | 结构化 JSON（直接映射） |
| 简历文本来源 | 截图 → LLM 视觉提取 | 接口 JSON（已结构化） |
| 反爬稳健性 | 复用 boss-cli 成熟实现 | 自实现拟人滚动 + 登录态复用 |
| 外部依赖 | Node.js + boss-cli + LLM 视觉 | Python + DrissionPage + Chrome profile |
| 集成方式 | subprocess | subprocess（Node 调 Python） |
| 失败兜底 | LLM 视觉失败回退主模型 | 接口超时直接返回 None |

**选型建议**：
- 若已有成熟的浏览器自动化工具（如本项目的 boss-cli），**优先用 A**：少造轮子、反爬更稳。
- 若目标网站有结构化 API 响应可监听，**用 B**：数据质量更高、无需 OCR。
- **简历文本获取的兜底链**值得借鉴：`rawText` → `screenshotPath` → LLM 视觉 → 结构化字段拼接（`_resume_to_text`），层层降级保证评估总有输入。

---

## 4. 评估逻辑：LLM 评分 + 规则风险

### 4.1 六维度评分模型

[evaluator.py](../agent/recruitment/evaluator.py) 与 [llmEngine.ts](../boss-recruit/server/src/services/llmEngine.ts) 定义了完全一致的维度与权重：

| 维度 | key | 权重 | 评分来源 |
|---|---|---|---|
| 技能匹配 | `skill_match` | 30% | LLM |
| 项目经验 | `experience` | 30% | LLM |
| 学历背景 | `education` | 15% | LLM |
| 稳定性 | `stability` | 15% | LLM |
| 薪资匹配 | `salary_fit` | 10% | LLM |
| 风险评级 | `risk` | 独立标记（不计入综合分） | **规则引擎** |

> **设计要点**：`risk` 维度**不计入 `overallScore`**，而是作为独立标记。一旦存在 `high` 级风险，推荐意见**强制为 `reject`**，覆盖 LLM 的判断。这是"LLM 主观评分 + 规则客观一票否决"的典型组合，值得借鉴。

### 4.2 LLM 评分 Prompt 构建

`_build_prompt` / `buildEvalPrompt`（[evaluator.py:122-145](../agent/recruitment/evaluator.py#L122-L145)）的写法值得复用：

```python
system = (
    "你是资深技术招聘专家。请基于岗位 JD 与候选人简历，进行客观、严谨的多维度评分。"
    "只输出 JSON，不要任何额外文字或 Markdown 代码块。"
    "评分 0-100 整数。detail 用一句话中文给出依据。"
    "recommendation 取值：recommend（推荐面试）/ consider（待定）/ reject（不推荐）。"
)
schema_example = json.dumps({
    "dimensions": {d: {"score": "number 0-100", "detail": "string"} for d in SCORING},
    "summary": "string",
    "recommendation": "recommend | consider | reject",
}, ensure_ascii=False)
user = f"# 岗位 JD\n{jd_text}\n\n# 候选人简历\n{resume_text}\n\n# 评估要求\n..."
```

**借鉴点**：
- **system prompt 明确约束输出格式**：禁止 Markdown 代码块、明确枚举取值，降低解析失败率。
- **JSON Schema 作为示例嵌入**：比纯文字描述更精准，LLM 服从度更高。
- **`temperature=0.2`**：招聘评估追求稳定可复现，不用高创造性温度。
- **`parse_llm_result` 容错**（[evaluator.py:148-165](../agent/recruitment/evaluator.py#L148-L165)）：兼容 ```` ```json...``` ```` 包裹、字段缺失、非法 recommendation 值（默认 `consider`）、分数越界（`_clamp` 钳到 0-100）。

### 4.3 规则风险引擎

[risk.py](../agent/recruitment/risk.py) / [riskDetector.ts](../boss-recruit/server/src/services/riskDetector.ts) 实现了 5 条独立于 LLM 的规则：

| 规则 | 等级 | 触发条件 |
|---|---|---|
| 空窗期过长 | medium | 相邻工作间隔 > 6 个月 |
| 跳槽过频 | **high** | 近 2 年内 ≥2 份工作，平均 < 12 个月/家 |
| 学历不一致 | **high** | 平台显示学历 ≠ 简历最新学历 |
| 薪资偏差大 | medium | 期望薪资 > 岗位预算上限 × 1.3 |
| 项目经验空洞 | low | 所有项目描述为空或 < 12 字 |

**实现细节**（[risk.py:23-30](../agent/recruitment/risk.py#L23-L30)）：
- 宽松日期解析：支持 `YYYY-MM` / `YYYY.MM` / `YYYY年MM月` / `至今` / `present`，正则 `(\d{4})[^\d]*(\d{1,2})?`。
- `_months(a, b)` 计算月份差，用于空窗与跳槽频率。
- 工作经历先按开始时间排序再算间隔。

**风险维度分数**（[risk.py:104-106](../agent/recruitment/risk.py#L104-L106)）：`high=-25 / medium=-12 / low=-5`，从 100 起扣，最低 0。

> **借鉴点**：规则引擎与 LLM 评分**解耦**——规则可解释、可审计、可独立调整；LLM 主观但灵活。两者结合比纯 LLM 更可信。

---

## 5. 持久化与排名

### 5.1 SQLite Schema

[storage.py](../agent/recruitment/storage.py) / [schema.ts](../boss-recruit/server/src/db/schema.ts) 定义了 4 张核心表：

```
jobs           (id, title, content, budget_min, budget_max, created_at)
candidates     (id, name, position, experience_years, education, age,
                salary_min, salary_max, skills TEXT, raw TEXT, created_at)
evaluations    (id, candidate_id, job_id, jd_text, overall_score,
                result_json TEXT, evaluated_at)
resumes        (candidate_id PK, raw_text, screenshot_path, basic_info TEXT, fetched_at)
```

**借鉴点**：
- **`raw` / `result_json` 用 TEXT 存 JSON**：SQLite 无原生 JSON 类型，存文本 + 应用层解析是常见做法；同时保留原始 payload，便于回溯与重评估。
- **`ON CONFLICT(id) DO UPDATE`**：候选人按 id 幂等 upsert，避免重复抓取产生重复行。
- **`PRAGMA journal_mode = WAL`**：并发读 + 单写，适合"批量评估写 + 工作台读"的场景。
- **`idx_eval_candidate` / `idx_eval_job`**：按候选人和岗位查评估历史，工作台排行榜的关键索引。

### 5.2 批量评估与排名

[batch.py](../agent/recruitment/batch.py) 的 `evaluate_batch` 支持三种候选人来源：

1. `keywords` —— 实时调 BOSS 搜索，截取前 `max_candidates` 个。
2. `candidate_ids` —— 重新评估指定存量候选人。
3. `job_id` only —— 重新评估该岗位历史评估过的所有候选人。

**排名逻辑**（[batch.py:_rank_eval_rows](../agent/recruitment/batch.py#L131-L144)）：
- 一级排序：`recommend > consider > reject`（推荐优先）。
- 二级排序：`overall_score` 降序。
- 加上 `rank` 字段（1, 2, 3...）。

`export_ranking` 还能把排行榜渲染成 Markdown 表格，便于导出分享。

---

## 6. 配置系统：四级优先级

[config.py](../agent/recruitment/config.py) 的 `RecruitmentConfig.load` 实现了清晰的配置优先级：

```
explicit arg  >  environment variable  >  config.yaml  >  built-in default
```

**关键配置项**：
- **LLM**：`HERMES_RECRUIT_LLM_PROVIDER/MODEL/BASE_URL/API_KEY`，或兼容 `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` 等通用 shorthand。
- **Chrome profile**：`HERMES_RECRUIT_CHROME_PROFILE`（备选 B 用，保持登录态）。
- **合规**：`HERMES_RECRUIT_DAILY_LIMIT=200`、`WORK_HOUR_START=9`、`WORK_HOUR_END=20`、`MIN_DELAY=2.0`、`MAX_DELAY=5.0`。
- **评估**：`temperature=0.2`、`max_tokens=2048`、`request_timeout=60s`。

**借鉴点**：
- **凭据零硬编码**：API key 全部走 env，`load()` 懒解析，缺失只在真正调用时才报错。
- **模块级缓存** `_CONFIG`：避免每次评估都重读 config.yaml，`reload=True` 可强制刷新。
- **`llm_kwargs()` 只传已设置的字段**：让 `call_llm` 在未配置时回退到 Hermes 主模型，实现"零配置可用"。

---

## 7. 合规与反爬设计

这一节是**最值得借鉴**的工程实践，也是招聘自动化系统不被封号的关键。

### 7.1 频率控制

| 限制项 | 默认值 | 来源 |
|---|---|---|
| 日访问上限 | 200 次 | docx §7.1 |
| 工作时段窗口 | 9:00-20:00 | docx §7.1 |
| 请求最小间隔 | 2.0s | 拟人节奏 |
| 请求最大间隔 | 5.0s | 拟人节奏 |
| 单次简历超时 | 120s | `crawler._run_cli(timeout=120)` |
| 批量评估 | **串行**，不并发 | `batch.py` for 循环 |

### 7.2 反爬技术手段

- **复用已登录 Chrome profile**（`CHROME_PROFILE_DIR` / boss-cli 自管理），避免每次登录触发验证码。
- **默认有头模式**（`headless=False`），headless 特征更易被识别。
- **拟人滚动**（DrissionPage 方案）：3-8 次、100-300px、0.3-0.8s 间隔。
- **随机延时**：所有页面操作前后 `random.uniform(2, 5)`。
- **`--disable-blink-features=AutomationControlled`**：隐藏 `navigator.webdriver` 等自动化指纹。

### 7.3 降级就绪状态

`GET /api/recruitment/status` 返回 `{ crawlerReady, llmReady }`，前端据此显示状态徽章；**对应组件未就绪时接口返回 503（而非模拟数据）**。这一原则保证了"不会在爬虫或 LLM 未就绪时静默返回假数据"，值得所有自动化系统借鉴。

---

## 8. MCP 工具契约：让 AI 能调用

备选路线 B 通过 [mcp/stdio.ts](../boss-recruit/server/src/mcp/stdio.ts) 暴露三个 MCP 工具，让 Hermes Agent 能在对话中调用招聘能力：

| 工具 | 入参 | 作用 |
|---|---|---|
| `search_boss_candidates` | `keyword` / `cityCode` / `city` / `pageLimit` | 搜索候选人 |
| `fetch_and_evaluate_resume` | `candidate_id` / `jd_text` / `job_id` | 获取简历 + AI 六维评估 |
| `batch_evaluate` | `candidate_ids[]` / `jd_text` / `job_id` | 批量评估 + 排名 |

**强关联设计**（[samplingClient.ts](../boss-recruit/server/src/mcp/samplingClient.ts)）：评估的 LLM 调用通过 MCP `sampling/createMessage` **回调 Hermes**，复用 Hermes 的模型切换 / 额度 / 记忆，而非 boss-recruit 自带 DeepSeek。这让招聘模块"不自带一套 AI 能力"，是**模块化扩展**而非"另起炉灶"。

```typescript
const result = await this.lowLevelServer.request(
  {
    method: 'sampling/createMessage',
    params: {
      messages: [{ role: 'user', content: { type: 'text', text: userPrompt } }],
      maxTokens: 2048,
      systemPrompt,
      includeContext: 'none',
      modelPreferences: this.modelHint ? { hints: [{ name: this.modelHint }] } : undefined,
    },
  },
  CreateMessageResultSchema,
)
```

> **借鉴点**：当一个子系统需要 LLM 能力时，**优先复用宿主的 LLM 通道**（sampling / 进程内调用），而非自己再配一份 API key。这降低了运维成本，也让模型切换、额度计费、上下文记忆统一在宿主侧。

---

## 9. 可借鉴的工程模式总结

| 模式 | 体现位置 | 借鉴价值 |
|---|---|---|
| **结构化四阶段流水线** | `pipeline.evaluate_candidate` | 每阶段独立可测、可缓存、可降级 |
| **LLM 评分 + 规则一票否决** | `evaluator` + `risk` | 主观与客观结合，高风险强制 reject |
| **多层数据降级链** | `rawText` → `screenshotPath` → LLM 视觉 → 结构化拼接 | 保证评估总有输入 |
| **外部工具文本输出的正则解析** | `parse_recommend_output` | 比 JSON 化更稳健，保留 `raw` 透传 |
| **四级配置优先级** | `RecruitmentConfig.load` | arg > env > yaml > default，零硬编码 |
| **幂等 upsert + WAL** | `storage.upsert_candidates` | 重复抓取不产生脏数据 |
| **批量串行 + 拟人间隔** | `batch.evaluate_batch` + `random.uniform(2,5)` | 反爬核心 |
| **降级就绪状态显式暴露** | `/api/recruitment/status` 返回 503 | 不静默返回假数据 |
| **MCP sampling 复用宿主 LLM** | `SamplingLlmClient` | 子模块不自带 AI 能力 |
| **同步流水线 + Cron 定时** | `pipeline` 同步 + `cron/scheduler.py` | 控制频率，避免并发触发反爬 |

---

## 10. 上手路径

若你想在自己的项目里复用这套思路，建议按以下顺序阅读源码：

1. [RECRUIT.md](../RECRUIT.md) —— 项目定位与双路线说明。
2. [agent/recruitment/pipeline.py](../agent/recruitment/pipeline.py) —— 四阶段编排，最短路径理解全局。
3. [agent/recruitment/crawler.py](../agent/recruitment/crawler.py) —— 简历获取主线 A。
4. [boss-recruit/crawler/boss_crawler.py](../boss-recruit/crawler/boss_crawler.py) —— 简历获取备选 B（接口监听）。
5. [agent/recruitment/evaluator.py](../agent/recruitment/evaluator.py) —— LLM 评分 + 视觉提取。
6. [agent/recruitment/risk.py](../agent/recruitment/risk.py) —— 规则风险引擎。
7. [agent/recruitment/storage.py](../agent/recruitment/storage.py) —— SQLite 持久化。
8. [agent/recruitment/batch.py](../agent/recruitment/batch.py) —— 批量评估与排名。
9. [agent/recruitment/config.py](../agent/recruitment/config.py) —— 配置系统。
10. [boss-recruit/server/src/mcp/stdio.ts](../boss-recruit/server/src/mcp/stdio.ts) —— MCP 工具契约（若需接入 AI Agent）。

---

## 附录：关键文件索引

### 主线 A（深嵌核心）

- [agent/recruitment/__init__.py](../agent/recruitment/__init__.py) —— 模块说明
- [agent/recruitment/pipeline.py](../agent/recruitment/pipeline.py) —— 端到端编排
- [agent/recruitment/crawler.py](../agent/recruitment/crawler.py) —— boss-cli 子进程爬虫
- [agent/recruitment/evaluator.py](../agent/recruitment/evaluator.py) —— LLM 评估 + 视觉提取
- [agent/recruitment/risk.py](../agent/recruitment/risk.py) —— 规则风险引擎
- [agent/recruitment/storage.py](../agent/recruitment/storage.py) —— SQLite 持久化
- [agent/recruitment/batch.py](../agent/recruitment/batch.py) —— 批量评估 + 排名
- [agent/recruitment/config.py](../agent/recruitment/config.py) —— 配置系统

### 备选 B（独立模块）

- [boss-recruit/crawler/boss_crawler.py](../boss-recruit/crawler/boss_crawler.py) —— DrissionPage 接口监听
- [boss-recruit/crawler/main.py](../boss-recruit/crawler/main.py) —— 爬虫 CLI 入口
- [boss-recruit/server/src/services/crawlerBridge.ts](../boss-recruit/server/src/services/crawlerBridge.ts) —— Node 调 Python 桥接
- [boss-recruit/server/src/services/recruitmentService.ts](../boss-recruit/server/src/services/recruitmentService.ts) —— 业务编排
- [boss-recruit/server/src/services/llmEngine.ts](../boss-recruit/server/src/services/llmEngine.ts) —— LLM 评估引擎
- [boss-recruit/server/src/services/riskDetector.ts](../boss-recruit/server/src/services/riskDetector.ts) —— 风险检测
- [boss-recruit/server/src/mcp/stdio.ts](../boss-recruit/server/src/mcp/stdio.ts) —— MCP 工具暴露
- [boss-recruit/server/src/mcp/samplingClient.ts](../boss-recruit/server/src/mcp/samplingClient.ts) —— sampling 回调 Hermes
- [boss-recruit/server/src/routes/recruitment.ts](../boss-recruit/server/src/routes/recruitment.ts) —— Express 路由
- [boss-recruit/server/src/db/schema.ts](../boss-recruit/server/src/db/schema.ts) —— DDL
