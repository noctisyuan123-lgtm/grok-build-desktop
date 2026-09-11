# 会话续接与 Undo/Redo 改造设计（评审稿 · 修订）

状态：**Phase 0+1 已落地**（`157db4b`）· Phase 2 热路径已落地 · prewarm key 收窄 + 多级 Undo 已落地 · 2026-09-11

> 实现对照（忽略文中过时「现状」表）：Phase 0 止血与 Phase 1 同 session 已合并；
> Phase 2a replay 截断、2b rebase 提示、2c ACP `file_snapshots` 还原、2d shadow-git 工作区快照已落地；
> **Undo 已对齐 Grok Build native eager rewind**（点击即 `_x.ai/rewind/execute` / 同 session 截断，不再 OpenCode 式 pointer-until-send）；
> **多级连续 Undo**：可对同 tab 内更早的已完成 user 回合 rewind 到该 `prompt_index`（非仅 tip）；
> **prewarm key 已收窄**为 `laneId + cwd + 稳定 host 配置`（不含 `liveSessionId` / 完整 args / rules blob）；
> Phase 2 item 4 热路径：活 ACP host / prewarm 已挂载同 session 时走直接 `session/prompt`；
> 冷启动仍 `session/load(sessionHead)`（CLI 层可表现为 `--resume` 且不 fork）。
作者：基于 2026-09-11 上下文丢失事故根因 + OpenCode / 主流 Agent 对照 + 本仓库代码核对（`feat/settings-usage-quota`）

---

## 0. 背景与事故回顾

### 0.1 事故

2026-09-11 01:26，用户在对话 `tab_mtwfw7pg_0` 中发送「检查一下是否已经齐全能直接跑了」，
该 run（`01a08eee-30fd`）被**裸启动**：args 无 `--resume`、无 `-c`、`--rules` 无对话 replay。
新 session `01a08eee-3136` 的 `chat_history.jsonl` 仅含系统提示 + 单条提问，模型在零上下文
状态下作答，用户 12 秒后取消。

### 0.2 根因链（三层叠加）

1. **前端让位逻辑**（`src/App.tsx` `buildRunArgs` ≈1030–1032）：提交时若 tab 内有 inflight
   气泡（实为 monitor wakeup 触发的 turn），按设计丢弃 `resumeSessionId`，改传
   `parent_run_id` 期望队列解析。
2. **幽灵 parent**：`parent_run_id` 指向 monitor / wakeup 伪 run id，`runs.sqlite` 中不存在
   或未进入 `completed_sessions`。
3. **队列静默降级**（`src-tauri/src/runs/queue.rs` ≈723–734）：出队时仅当 parent 的
   session id 已在内存 `completed_sessions` 才注入 `--resume`；查不到则**静默裸跑**，无报错。

### 0.3 设计结论（产品语义）

对标 OpenCode（及 Codex / Claude Code Desktop 的共识）：

> **一个对话终身绑定一个 session 身份。**  
> 跟进消息是向该 session **追加 prompt**，不是「resume 一条可能被 fork 的 transcript」。  
> fork / branch 永远是**显式用户动作**；运行中跟进排队进**同一**会话；失败要响亮，禁止静默空会话。

OpenCode 的实现要点（本设计直接参照）：

| 概念 | OpenCode | 本仓库应对齐的产品语义 |
|---|---|---|
| 会话身份 | 稳定的 `sessionID`；`prompt({ sessionID })` 恒定打入同一 session | tab/lane → 唯一 `sessionHead`；跟进 = 对常驻 ACP host 再发 `session/prompt` |
| 「resume」一词 | API 里表示「是否唤醒执行循环」，**不是** CLI 式 resume/fork | **禁止**把日常续接叙述成 `--resume` / `--fork-session` |
| 忙时跟进 | 排队进同一 session；或 `SessionBusyError` 响亮失败 | `delivery: queue` 进同一 lane/session；解析失败 → Failed + toast |
| 分支 | 显式 `fork` API | 仅 `forkAssistantResponse` / rewind 失败 rebase |
| Undo | `revert` 指针，消息不删；下次 prompt 前 `cleanup()` | **已改为 Grok native**：点击即引擎 rewind（非 deferred cleanup） |

本仓库现状是 **每 turn 倾向 `--resume` + `--fork-session`，再用 `parent_run_id` 跨进程拼接**。
这与 OpenCode 模型相反，也是事故的结构性温床。

---

## 1. 目标与非目标

### 目标

- **G1** 消灭「静默空会话」：跟进要么进入既有 session，要么响亮失败。
- **G2** 空闲 / 排队跟进默认 **同 session 追加**（OpenCode 语义），不再 per-turn fork。
- **G3** Undo 对齐 **Grok Build native**：点击即同 session rewind；composer 回填 undone prompt；无引擎级 Redo（toast 至多还原草稿 / 文件 stash）。
- **G4** fork 仅两个显式场景：用户主动分支（`forkAssistantResponse`）；rewind 失败时的 rebase 回退。

### 非目标

- 不修改 grok CLI 本体与 ACP 协议（`session/load` 不可倒带仍是硬约束，见
  `src/app/grokArgs.ts` 注释）。
- 不追求「引擎级零 fork 纯度」到 OpenCode 自有引擎那种程度；Desktop 仍通过 ACP 宿主驱动 grok。
- 不改动 chat 模式（非 coding）路径。
- 不在本设计内实现 ACP mid-turn steering（`docs/architecture.md` 已确认外部 ACP 无稳定 steering；
  `steer` 已归一为 `queue`）。

### 术语约定（重要）

| 说法 | 含义 |
|---|---|
| **同 session 追加** | 产品主路径：对已绑定的 session 再次 `session/prompt` |
| **冷启动挂载** | 进程 / host 不在时，用既有 `sessionHead` 重新 `session/load` 挂上（实现上可能出现 CLI `--resume` **且不带** `--fork-session`） |
| **fork** | 显式新开并行分支或 rebase 失败回退；日常跟进禁止 |
| ~~resume 续接~~ | **废弃为产品叙事**；避免与 OpenCode / 用户心智混淆 |

---

## 2. 现状梳理（关键代码位置）

| 关注点 | 位置 | 现状 |
|---|---|---|
| 拼参 | `src/app/grokArgs.ts` `buildGrokArgs` | `resumeSessionId` 默认带 `--fork-session`；`resumeSessionInPlace` / `shareSession` 可抑制 fork（目前主要用于 Edit / live share） |
| run 配置 | `src/App.tsx` `buildRunArgs` ≈1001–1061 | inflight 时置空 `resumeSessionId`，委托 `parent_run_id` |
| 队列注入 | `src-tauri/src/runs/queue.rs` ≈723–734 | 仅查内存 `completed_sessions`；缺失则静默不注入 |
| ACP 宿主 | `queue.rs` prewarm ≈282–327；`core.rs` `session/prompt` | host 可常驻；已具备「同 host 再 prompt」的基础设施，但上层仍按 fork/resume 拼参 |
| Undo | `src/App.tsx` `undoLatestTurn` ≈1514–1586 | 物理删除消息 + `undoSessionPlanRef`（replay 进 `--rules`）+ 异步 rewind |
| Edit | `src/App.tsx` `editLatestTurn` ≈1617+ | 同上；另有 `editResumeSessionInPlaceRef` |
| 分支 | `src/App.tsx` `forkAssistantResponse` ≈1588–1615 | 显式 fork，可保留 |
| Rewind / rebase | `src-tauri/src/runs/core.rs` ≈318–407 | `rewind_last_user_turn*`；失败则 `create_rebased_session` |
| Tab 模型 | `src/lib/tabs.ts`（非 `types.ts`） | 无 `sessionHead` / `revert` |
| 持久化 | `conversations.json`；`runs.sqlite` | 消息删除即丢；`parent_run_id`/`delivery` 已有；`completed_sessions` 仅内存 |

---

## 3. 目标架构：lane → sessionHead → prompt

```
┌─────────────┐     owns      ┌──────────────────┐
│  Tab / lane │ ─────────────▶│  sessionHead     │  （持久：lane_heads + Tab 冗余）
└─────────────┘               └────────┬─────────┘
                                       │
              idle / queued follow-up  │
                                       ▼
                          ┌────────────────────────┐
                          │ 常驻 ACP host（同 lane） │
                          │ session/prompt(同一 id) │
                          └────────────────────────┘

冷启动（host 已死）──▶ session/load(sessionHead) ──▶ 再 prompt
显式 fork / rebase ──▶ 新 sessionHead（唯一允许换身份的路径）
```

### 3.1 Tab 侧字段（`src/lib/tabs.ts`）

```ts
type TabRevertPointer = {
  /** 保留侧最后一条可见消息 id（对齐 OpenCode revert.messageID） */
  messageId: string;
  /** 撤销发生时的 engine session id；commit 时 rewind 该 head */
  grokSessionId: string;
  /** 被撤销 turn 的 runId（诊断 / 失败回退） */
  undoneRunId?: string;
};

interface Tab {
  // ...现有字段
  /** 本对话绑定的 engine session；跟进与冷启动的权威身份 */
  sessionHead?: string | null;
  /** 活跃撤销指针；null = 无撤销 */
  revert?: TabRevertPointer | null;
}
```

- Undo / Edit **不再** `setMessages(preserved)` 物理删消息，只设 `tab.revert`。
- 渲染层按指针过滤（对齐 OpenCode `messagesBeforeRevert`）。
- `conversations.json` 增可选字段；旧数据无 `revert` / `sessionHead` = 兼容。

### 3.2 持久化：`lane_heads`

```sql
CREATE TABLE lane_heads (
    lane_id     TEXT PRIMARY KEY,   -- tabId
    session_id  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);
```

写入时机：每次 run **确认** session id 时（与今日 `completed_sessions.insert` 同批位置：
`queue.rs` ≈885、1089、1118、1144），同步写入 `lane_heads` 并回推前端更新 `tab.sessionHead`。

`completed_sessions`（内存）可保留为「刚结束的 parent run → session」快路径；
**权威身份是 `lane_heads` / `tab.sessionHead`，不是 parent_run 拼接。**

---

## 4. UI / 队列动作 → 引擎映射

| UI 动作 | 目标行为 | 实现要点 |
|---|---|---|
| 空闲跟进 | 同 session 追加 | 若 lane 有活 ACP host → 直接 `session/prompt`；**不要**再走「拼 `--resume` + fork」主路径 |
| 冷启动跟进 | 挂载后追加 | host 不在时 `session/load(sessionHead)` 再 prompt；CLI 层若必须带 flag，仅冷启动挂载，且 **禁止** `--fork-session` |
| 运行中跟进 | 排队进同一 session | `delivery: queue`；出队时解析目标 = `lane_heads` / 活 host 的 session，**不是**「给 args 补 `--resume` 碰运气」 |
| parent 丢失 | 响亮失败 | Failed + toast；可选「用 lane head 重试」 |
| Undo（UI） | 只设指针 + 回填 composer | **不调** engine |
| Redo | 清指针 / 回移指针 | 纯 UI；engine 未动 |
| Undo commit | 下次真正出队前 | `SessionRevert.cleanup` 同构：rewind `revert.grokSessionId`，再物理收紧 UI；此后 redo 失效 |
| Rewind 失败 | rebase 新 session | 保留 `create_rebased_session`；更新 `sessionHead`；replay 经 `--rules`（低频） |
| 用户分支 | 显式 fork | 保留 `forkAssistantResponse`；新 tab 新 `sessionHead` |

### 4.1 与旧「resumeSessionInPlace」的关系

`grokArgs.ts` 里的 `resumeSessionInPlace` **可以**作为冷启动挂载的拼参开关（resume 且不 fork），
但：

1. 产品文档与评审 **不再**把 Phase 1 写成「改成 in-place resume」。
2. 热路径应尽量停在 ACP host 复用 + `session/prompt`，避免每 turn 重新解析 CLI args 身份。
3. 日常跟进成功标准：`session_id` 与 `tab.sessionHead` 相同，且未创建新 session 文件。

### 4.2 cleanup-on-commit（对齐 OpenCode）

- Redo 窗口 = undo 之后 → **下一次 prompt 真正出队之前**。
- commit 时若指针仍在：engine rewind + UI 收紧；然后清 `revert`。
- commit 前若发现 head 已因 monitor wakeup 前进（`prompt_index` / 末 turn 与记录不符）→
  升级为 rebase fork，并提示用户（见 §7）。

---

## 5. Phase 0 — 止血（可独立先行，≈1 天）

即使最终热路径不再依赖「出队注入 `--resume`」，也必须先消灭静默裸跑：

1. **三级解析 + 拒跑**（替换 `queue.rs` ≈731 的静默分支）：

```
target_session =
    活 host / prewarmed session（同 lane）     // 优先：真正的同 session 追加
 ∪∫ lane_heads.get(rec.lane_id)               // 持久身份
 ∪∫ completed_sessions.get(parent_run_id)     // 兼容快路径
 ∪∫ 拒跑：finalize(Failed, "no session head; refusing bare start")
```

2. **`parent_run_id` 校验**：仅接受 `runs` 表存在的 id；monitor / wakeup 伪 id 不得作为 parent
   （`ComposerSection` 传入的 `activeRunId` 前校验；wakeup 气泡 inflight 时改走 lane head，
   而不是伪 parent）。
3. 回归：排队跟进 + parent 丢失 → 断言不再产生无身份的裸跑（`e2e/` + `scripts/fake-grok.sh`）。

Phase 0 已部分朝 OpenCode「响亮失败」对齐；为 Phase 1 热路径改造垫路基。

---

## 6. 分阶段迁移

### Phase 0 — 止血（≈1 天）

见 §5。可独立发布。

### Phase 1 — 同 session 追加 + 指针 Undo/Redo（≈2–3 天）

1. **绑定身份**：`tab.sessionHead` + `lane_heads`；每次确认 session 后回写。
2. **热路径**：空闲 / 排队跟进优先复用 lane 上 ACP host → `session/prompt`；去掉
   「inflight 就丢弃身份、只靠 parent 拼 resume」的主逻辑。
3. **冷启动**：仅此时挂载 `sessionHead`（不 fork）；失败则 Failed，不裸建空会话
   （除非用户显式 New Session）。
4. **Undo** 已从 OpenCode 指针模型改为 **Grok-native eager rewind**（见 Phase 2）。
5. **测试**：`src/__tests__/App.test.tsx` undo 用例对齐 eager rewind；同 session 连续跟进等。

### Phase 2 — 打磨

1. ✅ Rewind 失败 / rebase 的 `--rules` replay 截断与体量上限（`buildConversationReplayBlock`）。
2. ✅ **Undo = Grok-native eager rewind**（`undoLatestTurn` → 立即
   `persistUndoToGrokSession` / `rewind_grok_session`，同 `sessionHead` 截断；
   UI 物理收紧消息，**不再**依赖 `tab.revert` pointer-until-send）。
   引擎优先省略 `conversationOnly`（ACP 默认 `RewindMode::All`）；失败则
   `ConversationOnly` + `file_snapshots` + **shadow-git** 兜底
   （`restore_workspace_on_undo` / `~/.grok-desktop/workspace-snapshots/`）。
   Toast 回填 undone prompt；toast「Undo」仅还原草稿 / AFTER 文件 stash，
   **不**假装对话可 Redo。`commitRevertIfNeeded` 仅作遗留 pointer 安全网。
   见 `src/App.tsx`、`src-tauri/src/runs/{core,shadow_git}.rs`。
   **多级连续 Undo 已落地**（非 tip-only；shadow-git 按 prompt preview 还原边界树）。

3. ✅ Undo 窗口内 head 被 monitor/CLI 推走：引擎 `NewerPrompts` → 自动 rebase，并 toast
   `undoRebasedAfterAdvance`。更细的归属策略仍可继续打磨。
4. ✅ 热路径：活 ACP host 已持有 `sessionHead`（或 prewarm 已 `session/load`）时，
   `run_one_core` 经 `warm_direct_session_id` 直接 `session/prompt`，不再为暖路径支付
   多余的 `session/load`；冷启动仍挂载 `sessionHead`（`--resume` 不 fork）。前端日常跟进
   保持 `resumeSessionInPlace`（OpenCode 同 session 追加）。

---

## 7. 风险与待验证项

1. **多级 Undo 已落地（UI + `kept_prompt_index_for_undo`）**：可对更早已完成
   user 回合执行 Grok native `targetPromptIndex` rewind；UI 自该 user 起截断。
   若 Grok 拒绝 `_x.ai/rewind/execute`，仍走既有 local JSONL truncate / rebase
   退化路径（toast 无 conversation Redo）。重复 preview（如两次「continue」）仍
   `AmbiguousPreview`，避免猜错截断点。
2. **`--rules` replay 体积**：仅留在 rebase 失败分支；Phase 2 加截断。
3. **eager rewind 与 monitor 竞态**：Undo 点击时若 head 已被推走且无法 in-place
   rewind，走 rebase + `undoRebasedAfterAdvance` toast（已落地）。
4. **同 session 追加与 Undo 的张力**：去掉 per-turn fork 后，undo 完全依赖 rewind /
   rebase。可接受，但集成测试必须覆盖两条路径。
5. **ACP host 复用边界（已落地）**：`prewarm_session_key` = `cwd + launch_key(binary)`
   （不含 raw rules）；前端 debounce key = `activeTabId + codingCwd +` 稳定 knobs
   （model / effort / permission / memory / websearch / actionPolicy），**不含**
   `liveSessionId` 与完整 args。`prewarmRun` 仍传完整 `buildRunArgs()` 以便 resume/load。

---

## 8. 评审核对摘要（2026-09-11 代码核对）

| 文档原主张 | 核对结果 |
|---|---|
| inflight 丢弃 resume、靠 parent | **属实**（`App.tsx` `buildRunArgs`） |
| queue 静默裸跑 | **属实**（`queue.rs` 723–734） |
| `resumeSessionInPlace` 已存在 | **属实**，但今日主要用于 Edit，不是日常跟进 |
| Undo 物理删除 | **属实** |
| Tab 在 `types.ts` | **有误** → 实际 `src/lib/tabs.ts` |
| 以「in-place resume」为 Phase 1 主叙事 | **否决（本次修订）** → 改为 OpenCode 同 session 追加 |

---

## 附录 A：对标摘要（非硬需求）

| | 存储 | 续接语义 | 运行中跟进 |
|---|---|---|---|
| OpenCode | SQLite session/message/part | **同 sessionID 追加 prompt**；fork 显式 | 默认进同一 session；忙则错误或排队 |
| Codex | rollout / thread | 同 thread 身份续跑 | steer / 队列 |
| Claude Code | 项目 jsonl | 同 id 追加；`--fork-session` 显式 | 排队同一会话 |
| Cursor | bubble SQLite | 客户端重放历史（无 CLI resume 叙事） | followup 队列 |

OpenCode undo：`revert{messageID, partID?, …}`；消息不删；下次 prompt 前 `cleanup()`。
**Desktop 已不再跟 OpenCode deferred cleanup**——对齐 xai-org/grok-build `/rewind`：
点击即同 session truncate；文件优先 All / 否则 ConversationOnly+shadow-git。

## 附录 B：参考

- 事故 run：`01a08eee-30fd`（幽灵 `parent_run_id`）
- 根 session：`~/.grok/sessions/%2FUsers%2Funtitled/01a08e7b-b4bc-7a70-93f5-07a08cba4fa8/`
- sst/opencode：`packages/opencode/src/session/{session,revert,prompt}.ts`
- 本仓库：`docs/architecture.md`，`src/App.tsx`，`src/app/grokArgs.ts`，
  `src-tauri/src/runs/{queue,core,db}.rs`，`src/lib/tabs.ts`
