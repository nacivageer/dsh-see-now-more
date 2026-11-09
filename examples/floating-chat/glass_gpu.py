"""glass_gpu.py — GPU 玻璃合成（moderngl / OpenGL 3.3+）。

和 `glass_cpu.py` 是同一个接口：`render(source, sct, bbox) -> Image | None`。
差异只在「怎么算」，不在「算出来是什么」—— 抓屏、运动判定、麦克风、圆角遮罩
全部复用 `glass_capture`，所以两条路径不会再一次各修一个 bug。

`DSH_GLASS_NATIVE=1` 让采样走全分辨率（边缘透镜没有 1/4 放大的像素感），
代价是纹理上传与片元数 ×16。默认 1/4。

GPU 在这台机器上不一定比 CPU 省（见 CHANGELOG 0.2.10 的实测），它的价值是
「窗口很大 / CPU 较弱」时把合成挪走。默认仍然是 CPU。
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from glass_capture import (CaptureSource, MotionTracker, fill_own_rect_array,
                           finish, paste_mic, resample)
from glass_geometry import LPF, Geometry

VERT = r"""
#version 330
in vec2 in_pos;
out vec2 v_uv;
void main() {
    v_uv = in_pos * 0.5 + 0.5;
    gl_Position = vec4(in_pos, 0.0, 1.0);
}
"""

# BGRA -> 采样纹理；顺带把 1/4 缩小做掉（整屏一次）
FRAG_DOWN = r"""
#version 330
uniform sampler2D tex;
in vec2 v_uv;
out vec4 frag;
void main() {
    vec4 c = texture(tex, v_uv);
    frag = vec4(c.bgr, 1.0);
}
"""

# 线性过滤配对采样：用一次 texture() 拿到两个 taps 的加权和，采样次数减半、
# 权重仍是同一组高斯。
FRAG_BLUR = r"""
#version 330
uniform sampler2D tex;
uniform vec2 texel;
uniform float sigma;
uniform vec2 dir;
in vec2 v_uv;
out vec4 frag;
void main() {
    int radius = int(min(32.0, ceil(sigma * 3.0)));
    float total = 0.0;
    vec3 sum = vec3(0.0);
    for (int i = -32; i <= 32; i += 2) {
        if (i < -radius) continue;
        float fi = float(i);
        float w0 = exp(-0.5 * (fi * fi) / (sigma * sigma));
        int j = i + 1;
        if (j > radius) {
            sum += texture(tex, v_uv + dir * texel * fi).rgb * w0;
            total += w0;
        } else {
            float fj = float(j);
            float w1 = exp(-0.5 * (fj * fj) / (sigma * sigma));
            float x = (fi * w0 + fj * w1) / (w0 + w1);
            sum += texture(tex, v_uv + dir * texel * x).rgb * (w0 + w1);
            total += w0 + w1;
        }
    }
    frag = vec4(sum / total, 1.0);
}
"""

# 圆角边缘折射：按预计算的位移图取「框外」的像素
FRAG_WARP = r"""
#version 330
uniform sampler2D src;
uniform sampler2D coord;
uniform vec2 offset;
uniform vec2 src_size;
in vec2 v_uv;
out vec4 frag;
void main() {
    vec2 c = texelFetch(coord, ivec2(gl_FragCoord.xy), 0).rg + offset;
    ivec2 p = ivec2(floor(c + 0.5));
    p = clamp(p, ivec2(0), ivec2(src_size) - 1);
    frag = texelFetch(src, p, 0);
}
"""

# 内框透镜：边缘取折射样本，中心取强模糊
FRAG_BOX = r"""
#version 330
uniform sampler2D warped;
uniform sampler2D strongw;
uniform sampler2D raw;
uniform sampler2D alpha;
uniform sampler2D edge;
uniform sampler2D coord;
uniform vec2 offset;
uniform vec2 src_size;
in vec2 v_uv;
out vec4 frag;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 base = texelFetch(warped, p, 0).rgb;
    vec3 strong = texelFetch(strongw, p, 0).rgb;
    float a = texelFetch(alpha, p, 0).r;
    float e = texelFetch(edge, p, 0).r;
    vec2 ec = texelFetch(coord, p, 0).rg + offset;
    ivec2 ep = clamp(ivec2(floor(ec + 0.5)), ivec2(0), ivec2(src_size) - 1);
    // 边缘从小框自己的原始帧取，避免 warped 在贴边小框上采到黑边。
    vec3 edgep = texelFetch(raw, ep, 0).rgb;
    // edge_w（这里的 e）=0 是边缘（取折射样本）、=1 是中心（取强模糊），
    // 方向必须和 CPU 一致，否则内框边缘反而没有扭曲。
    vec3 tile = mix(edgep, strong, e);
    frag = vec4(mix(base, tile, a), 1.0);
}
"""

# 框内用透镜、框外用底图，再叠染色
FRAG_PANEL = r"""
#version 330
uniform sampler2D warped;
uniform sampler2D lens;
uniform sampler2D union_mask;
uniform sampler2D overlay;
in vec2 v_uv;
out vec4 frag;
void main() {
    vec3 base = texture(warped, v_uv).rgb;
    vec3 lensc = texture(lens, v_uv).rgb;
    float m = texture(union_mask, v_uv).r;
    vec3 c = mix(base, lensc, m);
    vec4 o = texture(overlay, v_uv);
    c = c * (1.0 - o.a) + o.rgb * o.a;
    frag = vec4(c, 1.0);
}
"""

# 收尾：放大到全分辨率 + 运动残影 + 外框色散，一次采样搞定
FRAG_POST = r"""
#version 330
uniform sampler2D curr;
uniform sampler2D prev;
uniform vec2 texel;
uniform float blend;
uniform float chroma;
in vec2 v_uv;
out vec4 frag;
void main() {
    vec3 c = texture(curr, v_uv).rgb;
    vec3 p = texture(prev, v_uv).rgb;
    // 运动残影：只混一点点上一帧，遮住延迟造成的逐帧跳变/撕裂感
    c = mix(c, p, blend);
    // 外框色散：只在靠近窗口圆角外缘的窄带里把 R/B 沿径向错开
    vec2 d = v_uv - 0.5;
    float r = length(d);
    float edge = smoothstep(0.38, 0.48, r) * (1.0 - smoothstep(0.52, 0.585, r));
    if (edge > 0.001 && chroma > 0.001) {
        vec2 dir = normalize(d + vec2(1e-5));
        float k = chroma * edge;
        vec3 cc;
        cc.r = texture(curr, v_uv + dir * texel * k).r;
        cc.g = c.g;
        cc.b = texture(curr, v_uv - dir * texel * k).b;
        c = mix(c, cc, edge);
    }
    frag = vec4(c, 1.0);
}
"""


def _resize_f32(arr: np.ndarray, size) -> np.ndarray:
    """多通道 float 图缩放；cv2 可用时比 PIL 逐通道快一个数量级。"""
    try:
        import cv2
        return cv2.resize(arr, size, interpolation=cv2.INTER_LINEAR)
    except Exception:
        pass
    chans = []
    for i in range(arr.shape[2]):
        im = Image.fromarray(np.ascontiguousarray(arr[:, :, i]), mode="F")
        chans.append(np.asarray(im.resize(size, Image.Resampling.BILINEAR), dtype=np.float32))
    return np.stack(chans, axis=-1)


def _resize_mask(arr: np.ndarray, size) -> np.ndarray:
    try:
        import cv2
        return cv2.resize(arr, size, interpolation=cv2.INTER_LINEAR)
    except Exception:
        pass
    im = Image.fromarray((np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8), mode="L")
    im = im.resize(size, Image.Resampling.BILINEAR)
    return np.asarray(im, dtype=np.float32) / 255.0


class GpuRenderer:
    """一套 Geometry 对应一个实例；`native` 决定采样分辨率。

    注意 **context 必须在渲染线程里建**：moderngl 的 standalone context 绑在创建
    它的线程上，主线程建好再拿去 worker 用，每帧都会 `cannot create texture`。
    所以 `__init__` 只记参数，真正的初始化推迟到第一次 `render()`。
    """

    def __init__(self, geo: Geometry, tracker: MotionTracker | None = None,
                 native: bool = False):
        self.geo = geo
        self.tracker = tracker or MotionTracker()
        self.native = native
        self.ctx = None
        self.progs: dict = {}
        self.vbo = None
        self._gl = None
        self._fbos: dict = {}
        self._texs: dict = {}
        self._src = None
        self._geo_version = -1
        self._prev_valid = False
        self._layout = None
        self.broken = False

    # ---- 生命周期 ----

    def _ensure(self) -> None:
        if self.ctx is not None:
            return
        import moderngl

        self._gl = moderngl
        self.ctx = moderngl.create_standalone_context(require=330)
        tri = np.array([-1.0, -1.0, 3.0, -1.0, -1.0, 3.0], dtype="f4")
        self.vbo = self.ctx.buffer(tri.tobytes())
        for name, fs in (("down", FRAG_DOWN), ("blur", FRAG_BLUR),
                         ("warp", FRAG_WARP), ("box", FRAG_BOX),
                         ("panel", FRAG_PANEL), ("post", FRAG_POST)):
            prog = self.ctx.program(vertex_shader=VERT, fragment_shader=fs)
            prog.vao = self.ctx.vertex_array(prog, [(self.vbo, "2f", "in_pos")])
            self.progs[name] = prog

    def set_geometry(self, geo: Geometry) -> None:
        self.geo = geo
        self.invalidate()

    def invalidate(self) -> None:
        """形状变了：上一帧不能再混进来（旧代码这里漏了，GPU 会带 0.35 残影）。"""
        self.tracker.invalidate()
        self._prev_valid = False

    def close(self) -> None:
        if self.ctx is None:
            return
        try:
            self.ctx.make_current()
        except Exception:
            pass
        for fbo in list(self._fbos.values()):
            fbo.release()
        for tex in list(self._texs.values()):
            tex.release()
        self._fbos.clear()
        self._texs.clear()
        if self._src is not None:
            self._src.release()
            self._src = None
        for prog in self.progs.values():
            try:
                prog.release()
            except Exception:
                pass
        self.progs.clear()
        try:
            self.ctx.release()
        except Exception:
            pass
        self.ctx = None

    # ---- GL 资源 ----

    def _fbo(self, key: str, size):
        old = self._fbos.get(key)
        if old is not None and old.size == size:
            return old
        if old is not None:
            old.release()
        tex = self.ctx.texture(size, 4)
        tex.filter = (self._gl.LINEAR, self._gl.LINEAR)
        tex.repeat_x = tex.repeat_y = False
        self._fbos[key] = self.ctx.framebuffer(color_attachments=[tex])
        return self._fbos[key]

    def _tex(self, key: str, size, components=1, dtype="f4",
             data=None, linear=False) -> object:
        old = self._texs.get(key)
        if old is not None and (old.size != size or old.components != components):
            old.release()
            old = None
        if old is None:
            old = self.ctx.texture(size, components, dtype=dtype, data=data)
            filt = self._gl.LINEAR if linear else self._gl.NEAREST
            old.filter = (filt, filt)
            old.repeat_x = old.repeat_y = False
            self._texs[key] = old
        elif data is not None:
            old.write(data)
        return old

    def _set(self, prog, **kw) -> None:
        for k, v in kw.items():
            try:
                prog[k] = v
            except KeyError:
                pass

    # ---- 几何纹理 ----

    def _ensure_layout(self) -> None:
        geo = self.geo
        # 尺寸和 version 都要看：缩放后 version 可能没变（for_size 从 0 起算）
        if (self._layout is not None and self._layout[:2] == (geo.width, geo.height)
                and self._geo_version == geo.version):
            return
        W, H = geo.width, geo.height
        qw, qh = max(4, W // LPF), max(4, H // LPF)

        alpha_q = np.zeros((qh, qw), dtype="f4")
        edge_q = np.zeros((qh, qw), dtype="f4")
        coord_q = np.zeros((qh, qw, 2), dtype="f4")
        for qx0, qy0, bqw, bqh, a, e, bsx, bsy in geo.box_maps:
            alpha_q[qy0:qy0 + bqh, qx0:qx0 + bqw] = a
            edge_q[qy0:qy0 + bqh, qx0:qx0 + bqw] = e
            coord_q[qy0:qy0 + bqh, qx0:qx0 + bqw, 0] = bsx
            coord_q[qy0:qy0 + bqh, qx0:qx0 + bqw, 1] = bsy
        warp_q = np.stack([geo.warp_x, geo.warp_y], axis=-1).astype("f4")

        if self.native:
            hw, hh = W, H
            HW, HH = W, H
            alpha = _resize_mask(alpha_q, (hw, hh))
            edge = _resize_mask(edge_q, (hw, hh))
            # 内框也走原生采样（无 1/4 放大的像素感），厚模糊由 strong 提供
            coord = _resize_f32(coord_q * LPF, (hw, hh))
            warp = _resize_f32(warp_q * LPF, (hw, hh))
            overlay = np.asarray(geo.overlay.convert("RGBA"), dtype=np.uint8)
            union = np.asarray(geo.box_union_half.resize((W, H), Image.Resampling.BILINEAR),
                               dtype=np.uint8)
        else:
            hw, hh = qw, qh
            HW, HH = geo.half_size
            alpha, edge, coord, warp = alpha_q, edge_q, coord_q, warp_q
            overlay = np.asarray(geo.overlay_half.convert("RGBA"), dtype=np.uint8)
            union = np.asarray(geo.box_union_half, dtype=np.uint8)

        self._tex("alpha", (hw, hh), 1, "f4", np.ascontiguousarray(alpha).tobytes())
        self._tex("edge", (hw, hh), 1, "f4", np.ascontiguousarray(edge).tobytes())
        self._tex("coord", (hw, hh), 2, "f4", np.ascontiguousarray(coord).tobytes())
        self._tex("warpcoord", (hw, hh), 2, "f4", np.ascontiguousarray(warp).tobytes())
        self._tex("overlay", (HW, HH), 4, "f1", overlay.tobytes(), linear=True)
        self._tex("union", (HW, HH), 1, "f1", union.tobytes(), linear=True)
        self._layout = (W, H, hw, hh, HW, HH)
        self._geo_version = geo.version
        self._prev_valid = False

    # ---- 主入口 ----

    def render(self, source: CaptureSource, sct, bbox) -> Image.Image | None:
        geo = self.geo
        try:
            self._ensure()
        except Exception as exc:
            self.broken = True
            raise RuntimeError(f"GPU 不可用: {exc!r}") from exc
        shot = source.grab(sct, bbox)
        if shot is None:
            return None
        gw, gh = shot.shot.size
        raw = np.frombuffer(shot.shot.bgra, dtype=np.uint8).reshape(gh, gw, 4)
        if source.cappable and not source.solid:
            # 录屏模式下必须挖掉自己，否则背景里永远有本窗口 → moved 恒真 →
            # 静态跳帧一次都不触发，还会自我反馈出拖尾。CPU 路径在
            # CaptureSource.to_image() 里做，GPU 直接吃 bgra，得在这里补上。
            raw = raw.copy()
            fill_own_rect_array(raw, source.own_rect(shot, bbox))
        # 静态判断放在渲染之前：静止时连纹理都不上传
        small_rgb = resample(raw[:, :, :3], (max(2, gw // LPF), max(2, gh // LPF)))
        moved, stale = self.tracker.observe(small_rgb, shot.box)
        if stale:
            self._prev_valid = False
            return None

        self._ensure_layout()
        W, H, hw, hh, HW, HH = self._layout
        if self._src is None or self._src.size != (gw, gh):
            if self._src is not None:
                self._src.release()
            self._src = self.ctx.texture((gw, gh), 4)
            self._src.filter = (self._gl.LINEAR, self._gl.LINEAR)
            self._src.repeat_x = self._src.repeat_y = False
        self._src.write(raw.tobytes())

        panel = self._run(W, H, hw, hh, HW, HH, gw, gh, shot.offset, moved)
        data = panel.read(components=3, alignment=1)
        out = Image.frombytes("RGB", (W, H), data)
        return finish(geo, paste_mic(geo, out))

    def _run(self, W, H, hw, hh, HW, HH, gw, gh, offset, moved):
        gl = self._gl
        native = self.native
        bw, bh = (gw, gh) if native else (max(2, gw // LPF), max(2, gh // LPF))

        raw_fbo = self._fbo("raw", (bw, bh))
        raw_fbo.use()
        self.ctx.viewport = (0, 0, bw, bh)
        self._src.use(0)
        prog = self.progs["down"]
        prog["tex"] = 0
        prog.vao.render(gl.TRIANGLES)

        small = self._fbo("small", (bw, bh))
        strong = self._fbo("strong", (bw, bh))
        tmp = self._fbo("tmp", (bw, bh))

        def blur(dst, src_tex, sigma):
            tmp.use()
            self.ctx.viewport = (0, 0, bw, bh)
            src_tex.use(0)
            p = self.progs["blur"]
            p["tex"] = 0
            p["texel"] = (1.0 / bw, 1.0 / bh)
            p["sigma"] = sigma
            p["dir"] = (1.0, 0.0)
            p.vao.render(gl.TRIANGLES)
            dst.use()
            self.ctx.viewport = (0, 0, bw, bh)
            tmp.color_attachments[0].use(0)
            p["dir"] = (0.0, 1.0)
            p.vao.render(gl.TRIANGLES)

        sigma_scale = LPF if native else 1.0
        blur(small, raw_fbo.color_attachments[0], 1.45 * sigma_scale)
        strong_boost = 1.45 if native else 1.0
        blur(strong, small.color_attachments[0], 2.6 * sigma_scale * strong_boost)

        warped = self._fbo("warped", (hw, hh))
        strongw = self._fbo("strongw", (hw, hh))
        for dst, src_fbo in ((warped, small), (strongw, strong)):
            dst.use()
            self.ctx.viewport = (0, 0, hw, hh)
            src_fbo.color_attachments[0].use(0)
            self._texs["warpcoord"].use(1)
            p = self.progs["warp"]
            self._set(p, src=0, coord=1, offset=(float(offset[0]), float(offset[1])),
                      src_size=(float(bw), float(bh)))
            p.vao.render(gl.TRIANGLES)

        # 内框的边缘样本直接用 small 的纹理当 sampler：目标是 lens，没有反馈回路。
        # （旧代码为此多跑了一趟全屏拷贝，注释里担心的 driver 崩是「同一张图当
        #   render target 又当 sampler」的情况，这里不成立。）
        lens = self._fbo("lens", (hw, hh))
        lens.use()
        self.ctx.viewport = (0, 0, hw, hh)
        warped.color_attachments[0].use(0)
        strongw.color_attachments[0].use(1)
        small.color_attachments[0].use(2)
        self._texs["alpha"].use(3)
        self._texs["edge"].use(4)
        self._texs["coord"].use(5)
        p = self.progs["box"]
        self._set(p, warped=0, strongw=1, raw=2, alpha=3, edge=4, coord=5,
                  offset=(float(offset[0]), float(offset[1])),
                  src_size=(float(bw), float(bh)))
        p.vao.render(gl.TRIANGLES)

        panel2x = self._fbo("panel2x", (HW, HH))
        panel2x.use()
        self.ctx.viewport = (0, 0, HW, HH)
        warped.color_attachments[0].use(0)
        lens.color_attachments[0].use(1)
        self._texs["union"].use(2)
        self._texs["overlay"].use(3)
        p = self.progs["panel"]
        self._set(p, warped=0, lens=1, union_mask=2, overlay=3)
        p.vao.render(gl.TRIANGLES)

        prev = self._fbo("prev", (W, H))
        out = self._fbo("out", (W, H))
        out.use()
        self.ctx.viewport = (0, 0, W, H)
        panel2x.color_attachments[0].use(0)
        prev.color_attachments[0].use(1)
        p = self.progs["post"]
        p["texel"] = (1.0 / W, 1.0 / H)
        # 和 CPU 一致：只在「本帧确实检测到移动」时混上一帧，停下立刻干净；
        # 移动帧跳过色散，先把拖动/滚动响应保住。
        p["blend"] = float(self.tracker.blend if moved and self._prev_valid else 0.0)
        p["chroma"] = 0.0 if moved else 3.6 * (W / 900.0)
        self._set(p, curr=0, prev=1)
        p.vao.render(gl.TRIANGLES)
        self.ctx.copy_framebuffer(prev, out)
        self._prev_valid = True
        return out


__all__ = ["GpuRenderer"]
