# -*- coding: utf-8 -*-
"""quote_text.py — 气泡选区「引用选中文字」的纯函数（不 import Tk）。

编码必须和 DSH 主窗的 `@deepseek-ai/dsh-message-quotes` 同形，否则浮窗发出去的
引用在 DSH 里不会渲染成引用块：

    formatQuoteText("a\\nb") == "> a\\n> b"

（DSH 的实现：统一 CRLF → 按 `\\n` 切 → 每行前缀 `> ` → 拼回；见任务书
`docs/tasks/session-mirror-quote.md` 的「编码」节。）

另外两个函数给窗口用：

- `split_quote_blocks`：把一条**用户消息**切成引用块 / 普通文本段，供气泡渲染
  （规则和 DSH 的 `quoteRule` 一致：连续的最多 3 个前导空格的 `>` 行，剥掉一个
  `>` 和它后面的一个空格 / 制表符；遇到第一条非引用行结束；整块去空白后为空
  则丢弃）；
- `quote_preview`：输入区 chip 上那行预览（换行 / 连续空白压成单个空格）。
"""

import re

# DSH `quoteRule`：行首最多 3 个空格 + `>` + 可选一个空格 / 制表符
QUOTE_LINE = re.compile(r"^ {0,3}>[ \t]?(.*)$")


def _normalize(text: str) -> str:
    return str(text or "").replace("\r\n", "\n").replace("\r", "\n")


def format_quote_text(text: str) -> str:
    """选中文字 → DSH 同款引用块（每行 `> `，首尾空白先 strip）。

    空输入返回空串：DSH 的 `formatQuoteText("")` 会产出 `"> "`，但选不到字就不会
    出现菜单项，返回空串更不容易把一条空引用发出去。
    """
    body = _normalize(text).strip()
    if not body:
        return ""
    return "\n".join("> " + line for line in body.split("\n"))


def split_quote_blocks(text: str) -> list:
    """按引用块切段：`[("q", 引用原文), ("text", 其余文本)]`，保持顺序。

    引用块里的行已经剥掉 `>` 标记（这就是气泡里要显示 / 选中复制的文字）；
    `text` 段保持原文（调用方再跑图片识别）。空的引用块直接丢弃
    （DSH 的 `quoteRule` 也跳过空行判断，整段空白没有可渲染的内容）。
    """
    text = _normalize(text)
    out = []
    quote_lines = []
    text_lines = []

    def flush_quote():
        if not quote_lines:
            return
        body = "\n".join(quote_lines)
        if body.strip():
            out.append(("q", body))
        quote_lines.clear()

    def flush_text():
        if not text_lines:
            return
        body = "\n".join(text_lines)
        if body:
            out.append(("text", body))
        text_lines.clear()

    for line in text.split("\n"):
        m = QUOTE_LINE.match(line)
        if m:
            flush_text()
            quote_lines.append(m.group(1))
        else:
            flush_quote()
            text_lines.append(line)
    flush_quote()
    flush_text()
    return out


def quote_preview(text: str, limit: int = 120) -> str:
    """chip 预览：换行和连续空白压成一个空格；超长先截断（窗口还会按像素再截）。

    **只用于显示**：发送用的是 `format_quote_text(原文)`，不是预览。
    """
    flat = re.sub(r"\s+", " ", _normalize(text)).strip()
    if limit > 0 and len(flat) > limit:
        return flat[:limit] + "…"
    return flat
