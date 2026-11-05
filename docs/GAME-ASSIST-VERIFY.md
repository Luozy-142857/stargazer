# GAME-ASSIST-VERIFY — 辅助层数值行为与构建验证（t3）

- 工作区：`D:\workspace\stargazer`
- 验证对象：t2（assist-engineer）在 `src/game/` 的辅助层实现（assist.ts / gazeFilter.ts / gazeGame.ts 接线）
- 验证者：verify-engineer
- 时间：2026-11-05 17:09–17:15（+08:00）
- 环境：Windows；Node v24.21.0；TypeScript 5.9.3；Vite 6.4.5；无浏览器 / 摄像头实机
- 本次新增：`tools/assist-check.ts`、本报告。**未修改任何业务代码**，也未改项目配置。

## 0. 结论（先看）

| 验证项 | 结果 | 说明 |
| --- | --- | --- |
| 1. `npx tsc --noEmit` | **PASS**（exit 0） | `tsconfig.json` 的 include（`src` + `vite.config.ts`）全通过；`tools/assist-check.ts` 不在 tsconfig 内，由 Node 实际执行验证 |
| 2. `npx vite build` | **FAILED（环境限制，非代码）** | esbuild 启动子进程 `spawn EPERM`；按任务要求记录原始错误并把 tsc 作为构建证据，未改配置 |
| 3. `tools/assist-check.ts` 四项指定断言 | **PASS**（42/42，exit 0） | 见 §2；含 A2/A3 的动态佐证与 A1 静态检查 |
| 4. t2 的 A1–A6 | **A1/A2/A4/A5/A6 PASS；A3 PASS（附带 1 条低风险注释措辞观察）** | 见 §3 |
| 5. 报告 `docs/GAME-ASSIST-VERIFY.md` | **PASS** | 本文 |

总体：t3 的验证工作完成；唯一未拿到的是 Vite 生产构建产物，原因是本机沙箱禁止 esbuild 子进程，不是代码或配置问题。**没有做浏览器 + 摄像头的实机对局验证**，本报告不外推手感结论。

## 1. 运行过的命令与真实输出

### 1.1 类型检查（通过）

```text
> npx tsc --version
Version 5.9.3

> npx tsc --noEmit
(无输出)
TSC_EXIT=0
```

### 1.2 Vite 生产构建（环境失败）

```text
> npx vite build
failed to load config from D:\workspace\stargazer\vite.config.ts
error during build:
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:458:11)
    at Object.spawn (node:child_process:813:9)
    at ensureServiceIsRunning (D:\workspace\stargazer\node_modules\esbuild\lib\main.js:1978:29)
    at build (D:\workspace\stargazer\node_modules\esbuild\lib\main.js:1876:26)
    at bundleConfigFile (file:///D:/workspace/stargazer/node_modules/vite/dist/node/chunks/dep-CkSfqg8D.js:49636:24)
    ...
EXIT=1
```

尝试绕过配置 bundling（不改配置，只加 CLI 参数）仍然失败：

```text
> npx vite build --configLoader runner
failed to load config from D:\workspace\stargazer\vite.config.ts
error during build:
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:458:11)
    at spawn (node:internal/child_process:813:9)
    at Object.execFile (node:child_process:349:17)
    at exec (node:child_process:236:25)
    at optimizeSafeRealPathSync (.../vite/dist/node/chunks/dep-CkSfqg8D.js:6938:3)
    ...
EXIT=1
```

独立性验证：不经过项目配置，直接调用 esbuild 的最小编译也会 EPERM，说明是工具链子进程限制：

```text
> node -e "require('esbuild').transformSync('let x:number=1',{loader:'ts'})"
ESBUILD_ERR spawn EPERM
EXIT=1
```

结论：本机沙箱禁止 esbuild 子进程（提交日志与工具说明都提示了这一点）。`npx tsc --noEmit` 是本次可用的构建/类型证据；`dist/` 仍是 2026-11-04 的旧产物，本次没有刷新。

### 1.3 无头数值回归（通过）

```text
> node tools/assist-check.ts
...
通过 42 条，失败 0 条。
RESULT: PASS
EXIT=0
```

完整命令：

```powershell
cd D:\workspace\stargazer
node tools/assist-check.ts
```

脚本使用 Node 24 的类型剥离直接 `import "../src/game/assist.ts"`，不经过 Vite / esbuild / DOM。t2 留下的 `out/_selftest/*.mjs` 没有作为本报告的证据；本报告使用独立编写的检查脚本。

## 2. 四项指定断言

### 2.1 `captureRadiusDeg` 随得分单调不增 — PASS

- 扫描 `score ∈ [-10, 100]` 步长 0.25（441 个点），再补 `1e6 / 1e9 / ±Infinity / NaN`。
- 所有输出有限，且恒在 `[4.0°, 6.0°]`。
- 单调不增成立：`5.5° (score≤0) → 4.0° (score≥20) → 保持 4.0°`。
- 端点：`score=0 → 5.5°`，`score=20/1e9 → 4.0°`；`NaN/±Infinity/负分` 被实现当作 0 分，返回 5.5°。
- 实际判定用的 `assistCaptureRadiusDeg(score, toward, hitErrors)` 也逐点检查了 18,522 组组合（7 个 toward × 6 组误差样本 × 441 个分数），对 score 单调不增、始终 `[4°, 6°]`，趋势门控/实测误差只会在上限内调整。

对应检查：`C1a–C1f`，全部 PASS。

### 2.2 视线速度为零时 `magnetPull` 返回零位移 — PASS

- 静止注视 600 帧：`offsetMm` 恒为 `(0,0)`，`active=false`，`strength=0`，`reason=no-toward-motion`。
- 视线朝反方向移动 600 帧：位移恒为 0。
- 视线垂直于目标方向移动：朝向投影 = 0，位移恒为 0。
- 距离 7°（> 6.5° 作用半径）时，即使高速朝星星移动也不生效（`out-of-range`）。
- 朝星星速度 1.5°/s（< 2°/s 门槛）不生效。
- 距离 3° 且朝星星 10°/s：双条件同时满足才 `active`，稳态拉拽量 0.600000000°（0.6° 硬上限），方向沿火箭→星星。

这组断言直接证明“不看不吸”：速度为零或方向不对时，磁吸输出严格是零，而不是慢慢把火箭拖过去。对应检查：`C2a–C2i`，全部 PASS。

### 2.3 拉拽量随距离单调不减、零距离为 0 — PASS

这里把“拉拽量”定义为：固定目标距离、视线持续高速（1e6 mm/s）朝目标移动，偏移逐帧回灌 400 帧后的**稳态** `|offsetMm|`（度）。稳态值绕过了每帧 0.1°/0.2° 的淡入限速，量的是设计上的距离依赖。

| 距离 | 稳态拉拽量 |
| --- | --- |
| 0°（火箭=星星） | 0 |
| 0.05° | 0.0125° |
| 2.35° | 0.5875° |
| 2.45° | 0.6° |
| 6.45° | 0.6° |

- 0° 严格为 0（`zero-gap` 分支）。
- 0–2.35° 严格递增；2.4° 附近达到 `min(0.6°, 25%×剩余距离)` 的拐点，之后平台保持在 0.6°。
- 0–6.45° 全区间单调不减；拉拽量从不超过剩余距离。
- **说明**：任务写的是“单调递增”；由于 A3 同时要求单次拉拽有 0.6° 硬上限，数学上不可能在全距离严格递增，因此本报告按“单调不减”验证，并额外验证未饱和区严格递增。这是有界设计的必然结果，不是实现偏离。对应检查：`C3a–C3e`，全部 PASS。

边界观察：名义 6.5° 经 `degToMm → mmToDeg` 往返是 `6.500000000000001°`，会被 `gapDeg > 6.5` 的严格门限判成 `out-of-range`。这是 1e-15 量级的舍入，不影响手感；扫描上限因此取 6.45°，已在脚本 NOTE 中记录。

### 2.4 任意输入下控制输出有限 — PASS

作用域：会进入控制链的 `offsetMm.x / offsetMm.y / strength`；`gapDeg / towardDegPerS` 是诊断字段。对输入坐标本身为 NaN 的情形，角距离数学上无定义，`gapDeg` 可能为 NaN，但不会污染 `offsetMm`。

- 20,000 组有限随机输入（坐标含 ±1e9 mm、速度含 ±1e6 mm/s、距离含 0 / ±1e-9 / 1e9）：五个输出字段全部有限。
- 5,000 组 NaN / ±Infinity 坐标、速度、距离：`offsetMm` 与 `strength` 仍有限、无异常抛出；其中 989 例 `gapDeg=NaN`（输入坐标是 NaN，仅诊断字段）。
- 零 gap、零距离（`distanceMm=0`）、NaN 距离：位移严格为 0 且有限。
- `dtMs` 为 0 / 负数 / NaN / Infinity：位移有限且不超 0.6°。
- 10,000 帧有限输入 + 偏移回灌（随机抖动、换向）：全程有限；总偏移最大 0.600000000°（无棘轮累积）。

对应检查：`C4a–C4h`，全部 PASS。

## 3. t2 的 A1–A6 逐条核对

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| A1 存在 `src/game/assist.ts` 且不含任何 DOM 引用 | **PASS** | 文件存在（420 行）；唯一 import 是 `import type { Pt } from "../types"`；静态扫描 `window/document/canvas/HTMLElement/navigator/localStorage/sessionStorage/requestAnimationFrame` 零命中；`node` 可直接加载并运行 42 条断言；无 `Math.random / Date.now / performance.now`。对应 `C7a–C7d`。 |
| A2 磁吸生效需同时满足“距离阈值 + 视线朝目标运动”，且两条在代码里都是显式的 | **PASS** | `src/game/assist.ts:270` `if (gapDeg > rangeDeg) return idle("out-of-range")`；`:272` `if (!(towardDegPerS >= minToward)) return idle("no-toward-motion")`。动态：静止 / 反向 / 垂直 600 帧位移恒 0；7° 即使高速也不生效；1.5°/s 低于门槛不生效；只有双条件同时满足才 `active`。对应 `C2a–C2i`。 |
| A3 单帧拉拽量有硬上限，且代码里有注释说明 | **PASS（附 1 条低风险观察）** | 生效路径：`min(0.1°/帧 × dtScale, 0.2°硬顶)`，总偏移另受 `min(0.6°, 25%×剩余距离)` 约束（`assist.ts:176-181, 279-290`）。10,000 帧抖动实测：生效中的单帧拉拽量最大 0.200000000°，总偏移最大 0.600000000°。观察：条件失效后的**释放**路径用 `MAGNET_RELEASE_DEG=0.2° × dtScale≤2.5`，单帧可达 0.407°（fuzz 实测），高于 `MAGNET_STEP_HARD_CAP_DEG=0.2`；但释放不是“拉拽”，且 `assist.ts:181` 已注明“比拉入快一倍”。问题只在 `assist.ts:179` 的注释把硬顶写成“单帧偏移变化……无论 dt 多大都不许超过它”，措辞比实现宽。建议 reviewer 判断是否只改注释；不阻塞 A3 的“拉拽有硬顶”结论。 |
| A4 捕获半径随得分单调不增 | **PASS** | `captureRadiusDeg` 441 个分数点单调不增，端点 5.5°→4.0° 且有 4.0° 地板；实际判定用的 `assistCaptureRadiusDeg` 18,522 组组合亦单调不增。对应 `C1a–C1f`。 |
| A5 `npx tsc --noEmit` 通过 | **PASS** | 5.9.3 strict，exit 0，无输出。 |
| A6 未修改 `src/gaze/` 下任何文件 | **PASS** | 工作区没有 `.git`，改用 SHA256 + mtime（t2 报告里也记录了基线 SHA 前缀/后缀）：`metrics.ts` `2C26D32C…E3B`（2026-11-04 21:20:06）、`model.ts` `B5ED5191…DD4`（2026-11-04 21:54:33），与 t2 的基线完全一致，mtime 均早于 t2 开始时间（2026-11-05 16:47）。`src/gaze/` 下没有其他文件。 |

关于 t2 额外声称的 `src/ui/app.ts`：见 §5 的“并发变更”，本次验证开始时它还与基线一致，随后被外部进程改动；A6 本身只要求 `src/gaze/`，不受影响。

## 4. 补充检查（不是任务硬性要求）

脚本还覆盖了辅助层其余纯函数，均 PASS：

- `robustZero`（P1）：30% 离群样本（70 个中心样本 + 30 个 +5.1° 离群）下 `ok=true`、`kept=70`、`MAD=0.2927°`，零位估计 `(0.1071, -0.2466)°`，与真值 `(0.1, -0.2)°` 偏差 < 0.2°；29 样本不提交；±3° 抖动（MAD>1.2°）不提交；空样本 `ok=false`。
- `lockLevel`（锁定反馈）：捕获半径内=1、远处=0、对 gap 单调不增、恒在 `[0,1]`；NaN gap / 非正 captureDeg 返回 0。
- t2 的 `gazeFilter.ts` 时序、游戏内 HUD/提示语位置、加油锚定接线没有在本次脚本中独立复测；它们不在 t3 的四项断言内，只做了代码阅读。

## 5. 工作区状态与并发变更

- `src/game/assist.ts`（20857 B, 17:08:40）、`gazeGame.ts`（34430 B, 17:08:01）、`gazeFilter.ts`（6662 B, 17:06:18）与 t2 完成时一致。
- `src/gaze/metrics.ts`、`src/gaze/model.ts` 与 t2 基线一致（见 A6）。
- **`src/ui/app.ts` 在验证期间被外部进程改动**：
  - 首次检查（17:09 前后）：53233 B，mtime 2026-11-04 22:44:59，SHA256 `B6FDCAA03ECB2C2D3105A9F080B0970809688BFA9B0D86F6B4BE7A1FE7EC7AC8`（与 t2 报告一致）。
  - 17:09:37 变为：53504 B，SHA256 `8501800D5D6EFCD68CC59A46B0F76B0460459647F6542882F6FD797FEA2B3993`。
  - t3 没有写 `app.ts`；改动发生在 t3 的验证窗口内，具体来源无法从本会话的只读状态确认（同一工作区存在其他并发任务）。`currentGaze()`（app.ts:1246-1253）与 `pushFrame()`（app.ts:466-515）当前仍保持“同一相机帧返回同一 `predMm` 对象引用”的语义，`gazeGame` 的 P2 新样本判定依赖这一点，复查当前内容未被破坏；但 app.ts 已不是 t2 完成时的字节，t4 审查时应以工作区当前文件为准。
- 没有 `.git`，无法给 `git status`；A6 用 SHA256 + mtime 证明。

## 6. 未覆盖 / 残余风险

1. **无浏览器实机**：Vite build 被环境挡住，无法生成/打开生产 bundle；未验证摄像头、MediaPipe、全屏切换、60 秒完整对局与真实手感。
2. **释放路径单帧变化**：`magnetPull` 条件失效时回退最多 0.5°/帧（dtScale≤2.5），与 `assist.ts:179` “0.2° 硬顶”的注释不一致；属于观感/注释问题，不影响“生效中的拉拽有硬顶”。
3. **NaN 参数的上游依赖**：`assistCaptureRadiusDeg(score, towardDegPerS=NaN, …)` 会经 `trendWidenFactor(NaN)` 返回 NaN；若上游把 NaN 注视速度传进来，`gazeGame.ts:464-469` 的捕获半径会变成 NaN，`Math.hypot(...) <= NaN` 恒 false（星星永远抓不到）。正常数值链路不应出现 NaN，本轮未构造端到端 NaN 场景；列出供 t4 判断是否需要上层兜底。
4. **6.5° 边界舍入**：见 §2.3，1e-15 量级，不影响判定。
5. **t2 自测与本次验证的独立性**：本报告没有采信 t2 的 `out/_selftest/*.mjs` 结果，全部结论来自 `tools/assist-check.ts` 本次运行；但 gazeFilter 的时序收益（8° 扫视 117ms vs 旧 451ms）本轮未独立复测。

## 7. 复现步骤

```powershell
cd D:\workspace\stargazer

# 1) 类型检查（通过）
npx tsc --noEmit

# 2) 生产构建（本机沙箱会 EPERM；按任务约定记录即可）
npx vite build

# 3) 独立数值回归（42 条，exit 0 即全过）
node tools/assist-check.ts

# 4) 复查测量层未被改动
Get-FileHash src\gaze\metrics.ts,src\gaze\model.ts -Algorithm SHA256
```

## 8. 最终判定

- t3 的四项执行要求：类型检查 PASS；Vite build 因环境 EPERM 失败并已记录（按任务约定改用 tsc 作为构建证据）；无头断言 42/42 PASS 且有明确 PASS/FAIL 与退出码；A1–A6 逐条核对完成（全部 PASS，A3 附低风险注释措辞观察）。
- 未发现需要阻断下游 t4 的数值/构建缺陷。
- 需要 t4 重点看的两点：A3 的释放路径注释是否澄清；`src/ui/app.ts` 在 t2 之后被外部改动，审查应以当前工作区为准。
