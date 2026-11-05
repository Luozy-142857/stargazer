#!/usr/bin/env python3
"""
校准诊断台：用原始几何离线重跑不同特征设计，一次定下建模方案。

背景：
    拟合残差 2.97°、交叉验证中位 4.0° / 最大 12.9°，
    意味着"模型连训练点都拟不到 3° 以内"——这是特征表达力问题，不是调参问题。
    在线改一次代码只能试一种假设，所以这里把原始几何搬下来批量试。

需要会话 JSON 里带 frames（含 raw）。程序里校准那份现在总会带上。

用法：
    python tools/analyze_calibration.py out/stargazer-xxx-calibration-*.json
    python tools/analyze_calibration.py out/*.json --alpha 0.15
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
from statistics import mean

DEG = math.pi / 180.0
RAD = 180.0 / math.pi


# ----------------------------------------------------------------- 数学

def angular_error_deg(pred, target, d_mm):
    def unit(p):
        n = math.hypot(p[0], p[1], max(d_mm, 1))
        return (p[0] / n, p[1] / n, max(d_mm, 1) / n)

    a, b = unit(pred), unit(target)
    dot = max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b))))
    return math.degrees(math.acos(dot))


def _affine_gain(y, p):
    """一维最小二乘 y ≈ a + g·p，返回 (g, a)。用来还原岭回归造成的尺度收缩。"""
    mp = mean(p)
    my = mean(y)
    sxx = sum((v - mp) ** 2 for v in p)
    if sxx < 1e-12:
        return 1.0, 0.0
    sxy = sum((y[i] - my) * (p[i] - mp) for i in range(len(y)))
    g = sxy / sxx
    return g, my - g * mp


def solve_linear(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-12:
            continue
        M[col], M[piv] = M[piv], M[col]
        dv = M[col][col]
        for c in range(col, n + 1):
            M[col][c] /= dv
        for r in range(n):
            if r == col:
                continue
            f = M[r][col]
            if f == 0.0:
                continue
            for c in range(col, n + 1):
                M[r][c] -= f * M[col][c]
    return [row[n] for row in M]


class RidgeDecoupled:
    """
    两个输出各自拟合，横向只用 u 类特征、纵向只用 v 类特征。

    目的：纵向漂移在数学上不可能影响横向读数。
    实测证据——某次重复性测试里 v 漂移 0.010（≈2° 纵向上移），
    横向读数却变了 3.5°，而 u 只变了 0.002。那 3.2° 是 u·v 交叉项串进去的。
    """

    def __init__(self, alpha=0.05, head_idx=(), pen_scale=None):
        self.rx = Ridge(alpha, (), pen_scale)
        self.ry = Ridge(alpha, (), pen_scale)

    def fit(self, Xx, Xy, yx, yy):
        # Ridge 本来就把两个输出独立求解，这里顺便把不用的那个喂零向量
        self.rx.fit(Xx, yx, [0.0] * len(yx))
        self.ry.fit(Xy, [0.0] * len(yy), yy)
        return self

    def predict(self, fx, fy):
        return (self.rx.predict(fx)[0], self.ry.predict(fy)[1])


class Ridge:
    """与前端 model.ts 逐行对齐的实现，保证在线离线同一套口径。"""

    HEAD_DEAD_DEG = 2.0

    def __init__(self, alpha=0.05, head_idx=(), pen_scale=None):
        self.alpha = alpha
        # 哪些列是头位角。必须由变体显式声明——曾经硬编码成 {6..10}，
        # 结果把"三次项"和"瞳距项"也当头位角判死了，C≡B、D≡I 全是假象。
        self.head_idx = set(head_idx)
        # 每个特征额外的惩罚倍数。用来压住"几乎不变但会被标准化放大"的特征，
        # 既保留它吸收冗余变异的收益，又不让它主导预测。
        self.pen_scale = dict(pen_scale or {})
        self.mu = []
        self.sd = []
        self.dead = []
        self.wx = []
        self.wy = []
        self.gx = 1.0
        self.gy = 1.0
        self.ax = 0.0
        self.ay = 0.0
        self.fitted = False

    def fit(self, X, yx, yy):
        n = len(X[0])
        cnt = len(X)
        self.mu = [0.0] * n
        self.sd = [1.0] * n
        self.dead = [False] * n
        sd_raw = [0.0] * n
        for j in range(1, n):
            self.mu[j] = mean(row[j] for row in X)
            sd_raw[j] = math.sqrt(
                sum((row[j] - self.mu[j]) ** 2 for row in X) / max(1, cnt - 1)
            )
            self.sd[j] = sd_raw[j] if sd_raw[j] > 1e-9 else 1.0
        # 头位几乎没动 → 相关特征全是噪声，直接判死
        for j in self.head_idx:
            if j < n and sd_raw[j] < self.HEAD_DEAD_DEG * DEG:
                self.dead[j] = True
        if 6 in self.head_idx and 9 < n and self.dead[6]:
            self.dead[9] = True
        if 7 in self.head_idx and 10 < n and self.dead[7]:
            self.dead[10] = True

        Z = [
            [1.0 if j == 0 else (0.0 if self.dead[j] else (row[j] - self.mu[j]) / self.sd[j])
             for j in range(n)]
            for row in X
        ]
        XtX = [[0.0] * n for _ in range(n)]
        Xtyx = [0.0] * n
        Xtyy = [0.0] * n
        for i, z in enumerate(Z):
            for a in range(n):
                za = z[a]
                if za == 0.0:
                    continue
                Xtyx[a] += za * yx[i]
                Xtyy[a] += za * yy[i]
                for b in range(a, n):
                    XtX[a][b] += za * z[b]
        for a in range(n):
            for b in range(a):
                XtX[a][b] = XtX[b][a]
        tr, free = 0.0, 0
        for a in range(1, n):
            if not self.dead[a]:
                tr += XtX[a][a]
                free += 1
        pen = (self.alpha * tr / free) if free else 0.0
        for a in range(1, n):
            if not self.dead[a]:
                XtX[a][a] += pen * self.pen_scale.get(a, 1.0)
        XtX[0][0] += 1e-9
        self.wx = solve_linear(XtX, Xtyx)
        self.wy = solve_linear(XtX, Xtyy)
        self.fitted = True

        # 去收缩校正：岭回归会把系数整体缩小，预测被拉向均值，
        # 表现就是"中心还行、边缘越来越偏"。用一次一维最小二乘把
        # 尺度与偏置还原，形状的稳定性仍然由岭回归保证。
        pxs = [self._raw_predict(row)[0] for row in X]
        pys = [self._raw_predict(row)[1] for row in X]
        self.gx, self.ax = _affine_gain(yx, pxs)
        self.gy, self.ay = _affine_gain(yy, pys)
        return self

    def _raw_predict(self, row):
        x = y = 0.0
        for j, v in enumerate(row):
            z = 1.0 if j == 0 else (0.0 if self.dead[j] else (v - self.mu[j]) / self.sd[j])
            x += z * self.wx[j]
            y += z * self.wy[j]
        return (x, y)

    def predict(self, row):
        rx, ry = self._raw_predict(row)
        return (self.ax + self.gx * rx, self.ay + self.gy * ry)


# ----------------------------------------------------------------- 特征变体

def _uv_wh(fr, s):
    r = fr["raw"][s]
    return (r["ix"] - r["cx"]) / max(r["w"], 1e-6), (r["iy"] - r["cy"]) / max(r["h"], 1e-6)


def _uv_ipd(fr, s):
    r = fr["raw"][s]
    ipd = max(fr.get("eyesDistPx") or 1e-6, 1e-6)
    return (r["ix"] - r["cx"]) / ipd, (r["iy"] - r["cy"]) / ipd


# ---- 解耦变体：横向只吃 u，纵向只吃 v
def fx_u2(fr, s):
    u, _ = _uv_wh(fr, s)
    return [1.0, u, u * u]


def fy_v2(fr, s):
    _, v = _uv_wh(fr, s)
    return [1.0, v, v * v]


def fx_u3(fr, s):
    u, _ = _uv_wh(fr, s)
    return [1.0, u, u * u, u ** 3]


def fy_v3(fr, s):
    _, v = _uv_wh(fr, s)
    return [1.0, v, v * v, v ** 3]


def feat_A(fr, s):  # 当前线上方案
    u, v = _uv_wh(fr, s)
    hd = fr["head"]
    return [1.0, u, v, u * u, v * v, u * v, hd["yaw"], hd["pitch"], hd["roll"],
            u * hd["yaw"], v * hd["pitch"], (fr.get("eyesDistPx") or 0) / 1000.0]


def feat_B(fr, s):  # 改用头固定的尺度归一化，去掉头位项
    u, v = _uv_ipd(fr, s)
    return [1.0, u, v, u * u, v * v, u * v]


def feat_C(fr, s):  # B + 三次项（虹膜位移 ~ sin θ，三次项是 asin 的低阶近似）
    u, v = _uv_ipd(fr, s)
    return [1.0, u, v, u * u, v * v, u * v, u ** 3, v ** 3, u * u * v, u * v * v]


def feat_D(fr, s):  # 眼宽/睑裂归一化 + 三次项
    u, v = _uv_wh(fr, s)
    return [1.0, u, v, u * u, v * v, u * v, u ** 3, v ** 3, u * u * v, u * v * v]


def feat_E(fr, s):  # 瞳距归一化 + 二次 + 头位项
    u, v = _uv_ipd(fr, s)
    hd = fr["head"]
    return [1.0, u, v, u * u, v * v, u * v, hd["yaw"], hd["pitch"], hd["roll"],
            u * hd["yaw"], v * hd["pitch"], (fr.get("eyesDistPx") or 0) / 1000.0]


def feat_H(fr, s):  # 眼宽二次 + 瞳距项，不含头位
    u, v = _uv_wh(fr, s)
    return [1.0, u, v, u * u, v * v, u * v, (fr.get("eyesDistPx") or 0) / 1000.0]


def feat_I(fr, s):  # 眼宽二次，纯几何
    u, v = _uv_wh(fr, s)
    return [1.0, u, v, u * u, v * v, u * v]


HEAD_FEATS = {6, 7, 8, 9, 10}  # A / E 的头位特征列
IPD_AT = 11  # A / E 里瞳距项在第 11 列；H 里在第 6 列


def _h(pen=None):
    return (feat_H, feat_H, False, (), {6: pen} if pen else {})


VARIANTS = {
    "A 线宽+二次+头位": (feat_A, feat_A, False, HEAD_FEATS, {}),
    "B 瞳距+二次": (feat_B, feat_B, False, (), {}),
    "E 瞳距+二次+头位": (feat_E, feat_E, False, HEAD_FEATS, {}),
    "F 解耦 u二次/v二次": (fx_u2, fy_v2, True, (), {}),
    "I 线宽二次纯几何": (feat_I, feat_I, False, (), {}),
    "H 瞳距项 ×1": _h(None),
    "H 瞳距项 ×10": _h(10),
    "H 瞳距项 ×50": _h(50),
    "H 瞳距项 ×200": _h(200),
}


def fit_model(spec, Xx, Xy, yx, yy, alpha):
    fx, fy, dec, head_idx, pen = spec
    if dec:
        return RidgeDecoupled(alpha, head_idx, pen).fit(Xx, Xy, yx, yy)
    return Ridge(alpha, head_idx, pen).fit(Xx, yx, yy)


def model_predict(m, spec, fxrow, fyrow):
    if spec[2]:
        return m.predict(fxrow, fyrow)
    return m.predict(fxrow)


def ipd_sensitivity_pd(m, spec, u0, v0, ipd0, d_mm, frac=0.02):
    """距离变化 frac 时，横向输出会偏多少 PD。"""

    def row(builder, ipd):
        return builder(
            {
                "raw": {
                    "imageLeft": {"ix": u0 * ipd, "iy": v0 * ipd, "cx": 0.0, "cy": 0.0,
                                  "w": ipd, "h": ipd},
                },
                "eyesDistPx": ipd,
                "head": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0},
                "targetMm": {"x": 0.0, "y": 0.0},
            },
            "imageLeft",
        )

    fx, fy = spec[0], spec[1]
    x0 = model_predict(m, spec, row(fx, ipd0), row(fy, ipd0))[0]
    x1 = model_predict(m, spec, row(fx, ipd0 * (1 + frac)), row(fy, ipd0 * (1 + frac)))[0]
    deg = math.degrees(math.atan2(x1 - x0, max(d_mm, 1)))
    return 100.0 * math.tan(math.radians(deg))


def drift_sensitivity_pd(m, spec, u0, v0, ipd0, d_mm, dv=0.010):
    """
    纵向虹膜偏移 dv 会带来多少横向伪偏移（PD）。

    直接把 u 固定在均值、只动 v，看模型横向输出的变化。
    耦合模型不为 0（u·v 交叉项泄漏），解耦模型应为 0。
    """

    def row(builder, u, v):
        return builder(
            {
                "raw": {
                    "imageLeft": {"ix": u * ipd0, "iy": v * ipd0, "cx": 0.0, "cy": 0.0,
                                  "w": ipd0, "h": ipd0},
                },
                "eyesDistPx": ipd0,
                "head": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0},
                "targetMm": {"x": 0.0, "y": 0.0},
            },
            "imageLeft",
        )

    fx = spec[0]
    fy = spec[1]
    x0 = model_predict(m, spec, row(fx, u0, v0), row(fy, u0, v0))[0]
    x1 = model_predict(m, spec, row(fx, u0, v0 + dv), row(fy, u0, v0 + dv))[0]
    deg = math.degrees(math.atan2(x1 - x0, max(d_mm, 1)))
    return 100.0 * math.tan(math.radians(deg))


# ----------------------------------------------------------------- 数据

def load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def pick_session(paths):
    """优先挑带 frames 的校准会话。"""
    best = None
    for p in paths:
        try:
            s = load(p)
        except (OSError, json.JSONDecodeError):
            continue
        if s.get("schema") != "stargazer.session/1":
            continue
        has = bool(s.get("frames"))
        if best is None or (has and not best[1]):
            best = (p, has, s)
    return best


def group_by_step(frames):
    out = {}
    for fr in frames:
        st = fr.get("step")
        if not st or not fr.get("raw") or not fr.get("targetMm"):
            continue
        if fr.get("quality", {}).get("ok") is False:
            continue
        for side in ("imageLeft", "imageRight"):
            if not fr["raw"].get(side):
                continue
        out.setdefault(st, []).append(fr)
    return out


def loo_eval(spec, grouped, side, d_mm, alpha):
    """留一点交叉验证：每次扣掉一个校准点重拟合，预测被扣掉的点。"""
    steps = sorted(
        [s for s in grouped if s.startswith(calib_prefix)],
        key=lambda x: int(x.split("-")[1]),
    )
    if SKIP_EARLY:
        steps = steps[SKIP_EARLY:]
    errs = {}
    for held in steps:
        train = [fr for s in steps if s != held for fr in grouped[s]]
        held_frames = grouped[held]
        if len(train) < 40:
            continue
        Xx = [spec[0](fr, side) for fr in train]
        Xy = [spec[1](fr, side) for fr in train]
        yx = [fr["targetMm"]["x"] for fr in train]
        yy = [fr["targetMm"]["y"] for fr in train]
        try:
            m = fit_model(spec, Xx, Xy, yx, yy, alpha)
        except Exception as exc:  # 不再静默：失败必须可见，否则会得到一堆 nan
            print(f"  [跳过 {held}] 拟合失败：{exc!r}", file=sys.stderr)
            continue
        preds = [
            model_predict(m, spec, spec[0](fr, side), spec[1](fr, side))
            for fr in held_frames
        ]
        if not preds:
            continue
        mx = mean(p[0] for p in preds)
        my = mean(p[1] for p in preds)
        tgt = held_frames[0]["targetMm"]
        errs[held] = angular_error_deg((mx, my), (tgt["x"], tgt["y"]), d_mm)
    return errs


calib_prefix = "calib-"
SKIP_EARLY = 0


def median(xs):
    xs = sorted(xs)
    if not xs:
        return float("nan")
    n = len(xs)
    return xs[n // 2] if n % 2 else 0.5 * (xs[n // 2 - 1] + xs[n // 2])


def _sd(xs):
    if len(xs) < 2:
        return float("nan")
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def selftest() -> int:
    """合成一份"已知正确"的校准数据，验证分组/拟合/交叉验证整条链路。"""
    import random

    random.seed(3)
    pts = [
        (0.5, 0.5), (0.13, 0.15), (0.87, 0.15), (0.87, 0.85), (0.13, 0.85),
        (0.5, 0.15), (0.87, 0.5), (0.5, 0.85), (0.13, 0.5),
        (0.315, 0.325), (0.685, 0.325), (0.685, 0.675), (0.315, 0.675),
    ]
    frames = []
    for i, (nx, ny) in enumerate(pts):
        tx = (nx - 0.5) * 336.0
        ty = (ny - 0.5) * 210.0
        for k in range(25):
            raw = {}
            for side in ("imageLeft", "imageRight"):
                # 真实映射：u,v 线性正比于屏幕毫米 + 已知量级噪声
                u = 1.2e-4 * tx + random.gauss(0, 8e-5)
                v = 1.2e-4 * ty + random.gauss(0, 8e-5)
                w, hh, cx, cy = 80.0, 30.0, 400.0, 300.0
                raw[side] = {"ix": cx + u * w, "iy": cy + v * hh,
                             "cx": cx, "cy": cy, "w": w, "h": hh}
            frames.append({
                "t": k * 33, "step": f"calib-{i}", "eyesDistPx": 120.0,
                "targetMm": {"x": tx, "y": ty},
                "head": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0},
                "quality": {"ok": True}, "raw": raw,
            })
    grouped = group_by_step(frames)
    if len(grouped) != len(pts):
        print(f"  FAIL 分组：期望 {len(pts)} 点，实际 {len(grouped)}")
        return 1
    ok = True
    for name, spec in VARIANTS.items():
        meds = []
        for alpha in (0.0, 0.05, 0.15, 0.4):
            vals = []
            for side in ("imageLeft", "imageRight"):
                vals.extend(loo_eval(spec, grouped, side, 500.0, alpha).values())
            meds.append(median(vals))
        exact = meds[0] < 0.05                      # α=0 时数据完全线性，必须几乎精确
        monotone = all(meds[i] <= meds[i + 1] + 1e-6 for i in range(len(meds) - 1))
        default_ok = meds[1] < 0.4                  # 默认 α=0.05 的扭曲要可接受
        good = exact and monotone and default_ok
        ok = ok and good
        print(
            f"  {'PASS' if good else 'FAIL'} {name:<20}"
            + "".join(f" a={a:<5}{m:>7.3f}°" for a, m in
                      zip((0.0, 0.05, 0.15, 0.4), meds))
        )
    print(
        "自检通过：α=0 精确 → 求解器与特征正确；随 α 单调变差 → 正则化按预期工作；"
        "默认 α=0.05 的扭曲在容差内"
        if ok
        else "自检失败"
    )
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="校准诊断台：比较不同特征设计")
    ap.add_argument("inputs", nargs="*", default=["out"])
    ap.add_argument("--alpha", type=float, default=0.05)
    ap.add_argument("--side", default="both", choices=["both", "imageLeft", "imageRight"])
    ap.add_argument("--selftest", action="store_true", help="用合成数据验证分析链路")
    ap.add_argument(
        "--skip-early",
        type=int,
        default=0,
        help="跳过前 N 个校准点（用于验证'开局未进入状态'假设）",
    )
    args = ap.parse_args()

    global SKIP_EARLY
    SKIP_EARLY = args.skip_early

    if args.selftest:
        return selftest()

    paths = []
    for p in args.inputs:
        if os.path.isdir(p):
            paths.extend(sorted(glob.glob(os.path.join(p, "*.json"))))
        elif any(c in p for c in "*?["):
            paths.extend(sorted(glob.glob(p)))
        else:
            paths.append(p)

    picked = pick_session(paths)
    if not picked:
        print("没有找到符合 schema 的会话文件", file=sys.stderr)
        return 1
    path, has_frames, sess = picked
    print(f"会话：{os.path.basename(path)}")
    if not has_frames:
        print("\n这份文件没有 frames，无法诊断。", file=sys.stderr)
        print("重新校准一次即可——校准那份现在会自动带上原始几何。", file=sys.stderr)
        return 1

    cfg = sess.get("config", {})
    d_mm = float(cfg.get("distanceCm", 50)) * 10.0
    grouped = group_by_step(sess["frames"])
    if not grouped:
        print("frames 里没有可用的校准点", file=sys.stderr)
        return 1

    sides = ["imageLeft", "imageRight"] if args.side == "both" else [args.side]

    # ---- 1) 头位漂移
    print("\n=== 头位漂移（整段校准） ===")
    yaws = [fr["head"]["yaw"] * RAD for fr in sess["frames"] if fr.get("head")]
    pitches = [fr["head"]["pitch"] * RAD for fr in sess["frames"] if fr.get("head")]
    if yaws:
        print(f"  yaw   {min(yaws):+.1f}° ~ {max(yaws):+.1f}°   跨度 {max(yaws)-min(yaws):.1f}°")
        print(f"  pitch {min(pitches):+.1f}° ~ {max(pitches):+.1f}°   跨度 {max(pitches)-min(pitches):.1f}°")
        if max(yaws) - min(yaws) > 5:
            print("  ⚠ 头位跨度偏大，会直接污染映射，建议加下巴托或重做")

    # ---- 2) 每个点的原始几何
    print("\n=== 每点原始几何（u = 虹膜相对眼中心的偏移 / 归一化尺度） ===")
    hdr = f"{'点':<10}{'目标H°':>8}{'目标V°':>8}{'瞳距px':>9}"
    for s in sides:
        tag = "L" if s == "imageLeft" else "R"
        hdr += f"{tag+'u':>9}{tag+'v':>9}"
    print(hdr)
    ipd_all = []
    for st in sorted(grouped, key=lambda x: int(x.split("-")[1])):
        fs = grouped[st]
        tgt = fs[0]["targetMm"]
        th = math.degrees(math.atan2(tgt["x"], d_mm))
        tv = math.degrees(math.atan2(tgt["y"], d_mm))
        ipd = mean(fr.get("eyesDistPx") or 0.0 for fr in fs)
        ipd_all.append(ipd)
        line = f"{st:<10}{th:>8.1f}{tv:>8.1f}{ipd:>9.1f}"
        for s in sides:
            us, vs = [], []
            for fr in fs:
                u, v = _uv_wh(fr, s)
                us.append(u)
                vs.append(v)
            line += f"{mean(us):>9.3f}{mean(vs):>9.3f}"
        print(line)
    if ipd_all:
        lo, hi = min(ipd_all), max(ipd_all)
        spread = (hi - lo) / lo if lo else 0
        print(
            f"  瞳距像素范围 {lo:.1f} ~ {hi:.1f}，相对变化 {100 * spread:.1f}%"
            f" → 观看距离变化约 {100 * spread:.1f}%"
        )
        if spread > 0.08:
            print("  ⚠ 距离在采集过程中变化超过 8%：靶点角度按固定距离换算会标错真值")

    # ---- 3) 变体对比
    print(f"\n=== 特征设计对比（留一点交叉验证，alpha={args.alpha}） ===")
    print(f"{'变体':<22}{'中位°':>8}{'最大°':>8}{'v漂移PD':>12}{'距离2%PD':>12}  最差点")
    results = {}
    for name, spec in VARIANTS.items():
        all_err = {}
        for s in sides:
            tag = "L" if s == "imageLeft" else "R"
            for st, e in loo_eval(spec, grouped, s, d_mm, args.alpha).items():
                all_err[(st, tag)] = e
        vals = list(all_err.values())
        if not vals:
            continue
        med = median(vals)
        mx = max(vals)
        worst_key = max(all_err, key=all_err.get)

        # 纵向漂移敏感度：在全部校准数据上重拟合，看 v 变化 0.010 时
        # 横向输出跟着动多少（PD）。耦合模型不为 0，解耦模型应为 0。
        drifts = []
        ipd_sens = []
        all_frames = [fr for st in grouped for fr in grouped[st]]
        for s in sides:
            Xx = [spec[0](fr, s) for fr in all_frames]
            Xy = [spec[1](fr, s) for fr in all_frames]
            yx = [fr["targetMm"]["x"] for fr in all_frames]
            yy = [fr["targetMm"]["y"] for fr in all_frames]
            try:
                m = fit_model(spec, Xx, Xy, yx, yy, args.alpha)
            except Exception:
                continue
            us = [_uv_wh(fr, s)[0] for fr in all_frames]
            vs = [_uv_wh(fr, s)[1] for fr in all_frames]
            ipd0 = mean(fr.get("eyesDistPx") or 1.0 for fr in all_frames)
            drifts.append(drift_sensitivity_pd(m, spec, mean(us), mean(vs), ipd0, d_mm))
            ipd_sens.append(ipd_sensitivity_pd(m, spec, mean(us), mean(vs), ipd0, d_mm))
        drift_pd = max(drifts) if drifts else float("nan")
        ipd_pd = max(ipd_sens) if ipd_sens else float("nan")

        results[name] = (med, mx, all_err, drift_pd)
        print(
            f"{name:<22}{med:>8.2f}{mx:>8.2f}{drift_pd:>12.2f}{ipd_pd:>12.2f}"
            f"  {worst_key[0]}/{worst_key[1]}"
        )

    if not results:
        print("  没有可评估的变体", file=sys.stderr)
        return 1

    best_name = min(results, key=lambda k: results[k][0])
    bmed, bmx, best_err, bdrift = results[best_name]
    print(f"\n中位最优：{best_name}   中位 {bmed:.2f}° / 最大 {bmx:.2f}° / 漂移伪偏移 {bdrift:.2f} PD")
    calm = min(results, key=lambda k: abs(results[k][3]))
    cmed, cmx, _, cdrift = results[calm]
    print(f"漂移最不敏感：{calm}   中位 {cmed:.2f}° / 最大 {cmx:.2f}° / 漂移伪偏移 {cdrift:.2f} PD")

    # ---- 4) 逐点明细：区分"某些点坏了"还是"整体不够"
    print(f"\n=== 逐点明细（{best_name}） ===")
    print(f"{'点':<12}{'帧数':>6}{'L_u_sd':>9}{'R_u_sd':>9}{'L_err°':>8}{'R_err°':>8}")
    for st in sorted(grouped, key=lambda x: int(x.split("-")[1])):
        fs = grouped[st]
        cells = f"{st:<12}{len(fs):>6}"
        for s in ("imageLeft", "imageRight"):
            us = [_uv_wh(fr, s)[0] for fr in fs]
            cells += f"{_sd(us):>9.4f}"
        for tag in ("L", "R"):
            e = best_err.get((st, tag))
            cells += f"{e:>8.2f}" if e is not None else f"{'—':>8}"
        print(cells)
    print("  u_sd = 该点内 u 的帧间标准差；大 = 注视不稳或虹膜点抖动，小 = 系统误差")

    # ---- 5) 不对称诊断
    print("\n=== 不对称诊断 ===")
    left = [e for k, e in best_err.items() if k[1] == "L"]
    right = [e for k, e in best_err.items() if k[1] == "R"]
    if left and right:
        print(f"  图像左眼 中位 {median(left):.2f}°   图像右眼 中位 {median(right):.2f}°")
    half = {"左半屏": [], "右半屏": []}
    for (st, tag), e in best_err.items():
        tgt = grouped[st][0]["targetMm"]
        half["左半屏" if tgt["x"] < 0 else "右半屏"].append(e)
    for k, v in half.items():
        if v:
            print(f"  {k} 中位 {median(v):.2f}°  (n={len(v)})")
    if half["左半屏"] and half["右半屏"]:
        a, b = median(half["左半屏"]), median(half["右半屏"])
        if a > 1.5 * b or b > 1.5 * a:
            print("  ⚠ 左右半屏误差不对称：先查光照/头位/屏幕反光")

    print("\n判读：")
    print("  中位 ≤1.5°  → 可用，直接做测试")
    print("  中位 1.5–2.5° → 勉强可用，报告里必须注明")
    print("  中位 >2.5°  → 先查逐点明细：个别点坏 ≠ 整体不够")
    return 0


if __name__ == "__main__":
    sys.exit(main())
