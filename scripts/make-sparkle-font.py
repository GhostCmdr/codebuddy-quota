# 状态栏双星图标 assets/codebuddy-sparkle.ttf 的生成脚本。
# 与 traecn-quota 的唯一差异：小星从右下角镜像到右上角（y 关于 y=8 翻转）。
# 依赖：uv run --with fonttools --with pathops python scripts/make-sparkle-font.py
import os, re
from fontTools.svgLib.path import parse_path
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.misc.transform import Transform
from fontTools.fontBuilder import FontBuilder
from pathops import Path, FillType

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "build")
os.makedirs(OUT, exist_ok=True)
src = open(os.path.join(BASE, "assets", "source", "sparkle-filled.codicon.svg"), encoding="utf-8").read()
d_all = re.search(r'<path[^>]*d="([^"]+)"', src).group(1)
subs = [x for x in re.split(r'(?=[Mm])', d_all) if x.strip()]

def scale_about(s, cx, cy):
    return Transform(s, 0, 0, s, cx - cx * s, cy - cy * s)

def xform(d, *ts):
    sp = SVGPathPen(None)
    pen = sp
    for t in reversed(ts):
        pen = TransformPen(pen, t)
    parse_path(d, pen)
    return sp.getCommands()

def bbox(d):
    bp = BoundsPen(None)
    parse_path(d, bp)
    return bp.bounds

# 大星：左下；小星：右上。做法＝原两星（左上大 / 右下小）整组上下镜像。
T_BIG3 = scale_about(9.0 / 8.0, 6, 6)
T_SMALL3 = scale_about(5.5 / 6.0, 11, 11)
MIRROR_V = Transform(1, 0, 0, -1, 0, 16)
T_SHIFT3 = Transform(1, 0, 0, 1, 0.375, 0.375)
S_FINAL = 14.0 / 12.25
T_FINAL = scale_about(S_FINAL, 8, 8)

big_final = xform(subs[0], T_BIG3, MIRROR_V, T_SHIFT3, T_FINAL)
small_final = xform(subs[1], T_SMALL3, MIRROR_V, T_SHIFT3, T_FINAL)
d_final = big_final + small_final

# 自动缩放并居中到 16×16 画布（留 1 格边距），保证不越界且视觉居中
bb = bbox(d_final)
bw = bb[2] - bb[0]
bh = bb[3] - bb[1]
fit = min(14.0 / bw, 14.0 / bh)
bcx = (bb[0] + bb[2]) / 2
bcy = (bb[1] + bb[3]) / 2
d_final = xform(d_final, scale_about(fit, bcx, bcy), Transform(1, 0, 0, 1, 8 - bcx, 8 - bcy))
print("final bbox:", tuple(round(v, 3) for v in bbox(d_final)))

def make_svg(d):
    return ('<svg width="16" height="16" viewBox="0 0 16 16" '
            'xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="%s"/></svg>' % d)

open(os.path.join(OUT, "sparkle-top-right.svg"), "w", encoding="utf-8").write(make_svg(d_final))

# ---- 字体：单字形 ----
UPM = 1000
TF = Transform(900.0 / 16.0, 0, 0, -900.0 / 16.0, 50.0, 950.0)
p = Path()
p.fillType = FillType.EVEN_ODD
parse_path(d_final, p.getPen())
p.simplify(fix_winding=True)

tt = TTGlyphPen(None)
p.draw(TransformPen(Cu2QuPen(tt, 0.6), TF))
glyf = {".notdef": TTGlyphPen(None).glyph(), "sparkle": tt.glyph()}

fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder([".notdef", "sparkle"])
fb.setupCharacterMap({0xE001: "sparkle"})
fb.setupGlyf(glyf)
fb.setupHorizontalMetrics({".notdef": (500, 0), "sparkle": (UPM, 0)})
fb.setupHorizontalHeader(ascent=850, descent=-150)
fb.setupNameTable({"familyName": "CodeBuddySparkle", "styleName": "Regular",
                   "psName": "CodeBuddySparkle-Regular", "fullName": "CodeBuddySparkle", "version": "1.0"})
fb.setupOS2(sTypoAscender=850, sTypoDescender=-150, usWinAscent=900, usWinDescent=100)
fb.setupPost()
ttf = os.path.join(BASE, "assets", "codebuddy-sparkle.ttf")
fb.save(ttf)
print("TTF", os.path.getsize(ttf), "bytes")
