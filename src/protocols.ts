/** 测试协议定义。全是纯数据，方便后续改参数或做成配置界面。 */
import type { Pt } from "./types";

export type StepKind = "calib" | "validate" | "fixation" | "pursuit" | "deviation" | "rest";

export interface Step {
  id: string;
  kind: StepKind;
  /** 屏幕提示（给受试者/家长看） */
  label: string;
  /** 步骤总时长 ms */
  ms: number;
  /** 该步骤是否计入采集 */
  collect?: boolean;
  /** 前 N ms 不采集，等注视稳定 */
  settleMs?: number;
  /** 归一化目标位置，相对测试画布 0..1 */
  at?: Pt;
  /** 动态目标 */
  path?: (t01: number) => Pt;
}

const CAL_X = [0.13, 0.5, 0.87];
const CAL_Y = [0.15, 0.5, 0.85];
void CAL_X;
void CAL_Y;

/**
 * 13 点：中心 → 4 个格心 → 4 个边中 → 4 个角。
 *
 * 顺序按难度递增。原来是"中心之后直接跳左下角"，实测前 5 个点误差
 * 8.3/5.8/3.2/3.3/6.2°，后 8 个点只有 1–4°——受试者在头几个点还没进入状态。
 */
const CAL_POINTS: Pt[] = [
  { x: 0.5, y: 0.5 },
  { x: 0.315, y: 0.325 },
  { x: 0.685, y: 0.325 },
  { x: 0.685, y: 0.675 },
  { x: 0.315, y: 0.675 },
  { x: 0.5, y: 0.15 },
  { x: 0.87, y: 0.5 },
  { x: 0.5, y: 0.85 },
  { x: 0.13, y: 0.5 },
  { x: 0.13, y: 0.15 },
  { x: 0.87, y: 0.15 },
  { x: 0.87, y: 0.85 },
  { x: 0.13, y: 0.85 },
];

/** 留出验证点：中偏外围，避开 13 个校准点。
 *  不能放太靠中心——之前放在 (±3°, ±2.4°) 处，读数好看但没有代表性。 */
const VALIDATION_POINT: Pt = { x: 0.24, y: 0.62 };

/**
 * 练习：五点位走两轮，用与校准完全相同的时长和姿势，只是不计分。
 *
 * 实测发现受试者在头几个校准点误差高达 8°，越往后越好——是"边做边学"。
 * 一轮热身不足以进入状态，所以做两轮，且第二轮明确要求"保持住"。
 */
export function buildWarmupSteps(): Step[] {
  const cycle: Pt[] = [
    { x: 0.5, y: 0.5 },
    { x: 0.13, y: 0.15 },
    { x: 0.87, y: 0.15 },
    { x: 0.87, y: 0.85 },
    { x: 0.13, y: 0.85 },
  ];
  const path = [...cycle, ...cycle, { x: 0.5, y: 0.5 }];
  return path.map((p, i) => ({
    id: `warm-${i}`,
    kind: "rest" as const,
    label:
      i < cycle.length
        ? `练习 1 / 2 · 光点跳到哪，眼睛就看到哪（不计分）`
        : i < cycle.length * 2
          ? `练习 2 / 2 · 保持住，头不要动（不计分）`
          : "准备开始正式校准",
    ms: 1200,
    collect: false,
    at: p,
  }));
}

export function buildCalibrationSteps(): Step[] {
  return CAL_POINTS.map((p, i) => ({
    id: `calib-${i}`,
    kind: "calib" as const,
    label: `校准 ${i + 1} / ${CAL_POINTS.length} · 双眼看着光点`,
    ms: 1300,
    collect: true,
    settleMs: 500,
    at: p,
  }));
}

export function buildValidationStep(): Step {
  return {
    id: "validate-0",
    kind: "validate",
    label: "验证点 · 双眼看着光点（此点不参与拟合）",
    ms: 1400,
    collect: true,
    settleMs: 500,
    at: VALIDATION_POINT,
  };
}

/** 偏斜监测：中心注视 45s，带极轻微漂移防止注意力涣散 */
export function buildDeviationSteps(): Step[] {
  return [
    {
      id: "dev-watch",
      kind: "deviation",
      label: "平静地看着中心光点，正常睁眼，不要刻意用力",
      ms: 45000,
      collect: true,
      settleMs: 1500,
      path: (t01: number) => ({
        x: 0.5 + 0.012 * Math.sin((t01 * 45) / 1.3),
        y: 0.5 + 0.012 * Math.cos((t01 * 45) / 1.7),
      }),
    },
  ];
}

/** 注视稳定性：中心 12s */
export function buildFixationSteps(): Step[] {
  return [
    {
      id: "fix-center",
      kind: "fixation",
      label: "盯住中心光点，尽量保持不动",
      ms: 12000,
      collect: true,
      settleMs: 1200,
      at: { x: 0.5, y: 0.5 },
    },
  ];
}

/** 水平追随：0.2Hz 正弦，幅度约 ±7°，15s */
export function buildPursuitSteps(): Step[] {
  const freq = 0.2;
  return [
    {
      id: "pursuit-h",
      kind: "pursuit",
      label: "眼睛跟着光点走，头不要动",
      ms: 15000,
      collect: true,
      settleMs: 1500,
      path: (t01: number) => ({
        x: 0.5 + 0.18 * Math.sin(2 * Math.PI * freq * (t01 * 15)),
        y: 0.5,
      }),
    },
  ];
}

/**
 * 重复性测试：同一姿势连续测 N 轮，看读数自己跟自己差多少。
 *
 * 不需要任何外部真值——这是没有棱镜时唯一能拿到的量化指标，
 * 而它恰好回答"能不能跟踪训练效果"这个问题（精密度而非准确度）。
 */
export function buildRepeatabilitySteps(repeats = 5, holdMs = 15000, gapMs = 4000): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < repeats; i++) {
    steps.push({
      id: `repgap-${i}`,
      kind: "rest",
      label: `第 ${i + 1} / ${repeats} 轮 · 可以眨眼、放松一下`,
      ms: gapMs,
      collect: false,
      at: { x: 0.5, y: 0.5 },
    });
    steps.push({
      id: `rep-${i}`,
      kind: "fixation",
      label: `第 ${i + 1} / ${repeats} 轮 · 盯住中心光点，别动`,
      ms: holdMs,
      collect: true,
      settleMs: 1200,
      at: { x: 0.5, y: 0.5 },
    });
  }
  return steps;
}
