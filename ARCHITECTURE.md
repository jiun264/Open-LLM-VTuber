# Open-LLM-VTuber 架構解析

## 1. 專案定位

Open-LLM-VTuber 不是一般的單一聊天機器人，而是一個「語音 + Live2D + 多模態 + Agent + 工具呼叫」的 AI VTuber 專案。

它的核心方向是：

- 提供 WebSocket 端點，讓前端或桌面端與後端進行互動
- 接收語音、文字、圖片等輸入
- 透過 LLM 生成回應
- 轉成語音輸出（TTS）
- 控制 Live2D 表情與動作
- 允許 Agent 在適當時候呼叫外部工具（MCP）

這是一個 roleplay / companion / virtual character 系統，而不是純粹的 coding agent 框架。

---

## 2. 整體架構概覽

從專案入口看，最關鍵的是：

- [run_server.py](run_server.py)：啟動入口，建立 WebSocketServer
- [src/open_llm_vtuber/server.py](src/open_llm_vtuber/server.py)：FastAPI 伺服器，掛載前端、Live2D 靜態資源、WebSocket 路由
- [src/open_llm_vtuber/service_context.py](src/open_llm_vtuber/service_context.py)：系統的依賴注入容器 / 執行上下文
- [src/open_llm_vtuber/config_manager](src/open_llm_vtuber/config_manager)：配置載入與驗證
- [src/open_llm_vtuber/agent](src/open_llm_vtuber/agent)：Agent 抽象、工廠與各種實作
- [src/open_llm_vtuber/conversations](src/open_llm_vtuber/conversations)：對話與音訊處理流程
- [src/open_llm_vtuber/mcpp](src/open_llm_vtuber/mcpp)：MCP 工具系統

高層流程大致是：

1. 啟動 server
2. 讀取 conf.yaml
3. 建立 ServiceContext
4. 依設定初始化：
   - LLM
   - ASR
   - TTS
   - VAD
   - Agent
   - MCP tool chain
5. WebSocket 接收使用者輸入
6. Agent 產生文本/行為
7. 轉成語音、Live2D 表情與動作
8. 回傳到前端

---

## 3. 核心模組

### 3.1 ServiceContext

[service_context.py](src/open_llm_vtuber/service_context.py) 扮演中央容器角色，管理以下執行實體：

- `asr_engine`
- `tts_engine`
- `vad_engine`
- `agent_engine`
- `translate_engine`
- `mcp_server_registery`
- `tool_manager`
- `mcp_client`
- `tool_executor`

它同時負責：

- 自 config 讀取設定
- 建立對話用的 `system_prompt`
- 載入 `mcp_prompt`
- 組裝 Agent 需要的工具資訊

這代表它其實是整個 VTuber runtime 的「裝配中心」。

### 3.2 Agent 系統

Agent 的核心抽象在：

- [src/open_llm_vtuber/agent/agents/agent_interface.py](src/open_llm_vtuber/agent/agents/agent_interface.py)
- [src/open_llm_vtuber/agent/agent_factory.py](src/open_llm_vtuber/agent/agent_factory.py)

可看到：

- `AgentInterface` 定義抽象行為
- `AgentFactory.create_agent(...)` 根據設定建立不同 agent

目前支援：

- `basic_memory_agent`
- `mem0_agent`
- `hume_ai_agent`
- `letta_agent`

這裡的「agent」語義是：

- 可替換的聊天/對話引擎
- 支援不同 LLM 後端
- 可附加記憶、工具調用、外部服務整合

### 3.3 BasicMemoryAgent

最核心實作在：

- [src/open_llm_vtuber/agent/agents/basic_memory_agent.py](src/open_llm_vtuber/agent/agents/basic_memory_agent.py)

這個 agent 不是簡單的單輪聊天器，而是有：

- 內部 memory
- system prompt
- 圖片/文本輸入處理
- 對話歷史回填
- 中斷處理
- 工具呼叫迴圈
- OpenAI / Claude tool calling 兼容
- fallback prompt-mode tool execution

從程式碼可見，它實際會做：

- `_to_messages(...)` 組訊息
- `_openai_tool_interaction_loop(...)`
- `_claude_tool_interaction_loop(...)`
- `chat(...)` 主流程

也就是說，這個 agent 已經具備「工具調用」能力，而不是只是單純聊天。

### 3.4 Live2D (V 皮) 核心背景知識、調用體系與除錯指南

本專案整合了語音對話與 Web Live2D 虛擬形象渲染，以下完整解析 Live2D 模型（V 皮）的規格架構、模型調用流程、技術堆疊與除錯排查指引。

---

#### 1. Live2D V 皮背景知識與檔案規格 (Cubism 3/4)

Live2D 是一套將 2D 平面插畫以網格分割與變形器（Deformer）驅動產生立體動態的技術。在 Web 端運行的標準 Cubism 3/4 模型目錄中，包含以下關鍵檔案：

| 檔案類型 | 典型副檔名 | 說明與用途 |
| :--- | :--- | :--- |
| **模型本體** | `.moc3` | 二進位核心模型檔。記錄所有網格頂點 (ArtMesh)、變形器、參數清單 (Parameters) 及其數值上下限（如 -1.0 到 1.0 或 0.0 到 1.0）。 |
| **模型設定檔** | `.model3.json` | 整個模型的元資料索引（Settings JSON）。宣告 Moc 本體路徑、貼圖集、物理檔、動作組 (`Motions`) 與表情清單 (`Expressions`)。**Web SDK 僅會讀取此檔內有宣告的資源**。 |
| **參數顯示字典** | `.cdi3.json` | Combined Display Info。將工程參數 ID（如 `Param132`、`Param149`）對應為人類可讀名稱（如「慌張」、「害羞」），供 Live2D Editor 與開發者檢視比對。 |
| **物理運算檔** | `.physics3.json` | 物理演算設定。驅動頭髮、衣服裙擺、飾品隨頭部擺動的即時慣性物理模擬。 |
| **表情預設檔** | `.exp3.json` | 表情設定檔。記錄觸發表情時要覆寫或疊加哪些參數（如臉紅、流淚、黑臉）。 |
| **動作曲線檔** | `.motion3.json` | 關鍵幀動態檔。記錄一段時間內各參數的貝茲曲線變化（如待機呼吸、點頭、揮手）。 |
| **貼圖圖集** | `*.4096/texture_*.png` | 將原畫拆件後排版生成的 Atlas 貼圖集，供 WebGL 進行貼圖渲染。 |
| **第三方設定檔** | `.vtube.json` | **VTube Studio** 專用設定檔。記錄面部捕捉按鍵熱鍵（Hotkeys）、表情綁定與視訊映射。此檔**不屬於** Cubism 官方標準，Web SDK 不會直接讀取它。 |

##### 表情檔 (`.exp3.json`) 的混色機制 (Blend Types)
每個表情檔的核心是一組 `Parameters`：
```json
{
  "Type": "Live2D Expression",
  "FadeInTime": 0.3,
  "FadeOutTime": 0.3,
  "Parameters": [
    { "Id": "Param132", "Value": 1.0, "Blend": "Overwrite" }
  ]
}
```
Cubism SDK 支援三種參數混色模式：
- **`Add` (Additive, 0)**：數值累加（`目標值 = 當前值 + Value`）。常配合預設值為 0 的開關參數。
- **`Multiply` (1)**：數值相乘（`目標值 = 當前值 * Value`）。常用於縮放眼睛開闔大小。
- **`Overwrite` (2)**：強制覆寫（`目標值 = Value`）。**在有待機動作循環 (Idle Motion) 時，建議使用 Overwrite，避免被動作動畫沖掉**。

---

#### 2. 模型調用全鏈路工作流 (LLM 到 WebGL 渲染)

從使用者輸入文字或語音，到畫面上 V 皮產生對應表情，經歷以下四個階段：

```mermaid
sequenceDiagram
    participant User as 使用者
    participant LLM as 後端 LLM
    participant Server as FastAPI (live2d_model.py)
    participant WS as WebSocket 通道
    participant Front as 前端 React (useLive2DExpression)
    participant SDK as Web Live2D Cubism SDK

    User->>LLM: 提問 / 語音互動
    Note over LLM: 注入 live2d_expression_prompt
    LLM-->>Server: 輸出回應文字 (夾帶情緒標籤如 [fear])
    Note over Server: 1. 正則解析 [fear]<br/>2. 查表 model_dict.json 的 emotionMap: "fear" -> 3<br/>3. 過濾 [fear] 標籤後送 TTS 合成
    Server-->>WS: 發送 Payload { audio, text, actions: { expressions: [3] } }
    WS-->>Front: 接收動作訊號 expressions: [3]
    Front->>Front: useLive2DExpression 觸發
    Front->>SDK: LAppAdapter.getExpressionName(3) -> 取得 "panic"
    Front->>SDK: LAppModel.setExpression("panic")
    Note over SDK: CubismExpressionMotionManager 加載 panic.exp3.json<br/>在每幀 update() 中計算 FadeWeight 並覆寫 Param132
    SDK-->>Front: WebGL 重新繪製渲染出「慌張」表情
```

##### 階段細節：
1. **後端情緒決策與 Prompt 注入**：
   - 系統在組裝 System Prompt 時載入 `prompts/live2d_expression_prompt`。
   - 要求 LLM 在回覆文本中附加情緒標籤（如 `[joy]`, `[fear]`, `[sadness]`, `[anger]` 等）。
2. **後端情緒標籤解析與映射 ([live2d_model.py](src/open_llm_vtuber/live2d_model.py))**：
   - `extract_emotion(text)` 提取標籤中的關鍵字。
   - 根據 `model_dict.json` 中該角色的 `emotionMap`（例如 `"fear": 3`）轉換為表情數字索引。
   - `remove_emotion_keywords(text)` 在送給 Edge-TTS / 語音合成前剔除標籤，避免 TTS 念出中括號文字。
   - 將動作資訊打包入 WebSocket 訊息：`{ actions: { expressions: [3] } }`。
3. **前端 WebSocket 接收與調度 ([frontend/assets/main-*.js](frontend/assets/main-nu7uwxNJ.js))**：
   - 前端接收到音訊時同步解包 `actions.expressions`。
   - 呼叫 `useLive2DExpression` Hook：
     - 若傳入為索引數字，呼叫 `LAppAdapter.getExpressionName(index)`（依賴 `.model3.json` 中 `Expressions` 陣列的順序）。
     - 取得表情名稱後呼叫 `LAppModel.setExpression(expressionName)`。
4. **Cubism SDK 運行時每幀更新**：
   - 在主渲染循環（`LAppModel.prototype.update`）中：
     ```javascript
     this._model.loadParameters(); // 1. 還原上一幀基本參數
     this._motionManager.updateMotion(this._model, deltaTime); // 2. 待機/動作動畫更新
     this._model.saveParameters(); // 3. 儲存動作後參數
     this._expressionManager.updateMotion(this._model, deltaTime); // 4. 表情疊加/覆寫
     this._model.update(); // 5. 物理模擬與變形計算
     this._model.draw(matrix); // 6. WebGL 著色器繪製上屏
     ```

---

#### 3. 使用語言與工具鏈體系

- **後端技術**：
  - **Python 3.10+**：核心業務邏輯、文字處理、情緒標籤提取。
  - **FastAPI / Starlette**：提供 ASGI HTTP 伺服器，掛載靜態目錄（`/avatars`、`/live2d-models`）並提供 WebSocket 通訊。
  - **Uvicorn**：高效能非同步伺服器驅動。
  - **PyYAML / JSON**：處理 `conf.yaml` 與 `model_dict.json`。
- **前端技術**：
  - **TypeScript / JavaScript (ES6+)**：前端控制與狀態管理。
  - **React 18**：UI 介面、音訊撥放隊列、`useLive2DExpression` 與 `useLive2DModel` 生命週期管理。
  - **Web Live2D Cubism 4 SDK for Web**：
    - `CubismFramework`：官方核心框架。
    - `CubismModelSettingJson`：解析 `.model3.json`。
    - `CubismExpressionMotion` / `CubismExpressionMotionManager`：表情解析與混合運算。
    - `WebGLRenderingContext`：瀏覽器 Canvas 硬體加速渲染。
- **模型設計與格式工具**：
  - **Live2D Cubism Editor**：官方建模與動作製作軟體，輸出 `.moc3`、`.model3.json`、`.cdi3.json`。
  - **VTube Studio**：常見的主播面捕軟體，隨附 `.vtube.json`（可作為提取表情參數對應的參考字典）。
- **診斷與排查工具**：
  - **Node.js**：跨平台快速驗證 JSON 結構、路徑解析與參數一致性。
  - **瀏覽器 DevTools (F12)**：檢視 Console 日誌（`[APP]expression: [name]`）與 Network 請求（`.exp3.json` 載入狀態）。

---

#### 4. Live2D 表情無反應的除錯排查全流程 (Debug Guide)

當後端 log 顯示已成功辨識情緒（如 `[fear]`），但畫面上的模型卻完全沒有表情變化時，請依序檢查以下 6 大常見故障點：

##### 故障點 1：`model_dict.json` 中的 `url` 路徑指向錯誤
- **原因**：前端需要經由 HTTP 下載模型資源。如果 `model_dict.json` 寫成 `"url": "/avatars/薇薇安/薇薇安.model3.json"`，但後端伺服器實際只掛載了 `characters/` 目錄，前端會發生 404，模型根本未正常載入對應路徑的檔案。
- **排查**：檢查瀏覽器 DevTools -> Network，確認 `.model3.json` 與貼圖的 HTTP 狀態碼是否皆為 200。

##### 故障點 2：`model3.json` 內根本沒有註冊 `Expressions`（0 Expressions 陷阱）
- **原因**：Web Live2D SDK **不會**自動掃描目錄底下的 `.exp3.json`。如果資料夾內有表情檔，但 `薇薇安.model3.json` 的 `FileReferences.Expressions` 陣列為空：
  - `getExpressionCount()` 回傳 0。
  - `getExpressionName(3)` 回傳 `""`（空字串）。
  - `setExpression("")` 靜默失敗，不拋錯但也無任何效果。
- **排查**：打開 `model3.json`，確認 `FileReferences.Expressions` 是否包含各個表情，例如：
  ```json
  "Expressions": [
    { "Name": "shy", "File": "shy.exp3.json" },
    { "Name": "cry", "File": "cry.exp3.json" },
    { "Name": "darkface", "File": "darkface.exp3.json" },
    { "Name": "panic", "File": "panic.exp3.json" },
    { "Name": "eyeroll", "File": "eyeroll.exp3.json" }
  ]
  ```
  並且其索引順序（0: shy, 1: cry, 2: darkface, 3: panic...）必須與 `model_dict.json` 的 `emotionMap` 完全吻合！

##### 故障點 3：表情檔內的參數 ID 在模型中根本不存在
- **原因**：許多網路下載的 V 皮，其表情檔是從其他模型複製過來的，或是建模師後來改過參數名稱。例如表情檔寫了 `Param132`，但模型的 `cdi3.json` / `moc3` 裡只有 `ParamEyeLOpen`。若參數 ID 不存在，SDK 寫入時會找不到目標 Parameter 而忽略。
- **排查**：比對 `cdi3.json` 的 `Parameters[].Id` 與 `.exp3.json` 的 `Parameters[].Id`。

##### 故障點 4：待機動作動畫覆寫了表情參數 (Motion Overwrite 衝突)
- **原因**：
  - 模型通常有待機動畫（如 `Scene1.motion3.json` 被設定在 `Motions.Idle`）。
  - 如果待機動畫在每一幀都給予 `Param141` 曲線數值（例如設為 0），而表情檔使用 `"Blend": "Add"`，加上的數值會在動畫下一幀循環時被動作曲線覆蓋或重置。
- **排查與解法**：
  - 將 `.exp3.json` 中的混色模式由 `"Blend": "Add"` 改為 `"Blend": "Overwrite"`。
  - 確保參數數值設為有效值（如 `1.0`）。

##### 故障點 5：中文檔名編碼與系統語系問題 (Windows CP950 / URL 編碼)
- **原因**：
  - 表情檔案若命名為簡體中文（如 `慌张.exp3.json`、`伞关闭.exp3.json`），在繁體中文 Windows (CP950) 環境下執行 Python / 系統命令時會拋出 `UnicodeEncodeError`。
  - 前端瀏覽器 `fetch("/avatars/薇薇安/慌张.exp3.json")` 會進行 URI 編碼，若 Web 伺服器對中文路徑未正確解碼，會導致 HTTP 404 或 500。
- **排查與解法**：將表情檔一律重新命名為純 ASCII 英文檔名（如 `panic.exp3.json`、`umbrella_close.exp3.json`），並同步更新 `model3.json` 中的檔名參照。

##### 故障點 6：靜態表情 vs. 動態表情機制
- **說明**：
  - 「臉紅 (shy)」、「黑臉 (darkface)」、「白眼 (eyeroll)」通常是單一開關參數，只需修改 1 個參數數值（`Value: 1.0`）即可立刻在畫面上顯現。
  - 「慌張汗滴 (panic)」、「流淚 (cry)」在精細模型中往往是連續畫幅（由 `Param141`, `Param142`, `Param143` 依序變化形成動畫）。若只靠靜態表情檔將其全部設為 1，畫面只會出現靜止的汗水貼圖；要實現流動汗滴，需要配合動態播放動作（Motion）或在待機動畫中循環播放對應曲線。

---

##### 實用一鍵診斷腳本 (Node.js)

可在專案目錄下執行以下腳本，快速檢驗目前使用模型的表情健康狀態：

```javascript
// check_live2d.js
const fs = require('fs');
const path = require('path');

const charDir = path.join(__dirname, 'avatars', '薇薇安');
const cdi = JSON.parse(fs.readFileSync(path.join(charDir, '薇薇安.cdi3.json'), 'utf8'));
const model = JSON.parse(fs.readFileSync(path.join(charDir, '薇薇安.model3.json'), 'utf8'));

const cdiParamMap = new Map();
(cdi.Parameters || []).forEach(p => cdiParamMap.set(p.Id, p.Name));
console.log(`[CDI] 總參數數量: ${cdiParamMap.size}`);

const expressions = model.FileReferences?.Expressions || [];
console.log(`[Model3] 註冊表情數量: ${expressions.length}`);
expressions.forEach((expr, idx) => {
  const expPath = path.join(charDir, expr.File);
  const exists = fs.existsSync(expPath);
  console.log(`  [索引 ${idx}] 名稱: ${expr.Name} | 檔案: ${expr.File} | 存在: ${exists}`);
  if (exists) {
    const data = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    (data.Parameters || []).forEach(p => {
      console.log(`    -> 參數: ${p.Id} (${cdiParamMap.get(p.Id) || '未知'}) | 混合: ${p.Blend} | 數值: ${p.Value}`);
    });
  }
});
```

---

#### 5. 前後端完整 Debug 方法與實戰排查工作流

當遭遇「模型表情沒反應」、「動作無法切換」或「連線異常」時，請依據以下端到端標準排查流程進行診斷：

##### 【步驟一：後端基礎設施與網路排查】
1. **確認真實監聽連接埠**：
   - 檢查 `conf.yaml` 中的 `system_config.port`（預設可能非 8000，例如本專案配置為 `12393`）。
   - 執行命令確認服務程序與連接埠狀態：
     ```powershell
     netstat -ano | findstr ":12393"
     ```
   - 避免常見的「連接埠被佔用陷阱」（例如本機 8000 常被 Incredibuild 等系統服務佔據，導致瀏覽器訪問報錯 `ERR_EMPTY_RESPONSE`）。
2. **檢視後端路由與靜態掛載 (`server.py`)**：
   - 確認 `AvatarStaticFiles` 是否開放了 `.exp3.json`, `.model3.json`, `.motion3.json`。
   - 確認 `app.mount("/avatars", ...)` 是否能讀取目標目錄。
3. **驗證情緒字典與 Prompt 注入 (`live2d_model.py` & `service_context.py`)**：
   - 檢查 `model_dict.json` 中目標模型的 `name` 與 `conf.yaml` 的 `live2d_model_name` 是否一致。
   - 檢查 `self.live2d_model.emo_str` 是否生成正確的情緒清單並成功替換進系統提示詞的 `[<insert_emomap_keys>]`。

##### 【步驟二：前端瀏覽器與 Console 即時調試】
在瀏覽器打開網頁（`http://localhost:12393`），按 `F12` 開啟開發者工具：

1. **Network（網路）標籤頁**：
   - 過濾 `.json` 或 `.exp3.json`。
   - 確認在對話觸發情緒時，瀏覽器是否有發出表情檔的 HTTP GET 請求，且回傳 `200 OK`（若為 404 代表路徑或檔名有誤）。
2. **Console（控制台）全域調試指令**：
   專案在前端掛載了便於即時驗證的除錯介面：
   - **檢查模型實例與註冊數量**：
     ```javascript
     const adapter = window.getLAppAdapter();
     const model = adapter.getModel();
     console.log("註冊表情數量:", model._expressions.getSize());
     for (let i = 0; i < model._expressions.getSize(); i++) {
       console.log(`索引 ${i}:`, model._expressions._keyValues[i]?.first);
     }
     ```
   - **手動強制切換表情（繞過 LLM 直接測試模型響應）**：
     ```javascript
     // 透過名稱調用
     adapter.setExpression("panic");    // 觸發慌張
     adapter.setExpression("shy");      // 觸發害羞
     adapter.setExpression("darkface"); // 觸發黑臉
     adapter.setExpression("eyeroll");  // 觸發白眼

     // 透過數字索引調用
     adapter.setExpression(3);
     ```
   - **使用系統內建動作調試工具 (`window.Live2DDebug`)**：
     ```javascript
     Live2DDebug.getMotionInfo();            // 查看所有可用動作群組
     Live2DDebug.playMotion("Idle", 0, 3);   // 強制播放指定動作
     ```

##### 【步驟三：模型設定檔與動作映射擴展（如「傘關閉」案例）】
當模型具備特殊道具或專屬表情（例如本模型的 `傘關閉 / umbrella_close`），但系統從不觸發時：
1. **問題根源**：
   - 表情雖然在 `model3.json` 註冊了索引 `5`（`umbrella_close.exp3.json`），但 `model_dict.json` 的 `emotionMap` 僅映射了常見的 7 種通用情緒（`neutral`, `fear`, `joy`...）。
   - LLM 沒有接收到對應標籤指示，因此不可能輸出觸發代碼。
2. **擴展設定方法**：
   - 在 `model_dict.json` 的 `emotionMap` 補齊映射條目：
     ```json
     "emotionMap": {
         "neutral": 0,
         "anger": 2,
         "disgust": 4,
         "fear": 3,
         "joy": 0,
         "smirk": 4,
         "sadness": 1,
         "surprise": 3,
         "umbrella": 5,
         "close_umbrella": 5
     }
     ```
   - 重啟伺服器後，System Prompt 會自動多出 `[umbrella]` 標籤。當 LLM 對話提及雨傘收合或感到不需要撐傘時，即會輸出 `[umbrella]`，後端轉為索引 `5` 並由前端自動調用收傘表情。

---



---

## 4. MCP / tool chain

此專案確實有 MCP 相關功能，代表它已經有「Agent 可以叫工具」的能力。

關鍵檔案：

- [src/open_llm_vtuber/service_context.py](src/open_llm_vtuber/service_context.py)
- [src/open_llm_vtuber/mcpp/tool_adapter.py](src/open_llm_vtuber/mcpp/tool_adapter.py)
- [src/open_llm_vtuber/mcpp/tool_manager.py](src/open_llm_vtuber/mcpp/tool_manager.py)
- [src/open_llm_vtuber/mcpp/tool_executor.py](src/open_llm_vtuber/mcpp/tool_executor.py)

工作流是：

1. `use_mcpp` + `mcp_enabled_servers` 打開 MCP
2. `ServiceContext._init_mcp_components()` 啟動 MCP registry / tool manager
3. `ToolAdapter.get_tools(...)` 動態抓取服務器工具列表
4. 將工具轉成 OpenAI / Claude 格式
5. `BasicMemoryAgent` 在對話中檢測 tool call
6. `ToolExecutor` 執行工具
7. 把結果塞回 LLM 做下一輪推理

配置上也明確存在：

- [conf.yaml](conf.yaml)
- [config_templates/conf.default.yaml](config_templates/conf.default.yaml)

其中有：

```yaml
basic_memory_agent:
  use_mcpp: True
  mcp_enabled_servers: ["time", "ddg-search"]
```

所以，結論是：

- 這個專案本來就已經有 Agent 功能
- 而且有 MCP/工具調用能力
- 它不是沒有 agent，而是 agent 目標偏「角色對話 + 工具使用」

---

## 5. Agent 的本質：角色互動 Agent，不是 coding agent

Open-LLM-VTuber 的 agent 是「對話型 agent」：

- 角色設定（persona prompt）
- 顏文字/語氣控制
- AI 角色行為
- 聊天記憶
- 文字輸出
- TTS
- Live2D 表情
- 對話中斷處理

這和 Claw Code Parity 的 coding agent 不同。

Claw Code Parity 更像是：

- 一個 coding workflow orchestrator
- 有多 agent / 任務切分 / query loops / tool routing
- 更偏「自動寫程式、讀檔、執行、驗證」
- 具備 planning / execution / recovery / command graph 的設計

Open-LLM-VTuber 則是：

- 一個角色型 AI runtime
- 以語音交互作為主體
- 讓 AI 可以說話、聽聲音、看畫面、做表情
- 目的是角色感、互動體驗、虛擬陪伴

所以它已經具備 agent 的抽象能力，但不是同一層級的 coding autonomy。

---

## 6. 能不能加成像 Claw Code Parity 那樣的 agent？

### 結論：可以加，但不是無痛升級；需要重新定義「Agent 的任務層級」。

如果目標是「讓 VTuber 變成像 Claw Code 一樣的 coding agent / auto-task executor」，目前專案已有基礎條件：

- Agent factory
- 替換 LLM backend
- Tool execution framework
- MCP integration
- 可擴充的 system prompt

但缺的是：

1. 任務型工作流（Task / Command / Plan / ReAct / loop）
2. 多 agent 協作（不是一個單一聊天 agent）
3. 狀態機式運行（待辦、進度、失敗回復、驗證）
4. code/tool execution 統一抽象
5. 針對程式碼基礎設施的工具集合（讀檔、修檔、測試、git）
6. 具體的「代理決策層」而不是僅角色聊天

換句話說：

- 這個專案已經有 agent 介面與 MCP
- 但若要做成 Claw Code parity 那種 agent，還需要新增一層「task-oriented runtime」

---

## 7. 這個專案的最終評估

### 7.1 已具備的能力

- Agent 抽象
- 多種 agent 實作
- LLM provider 抽象
- MCP 工具呼叫
- 對話記憶
- VAD / ASR / TTS / Live2D 整合
- 角色 prompt 驅動

### 7.2 尚未具備的能力

- coding agent workflow
- multi-agent orchestration
- 自主任務拆解與執行
- 進度追蹤與回復迴圈
- 自動驗證 / 測試執行
- 以程式碼編輯為核心的工具鏈

### 7.3 真正答案

如果問「本來就已經有 agent 功能了嗎？」

答案是：

- 是的，已經有。
- 但這個 agent 屬於「語音角色聊天 Agent + MCP 工具呼叫 Agent」
- 不是 Claw Code 那種「coding orchestration agent」

如果問「能不能做成 Claw Code 那種 agent？」

答案是：

- 可以做，但需要在現有架構上再加一層任務工作流與 orchestrator
- 不能僅靠現有 `BasicMemoryAgent` 直接等價替代

---

## 8. 一句話總結

Open-LLM-VTuber 的架構其實很成熟：它已經把 Agent、LLM、MCP、ASR、TTS、Live2D、對話歷史串在一起，這代表它已經達到「可互動 VTuber + 工具型 AI」的水準。

但它的 Agent 本質是「角色式對話 agent」，不是「自主 coding agent」。

要做成像 Claw Code Parity 那種 agent，仍然需要擴展任務管線、工具執行器、工作流狀態機和多 agent 協調，而不是只改設定檔。
