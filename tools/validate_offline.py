#!/usr/bin/env python3
"""
离线验证台（纯标准库，无需 numpy）。

用途：把导出的会话 JSON 与临床金标准（棱镜遮盖试验 / 医生判读）对照，
给出 Bland-Altman 一致性、相关系数，以及一份可直接贴进报告的文字摘要。

为什么必须是"一致性"而不是"精度"：
    1.5° 是一个孤立数字，审评和医生都无法判断它意味着什么；
    "与棱镜遮盖试验相比，95% 一致性界限为 ±X PD" 才是可验证、可复现的表述。

用法：
    python tools/validate_offline.py session.json
    python tools/validate_offline.py sessions/*.json --gt ground_truth.csv -o out/
    python tools/validate_offline.py --self-test
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import os
import sys
from statistics import mean, median, stdev

# 与前端 metrics.ts 保持一致的换算
def deg_to_pd(deg: float) -> float:
    return 100.0 * math.tan(math.radians(deg))


def pd_to_deg(pd: float) -> float:
    return math.degrees(math.atan(pd / 100.0))


def bcea(points, p: float = 0.6827) -> float:
    """与前端同一公式：A = -2π·σ1·σ2·ln(1-p)"""
    n = len(points)
    if n < 5:
        return float("nan")
    mx = mean(x for x, _ in points)
    my = mean(y for _, y in points)
    sxx = sum((x - mx) ** 2 for x, _ in points) / (n - 1)
    syy = sum((y - my) ** 2 for _, y in points) / (n - 1)
    sxy = sum((x - mx) * (y - my) for x, y in points) / (n - 1)
    tr = sxx + syy
    det = sxx * syy - sxy * sxy
    disc = max(0.0, tr * tr / 4 - det)
    l1 = tr / 2 + math.sqrt(disc)
    l2 = max(1e-12, tr / 2 - math.sqrt(disc))
    return -2 * math.pi * math.sqrt(max(l1, 1e-12)) * math.sqrt(l2) * math.log(1 - p)


# ----------------------------------------------------------------- 读取

def load_sessions(pattern: str) -> list[dict]:
    paths: list[str] = []
    for p in pattern:
        if os.path.isdir(p):
            paths.extend(sorted(glob.glob(os.path.join(p, "*.json"))))
        elif any(ch in p for ch in "*?["):
            paths.extend(sorted(glob.glob(p)))
        else:
            paths.append(p)
    out = []
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  跳过 {path}：{exc}", file=sys.stderr)
            continue
        if data.get("schema") != "stargazer.session/1":
            print(f"  跳过 {path}：schema 不匹配", file=sys.stderr)
            continue
        data["_path"] = path
        out.append(data)
    return out


def measured_pd(sess: dict) -> float | None:
    """
    从会话里取"偏斜角估计值"：所有偏斜监测测试中，两眼 medianAbsPd 的最大值。
    取最大值是因为生理上只有一只眼在注视，另一只眼的偏移才是偏斜量。
    """
    best = None
    for t in sess.get("tests", []):
        if t.get("kind") != "deviation":
            continue
        vals = [
            abs(e["medianAbsPd"])
            for e in t.get("eyes", [])
            if e.get("medianAbsPd") is not None
        ]
        if not vals:
            continue
        m = max(vals)
        best = m if best is None else max(best, m)
    return best


def load_gt(path: str) -> dict[str, float]:
    out = {}
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            raise SystemExit("ground truth CSV 没有表头")
        key = None
        for cand in ("case_id", "case", "id", "subject"):
            if cand in reader.fieldnames:
                key = cand
                break
        val = None
        for cand in ("ref_pd", "prism_pd", "gt_pd", "pd"):
            if cand in reader.fieldnames:
                val = cand
                break
        if not key or not val:
            raise SystemExit(
                f"CSV 缺少列：需要 case_id 与 ref_pd，实际为 {reader.fieldnames}"
            )
        for row in reader:
            try:
                out[row[key].strip()] = float(row[val])
            except (TypeError, ValueError):
                continue
    return out


# ----------------------------------------------------------------- 统计

def bland_altman(pairs: list[tuple[float, float]]) -> dict:
    """
    pairs: [(measured, reference)]
    diff = measured - reference
    """
    if len(pairs) < 3:
        return {"n": len(pairs)}
    diffs = [m - r for m, r in pairs]
    bias = mean(diffs)
    sd = stdev(diffs)
    loa_lo, loa_hi = bias - 1.96 * sd, bias + 1.96 * sd
    means_ = [(m + r) / 2 for m, r in pairs]
    # 与均值是否有比例偏倚
    mx, my = mean(means_), mean(diffs)
    sxx = sum((x - mx) ** 2 for x in means_)
    sxy = sum((x - mx) * (y - my) for x, y in zip(means_, diffs))
    slope = sxy / sxx if sxx > 1e-12 else float("nan")
    return {
        "n": len(pairs),
        "bias_pd": bias,
        "sd_pd": sd,
        "loa_low_pd": loa_lo,
        "loa_high_pd": loa_hi,
        "loa_low_deg": pd_to_deg(loa_lo),
        "loa_high_deg": pd_to_deg(loa_hi),
        "bias_slope": slope,
    }


def pearson(pairs: list[tuple[float, float]]) -> float:
    if len(pairs) < 3:
        return float("nan")
    xs = [r for _, r in pairs]
    ys = [m for m, _ in pairs]
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx < 1e-12 or syy < 1e-12:
        return float("nan")
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(sxx * syy)


def ccc(pairs: list[tuple[float, float]]) -> float:
    """Lin 一致性相关系数：同时惩罚系统偏倚与尺度差异。"""
    if len(pairs) < 3:
        return float("nan")
    xs = [r for _, r in pairs]
    ys = [m for m, _ in pairs]
    mx, my = mean(xs), mean(ys)
    vx = sum((x - mx) ** 2 for x in xs) / (len(xs) - 1)
    vy = sum((y - my) ** 2 for y in ys) / (len(ys) - 1)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (len(xs) - 1)
    denom = vx + vy + (mx - my) ** 2
    return (2 * cov) / denom if denom > 1e-12 else float("nan")


# ----------------------------------------------------------------- 绘图

def svg_plot(pairs: list[tuple[float, float]], stats: dict, path: str) -> None:
    W, H = 720, 460
    pad_l, pad_r, pad_t, pad_b = 64, 24, 32, 56
    means_ = [(m + r) / 2 for m, r in pairs]
    diffs = [m - r for m, r in pairs]
    xs = means_ + [stats.get("loa_low_pd", 0), stats.get("loa_high_pd", 0)]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(diffs + [stats.get("loa_low_pd", 0)]), max(
        diffs + [stats.get("loa_high_pd", 0)]
    )
    x_pad = max(1.0, (x_max - x_min) * 0.08)
    y_pad = max(1.0, (y_max - y_min) * 0.12)
    x_min -= x_pad
    x_max += x_pad
    y_min -= y_pad
    y_max += y_pad

    def sx(v):
        return pad_l + (v - x_min) / (x_max - x_min) * (W - pad_l - pad_r)

    def sy(v):
        return H - pad_b - (v - y_min) / (y_max - y_min) * (H - pad_t - pad_b)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" font-family="-apple-system,Segoe UI,sans-serif">',
        f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
        f'<rect x="{pad_l}" y="{pad_t}" width="{W - pad_l - pad_r}" '
        f'height="{H - pad_t - pad_b}" fill="none" stroke="#cbd5e1"/>',
    ]

    def hline(v, color, dash, label):
        y = sy(v)
        parts.append(
            f'<line x1="{pad_l}" y1="{y:.2f}" x2="{W - pad_r}" y2="{y:.2f}" '
            f'stroke="{color}" stroke-width="1.5" stroke-dasharray="{dash}"/>'
        )
        parts.append(
            f'<text x="{W - pad_r + 2}" y="{y + 4:.2f}" font-size="10" '
            f'fill="{color}" text-anchor="end" dx="-6">{label}</text>'
        )

    if "bias_pd" in stats:
        hline(0, "#94a3b8", "2 4", "")
        hline(stats["bias_pd"], "#2563eb", "", f"bias {stats['bias_pd']:+.1f}")
        hline(stats["loa_high_pd"], "#dc2626", "6 4", f"+1.96SD {stats['loa_high_pd']:+.1f}")
        hline(stats["loa_low_pd"], "#dc2626", "6 4", f"-1.96SD {stats['loa_low_pd']:+.1f}")

    for m, r in pairs:
        parts.append(
            f'<circle cx="{sx((m + r) / 2):.2f}" cy="{sy(m - r):.2f}" r="4" '
            f'fill="#0f172a" fill-opacity="0.75"/>'
        )

    for i in range(5):
        v = x_min + (x_max - x_min) * i / 4
        parts.append(
            f'<text x="{sx(v):.1f}" y="{H - pad_b + 18}" font-size="11" '
            f'fill="#475569" text-anchor="middle">{v:.0f}</text>'
        )
    for i in range(5):
        v = y_min + (y_max - y_min) * i / 4
        parts.append(
            f'<text x="{pad_l - 10}" y="{sy(v) + 4:.1f}" font-size="11" '
            f'fill="#475569" text-anchor="end">{v:.1f}</text>'
        )

    n = stats.get("n", 0)
    parts.append(
        f'<text x="{pad_l}" y="{pad_t - 12}" font-size="13" fill="#0f172a">'
        f"Bland-Altman · n={n}</text>"
    )
    parts.append(
        f'<text x="{W / 2}" y="{H - 12}" font-size="12" fill="#475569" '
        f'text-anchor="middle">(本文方法 + 金标准) / 2  [PD]</text>'
    )
    parts.append(
        f'<text x="16" y="{H / 2}" font-size="12" fill="#475569" '
        f'transform="rotate(-90 16 {H / 2})" text-anchor="middle">'
        f"差值 (本文方法 - 金标准) [PD]</text>"
    )
    parts.append("</svg>")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))


# ----------------------------------------------------------------- 自检

def self_test() -> int:
    """确认公式没写错——比任何注释都可靠。"""
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        if cond:
            print(f"  PASS  {name} {detail}")
        else:
            ok = False
            print(f"  FAIL  {name} {detail}")

    check("deg_to_pd(1°)≈1.745", abs(deg_to_pd(1) - 1.7455) < 1e-3, f"{deg_to_pd(1):.4f}")
    check("PD 往返", abs(pd_to_deg(deg_to_pd(2.5)) - 2.5) < 1e-9)
    check("10 PD ≈ 5.71°", abs(pd_to_deg(10) - 5.7106) < 1e-3, f"{pd_to_deg(10):.4f}")

    # 各向同性高斯：BCEA(p=0.632) 应为 2πσ²
    import random

    random.seed(7)
    sigma = 0.5
    pts = [
        (random.gauss(0, sigma), random.gauss(0, sigma)) for _ in range(40000)
    ]
    got = bcea(pts, 0.632)
    want = 2 * math.pi * sigma * sigma
    check("BCEA 与解析值一致", abs(got - want) / want < 0.05, f"{got:.3f} vs {want:.3f}")

    # 已知偏倚的合成数据：一致性界限应能被检出
    pairs = [(2.0 + 0.1, 2.0) for _ in range(20)]
    st = bland_altman(pairs)
    check("恒定偏倚检出", abs(st["bias_pd"] - 0.1) < 1e-9)

    pairs2 = [(r + 0.1 * math.sin(i), r) for i, r in enumerate([5.0, 10.0, 15.0, 20.0, 25.0] * 4)]
    check("Pearson 接近 1", pearson(pairs2) > 0.999, f"{pearson(pairs2):.4f}")
    check("CCC 接近 1", ccc([(r * 1.0, r) for r in [1, 2, 3, 4, 5]]) > 0.999)

    print("\n自检通过" if ok else "\n自检失败")
    return 0 if ok else 1


# ----------------------------------------------------------------- 主流程

def describe(sess: dict) -> str:
    lines = []
    lines.append(f"会话 {sess.get('caseId', '?')}  ({sess.get('_path', '')})")
    cfg = sess.get("config", {})
    lines.append(
        f"  几何: 对角 {cfg.get('diagonalIn')}in / 距离 {cfg.get('distanceCm')}cm / "
        f"1°={cfg.get('pxPerDeg')}px"
    )
    cal = sess.get("calibration") or {}
    held = cal.get("heldOutDeg")
    lines.append(
        f"  校准: 拟合残差 {cal.get('fitResidualDeg', float('nan')):.2f}° / "
        f"留出验证 {held:.2f}°" if held is not None else
        f"  校准: 拟合残差 {cal.get('fitResidualDeg', float('nan')):.2f}° / 无留出验证"
    )
    for t in sess.get("tests", []):
        kind = t.get("kind")
        lines.append(
            f"  [{kind}] 时长 {t.get('durationMs', 0) / 1000:.1f}s  "
            f"有效帧 {100 * t.get('validRatio', 0):.0f}%"
        )
        for e in t.get("eyes", []):
            eye = e.get("eye")
            if kind == "deviation":
                lines.append(
                    f"      {eye}: 中位|偏斜| {e.get('medianAbsPd', float('nan')):.1f} PD"
                    f"  P95 {e.get('p95AbsPd', float('nan')):.1f} PD"
                    f"  偏斜占比 {100 * (e.get('episodeDuty') or 0):.0f}%"
                    f"  事件 {e.get('episodeCount')} 次"
                )
            elif kind == "fixation":
                lines.append(
                    f"      {eye}: BCEA₁σ {e.get('bcea68', float('nan')):.2f} deg²"
                    f"  1°内 {100 * (e.get('pctWithin1') or 0):.0f}%"
                    f"  RMS {e.get('rmsDeg', float('nan')):.2f}°"
                )
            elif kind == "pursuit":
                lines.append(
                    f"      {eye}: 增益 {e.get('gain', float('nan')):.2f}"
                    f"  残差 {e.get('rmseDeg', float('nan')):.2f}°"
                    f"  滞后 {e.get('lagMs')} ms"
                )
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="离线验证台：会话统计 + 与金标准的一致性分析")
    ap.add_argument("inputs", nargs="*", help="会话 JSON 文件、目录或通配符")
    ap.add_argument("--gt", help="金标准 CSV（列：case_id, ref_pd）")
    ap.add_argument("-o", "--out", default="out", help="输出目录")
    ap.add_argument("--self-test", action="store_true", help="只跑公式自检")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if not args.inputs:
        ap.print_help()
        return 2

    sessions = load_sessions(args.inputs)
    if not sessions:
        print("没有可用的会话文件", file=sys.stderr)
        return 1

    print("=" * 72)
    for s in sessions:
        print(describe(s))
    print("=" * 72)

    if not args.gt:
        print("\n未提供 --gt，跳过一致性分析。")
        print("要做一致性分析，请准备 CSV：case_id,ref_pd（棱镜遮盖试验结果）")
        return 0

    gt = load_gt(args.gt)
    pairs: list[tuple[float, float]] = []
    print(f"\n金标准 {len(gt)} 条，逐例对照：")
    print(f"{'case':<12}{'本文方法':>10}{'金标准':>10}{'差值':>10}")
    for s in sessions:
        cid = str(s.get("caseId", "")).strip()
        if cid not in gt:
            print(f"{cid:<12}{'—':>10}{'—':>10}{'(无金标准)':>10}")
            continue
        m = measured_pd(s)
        if m is None:
            print(f"{cid:<12}{'—':>10}{gt[cid]:>10.1f}{'(无偏斜测试)':>10}")
            continue
        pairs.append((m, gt[cid]))
        print(f"{cid:<12}{m:>10.1f}{gt[cid]:>10.1f}{m - gt[cid]:>+10.1f}")

    st = bland_altman(pairs)
    if st.get("n", 0) < 3:
        print("\n可用配对不足 3 例，无法给出一致性统计。")
        return 1

    print("\n一致性分析")
    print(f"  n = {st['n']}")
    print(f"  偏倚 bias          = {st['bias_pd']:+.2f} PD  ({pd_to_deg(st['bias_pd']):+.2f}°)")
    print(f"  95% 一致性界限     = [{st['loa_low_pd']:+.2f}, {st['loa_high_pd']:+.2f}] PD")
    print(f"                     = [{st['loa_low_deg']:+.2f}, {st['loa_high_deg']:+.2f}]°")
    print(f"  Pearson r          = {pearson(pairs):.3f}")
    print(f"  Lin CCC            = {ccc(pairs):.3f}")
    print(f"  比例偏倚斜率       = {st['bias_slope']:+.3f}  （≈0 表示无明显尺度偏差）")

    os.makedirs(args.out, exist_ok=True)
    svg_path = os.path.join(args.out, "bland_altman.svg")
    svg_plot(pairs, st, svg_path)
    txt_path = os.path.join(args.out, "agreement.txt")
    with open(txt_path, "w", encoding="utf-8") as fh:
        fh.write("Bland-Altman 一致性分析\n")
        fh.write(f"n={st['n']}, bias={st['bias_pd']:+.2f} PD, "
                 f"LoA=[{st['loa_low_pd']:+.2f}, {st['loa_high_pd']:+.2f}] PD, "
                 f"CCC={ccc(pairs):.3f}\n")
    print(f"\n已写出 {svg_path}")
    print(f"已写出 {txt_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
