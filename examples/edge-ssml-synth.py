"""edge-ssml-synth.py — 按 JSON 规格合成一条语音（供 voice-edge-tts.mjs 调用）。

edge 朗读接口最多认 **2 个** `<prosody>`（第 3 个起 `NoAudioReceived`），所以规格只有
「前缀」「重读段」「后缀」三块：前缀与重读段各一个 prosody，后缀按默认速度念。

JSON 字段：
  { "plain": "整句（不带标记）",
    "pre":   "重读段前面的文本",
    "emph":  "重读段",
    "suf":   "重读段后面的文本",
    "preRate": "+10%", "preVolume": "+0%",
    "emphRate": "+0%", "emphVolume": "+15%", "emphPitch": "+15Hz",
    "voice": "zh-CN-XiaoxiaoNeural", "out": "…mp3" }

用法：python edge-ssml-synth.py --spec <spec.json>
"""
import argparse
import asyncio
import json

import edge_tts
import edge_tts.communicate as com


def build(spec: dict) -> str:
    esc = lambda x: x.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # noqa: E731
    pre = esc(spec.get("pre", ""))
    emph = esc(spec.get("emph", ""))
    suf = esc(spec.get("suf", ""))
    parts = []
    if pre:
        parts.append(
            f"<prosody rate='{spec['preRate']}' volume='{spec['preVolume']}' pitch='+0Hz'>{pre}</prosody>"
        )
    parts.append(
        f"<prosody rate='{spec['emphRate']}' volume='{spec['emphVolume']}' "
        f"pitch='{spec['emphPitch']}'>{emph}</prosody>"
    )
    parts.append(suf)
    return (
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
        f"<voice name='{spec['voice']}'>{''.join(parts)}</voice></speak>"
    )


async def run(plain: str, ssml: str, voice: str, out: str) -> None:
    com.mkssml = lambda tc, escaped_text: ssml
    client = edge_tts.Communicate(plain, voice)
    with open(out, "wb") as fh:
        async for chunk in client.stream():
            if chunk["type"] == "audio":
                fh.write(chunk["data"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    a = ap.parse_args()
    spec = json.loads(open(a.spec, encoding="utf-8").read())
    ssml = build(spec)
    asyncio.run(run(spec["plain"], ssml, spec["voice"], spec["out"]))


if __name__ == "__main__":
    main()
