"""host_restart.py — 悬浮窗这一侧的「重启 DSH」编排（2026-11-27，`0.1.1-more.39`）。

**为什么执行端是窗口**：改完插件要宿主重新组合才生效，而重启只能由**不在 DSH 进程树里**
的进程发起 —— 模型自己重启会把自己这一轮掐断（`docs/tasks/window-supervisor.md`）。
悬浮窗是 `detached: true` 起的（`src/window.js`），宿主重启它还在，所以由它动手。

## 一条重启的完整路径

    点「重启 DSH」
      → 读 host.json（插件写的宿主坐标：exe / appPid / hostPid / cwd）
      → 等这一轮跑完（turn-state.json 里没有任何 running）
      → 写 restart.json（phase=requested/killing/launched）
      → 按 pid 杀 Electron 主进程（**不用 /T**：窗口自己在这棵树里，/T 会连它一起收掉）
      → Host 因为 IPC 断开自己优雅退出；不退再按 pid 补一刀
      → 等旧进程真的消失（端口才放得出来；桌面端与 dsh web 不能同时跑）
      → Popen 起 exe（**剥掉 ELECTRON_RUN_AS_NODE**，否则会当 node 跑、没有面板）
      → 轮询 host.json 直到新的 hostPid 写回来（插件启动时写，带版本号）
      → 回执由**插件**写进 chat.jsonl（窗口不知道新进程加载了哪一版）

## 不做什么

- 不调 `app.relaunch()`：那是 Electron 主进程自己的菜单命令，窗口进不去；
  生产构建里连「重启应用与 Host」菜单项都没有（只在开发构建里加）。
- 不用 `os.kill(pid, 0)` 判活：Windows 上它等价于 `TerminateProcess(handle, 0)`，
  会把要杀的进程直接杀掉。判活一律走 `OpenProcess` + `GetExitCodeProcess`。
- 不做「自动改代码 + 自动重启」的闭环：改代码是 agent 的事，这里只负责重启与回报。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HOST_FILE = "host.json"
RESTART_FILE = "restart.json"
TURN_FILE = "turn-state.json"
PLUGIN_ERROR = "plugin-error.log"

#: 继承给新进程会改行为的变量（`host.json` 的 `poison` 是同一份名单，以文件为准）
POISON_ENV = ("ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE")

#: 坐标超过这个年龄只警告不拦：DSH 可能开了一整天。
HOST_AGE_WARN_SEC = 6 * 3600
#: 一个 running 超过这么久还在 running，当它崩溃留下的（否则会永远等下去）。
TURN_STALE_SEC = 30 * 60

IS_WIN = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000 if IS_WIN else 0
DETACHED_PROCESS = 0x00000008 if IS_WIN else 0
CREATE_NEW_PROCESS_GROUP = 0x00000200 if IS_WIN else 0


# ---------------------------------------------------------------- 路径与读盘

def see_dir() -> Path:
    """和窗口/插件同一套目录规则：`DSH_VIDEO_CACHE_DIR` 优先，其次 `~/.dsh/see-now`。"""
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return Path(d)
    return Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh")) / "see-now"


def read_json(path: Path):
    """容忍 BOM（PowerShell 5.1 默认会写）；坏文件当不存在，绝不抛。"""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except Exception:
        return None


def write_json(path: Path, value: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- 进程判活

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259


def _kernel32():
    """kernel32 的签名必须钉死：**句柄是指针宽**，不写 restype=HANDLE 会被截成 c_int，
    之后 CloseHandle 关的是一个错的句柄（杀进程时表现为"杀不掉"或杀掉别的进程）。"""
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.OpenProcess.restype = wintypes.HANDLE
    k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k.GetExitCodeProcess.restype = wintypes.BOOL
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.CloseHandle.restype = wintypes.BOOL
    k.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    k.QueryFullProcessImageNameW.restype = wintypes.BOOL
    return k


def pid_alive(pid) -> bool:
    """进程还在不在（Windows 走 OpenProcess；POSIX 走 kill 0）。

    **不许用 `os.kill(pid, 0)` 判 Windows 的活**：那在 Windows 上是
    `TerminateProcess(handle, 0)`，判活等于把进程杀掉。
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if not IS_WIN:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes
    from ctypes import wintypes
    k = _kernel32()
    h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return False
    try:
        code = wintypes.DWORD()
        if not k.GetExitCodeProcess(h, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        k.CloseHandle(h)


def _window_pids(title_part: str = "DeepSeek") -> list[int]:
    """按窗口标题找顶层窗体所属的 pid（兜底用：没有 host.json 时也能找到 GUI）。

    同样要钉 argtypes：HWND 是指针宽，不钉会被截断成 32 位，EnumWindows 直接不收。
    """
    if not IS_WIN:
        return []
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD

    out: list[int] = []
    needle = title_part.lower()

    def _cb(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if needle not in buf.value.lower():
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value:
                out.append(int(pid.value))
        except Exception:  # noqa: BLE001 - 单个窗口出错不能中断枚举
            pass
        return True

    try:
        user32.EnumWindows(WNDENUMPROC(_cb), 0)
    except Exception:
        return []
    return out


def exe_of(pid: int) -> str:
    """取进程的全路径（QueryFullProcessImageNameW）；取不到返回空串。"""
    if not IS_WIN:
        return ""
    import ctypes
    from ctypes import wintypes
    k = _kernel32()
    h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return ""
    try:
        size = wintypes.DWORD(32768)
        buf = ctypes.create_unicode_buffer(size.value)
        if not k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return ""
        return buf.value
    finally:
        k.CloseHandle(h)


def kill_pid(pid: int, timeout: float = 15.0) -> tuple[bool, str]:
    """杀掉**这一个**进程。**绝不用 `/T`。**

    为什么（2026-11-27 设计时差点踩进去）：悬浮窗是宿主 `spawn(detached:true)` 拉起来的，
    在进程树上是 Electron 的孙子。`taskkill /T` 收的是整棵树 —— 会把**执行重启的窗口自己**
    一起杀掉，于是"关掉旧的、拉起新的"只做了一半，DSH 再也回不来。
    所以按 pid 一个个杀：先 Electron 主进程，Host 会因为 IPC 断开自己停；
    它不停再单独补一刀。
    """
    if not pid_alive(pid):
        return True, "已经不在"
    if not IS_WIN:
        try:
            os.kill(pid, 9)
            return True, "SIGKILL"
        except OSError as e:
            return False, str(e)
    try:
        r = subprocess.run(
            ["taskkill", "/PID", str(int(pid)), "/F"],
            capture_output=True, text=True, timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
        )
    except Exception as e:  # noqa: BLE001 - 这里不能因为调不动 taskkill 就崩
        return False, f"taskkill 起不来：{e}"
    msg = (r.stdout or "").strip() or (r.stderr or "").strip()
    return (r.returncode == 0 or not pid_alive(pid)), msg or f"exit {r.returncode}"


def wait_pid_gone(pid, timeout: float, poll: float = 0.2) -> bool:
    deadline = time.time() + max(0.0, float(timeout))
    while pid_alive(pid):
        if time.time() >= deadline:
            return False
        time.sleep(poll)
    return True


def stop_app(app_pid, host_pid, *, timeout: float = 20.0, log=print) -> tuple[bool, str]:
    """停掉桌面端：主进程先走，Host 跟着 IPC 断开自己退；不退再补一刀。

    顺序有讲究：**先杀 Electron 主进程**，Host 的 `process.once("disconnect")` 会走
    优雅退出（会话文件、port 都能收干净）；反过来先杀 Host，主进程会弹崩溃恢复窗。
    """
    msgs = []
    ok, m = kill_pid(int(app_pid))
    msgs.append(f"Electron {app_pid}: {m}")
    if not wait_pid_gone(app_pid, min(10.0, timeout)):
        msgs.append(f"Electron {app_pid} 没在 10 秒内退出")
    if host_pid and pid_alive(int(host_pid)):
        # 给它自己的 shutdown 一点时间（要落盘），别一上来就补刀
        if wait_pid_gone(host_pid, max(3.0, timeout * 0.6)):
            msgs.append(f"Host {host_pid}: 自己退了")
        else:
            ok2, m2 = kill_pid(int(host_pid))
            msgs.append(f"Host {host_pid}: {m2}")
    gone = wait_gone([app_pid, host_pid], max(3.0, timeout * 0.3))
    return gone, " / ".join(msgs)


def wait_gone(pids, timeout: float, poll: float = 0.25) -> bool:
    deadline = time.time() + max(0.0, float(timeout))
    while True:
        alive = [p for p in pids if p and pid_alive(p)]
        if not alive:
            return True
        if time.time() >= deadline:
            return False
        time.sleep(poll)


# ---------------------------------------------------------------- 空闲判定

def running_turns(see: Path, *, now: int | None = None, stale_sec: int = TURN_STALE_SEC) -> list[str]:
    """`turn-state.json` 里还在跑的会话（崩溃留下的陈旧 running 不算）。"""
    data = read_json(see / TURN_FILE) or {}
    now = now if now is not None else now_ms()
    out = []
    if not isinstance(data, dict):
        return out
    for sid, st in data.items():
        if not isinstance(st, dict):
            continue
        if str(st.get("state") or "") != "running":
            continue
        started = st.get("startedAt") or st.get("at") or 0
        try:
            started = int(started)
        except (TypeError, ValueError):
            started = 0
        if started and now - started > stale_sec * 1000:
            continue
        out.append(str(sid))
    return out


# ---------------------------------------------------------------- 计划与执行

def plan(see: Path | None = None, *, app_pid: int | None = None) -> dict:
    """只读地算一遍「能不能重启、要用什么坐标」，不起进程、不杀进程。"""
    see = Path(see or see_dir())
    host = read_json(see / HOST_FILE)
    problems: list[str] = []
    notes: list[str] = []
    source = "host.json"
    if not isinstance(host, dict) or not host:
        host = {}
        pids = _window_pids()
        if pids:
            source = "窗口标题兜底"
            app_pid = app_pid or pids[0]
        else:
            problems.append(f"没有 {see / HOST_FILE}，也没找到 DSH 主窗口：先手动开一次 DSH")

    exe = str(host.get("exe") or "")
    cwd = str(host.get("cwd") or "")
    host_pid = host.get("hostPid")
    app_pid = app_pid or host.get("appPid")
    version = str(host.get("version") or "?")

    if not exe and app_pid:
        exe = exe_of(int(app_pid))
        if exe:
            notes.append("exe 从进程里现取的（host.json 里没有）")
    if exe and not Path(exe).exists():
        problems.append(f"host.json 里的 exe 不存在：{exe}")
    if not exe:
        problems.append("不知道用哪个 exe 拉起 DSH（host.json 的 exe 为空）")
    if not app_pid:
        problems.append("不知道 Electron 主进程的 pid（host.json 的 appPid 为空）")
    elif not pid_alive(int(app_pid)):
        problems.append(f"host.json 记的 appPid {app_pid} 已经不在了（坐标是上一次开机的？）")
    if host_pid and not pid_alive(int(host_pid)):
        notes.append(f"host.json 的 hostPid {host_pid} 也不在了（DSH 现在是关着的？）")
    if not cwd:
        cwd = str(Path.home())
        notes.append("cwd 用 home 兜底")

    age = None
    try:
        age = max(0, int(time.time() - (see / HOST_FILE).stat().st_mtime))
        if age > HOST_AGE_WARN_SEC:
            notes.append(f"坐标已经 {age // 3600} 小时没更新（DSH 开了一整天？）")
    except OSError:
        pass

    busy = running_turns(see)
    if busy:
        notes.append(f"有 {len(busy)} 个回合在跑（重启会等它们跑完）")

    return {
        "ok": not problems,
        "problems": problems,
        "notes": notes,
        "source": source,
        "see": str(see),
        "exe": exe,
        "cwd": cwd,
        "appPid": int(app_pid) if app_pid else None,
        "hostPid": int(host_pid) if isinstance(host_pid, int) else None,
        "version": version,
        "hostAgeSec": age,
        "busyTurns": busy,
        "poison": [str(x) for x in (host.get("poison") or POISON_ENV)],
    }


def plan_text(p: dict) -> str:
    lines = [f"坐标：{p['see']}（来源 {p['source']}）",
             f"exe：{p['exe'] or '?'}",
             f"进程：app {p['appPid'] or '?'} / host {p['hostPid'] or '?'}（版本 {p['version']}）"]
    if p["hostAgeSec"] is not None:
        lines.append(f"坐标年龄：{p['hostAgeSec']} 秒")
    for n in p["notes"]:
        lines.append(f"注意：{n}")
    for n in p["problems"]:
        lines.append(f"不能重启：{n}")
    if p["ok"]:
        lines.append("结论：可以重启")
    return "\n".join(lines)


def clean_env(base=None, poison=POISON_ENV) -> dict:
    """新进程的环境：继承用户环境，剥掉会让 Electron 变 node 的那几个变量。"""
    env = dict(base if base is not None else os.environ)
    for key in list(poison or ()) + list(POISON_ENV):
        env.pop(str(key), None)
    return env


def spawn_app(cmd: list[str], cwd: str, env: dict) -> subprocess.Popen:
    """detached 起 GUI：不带控制台、不跟着窗口退出。"""
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP if IS_WIN else 0
    return subprocess.Popen(
        cmd, cwd=(cwd or None), env=env, close_fds=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=flags,
    )


def wait_host_back(see: Path, old_host_pid, since_ms: int, timeout: float, poll: float = 0.5) -> dict | None:
    """等插件的新实例写回 host.json（它写在工具注册成功之后）。"""
    deadline = time.time() + max(1.0, float(timeout))
    while time.time() < deadline:
        rec = read_json(see / HOST_FILE)
        if isinstance(rec, dict):
            hp = rec.get("hostPid")
            at = rec.get("at")
            try:
                hp, at = int(hp), int(at)
            except (TypeError, ValueError):
                hp, at = 0, 0
            if hp and hp != int(old_host_pid or 0) and at >= int(since_ms):
                return rec
        time.sleep(poll)
    return None


def perform_restart(
    *,
    see: Path | None = None,
    spawn_cmd: list[str] | None = None,
    wait_idle: bool = True,
    wait_idle_sec: float | None = None,
    kill_timeout: float = 20.0,
    back_timeout: float = 120.0,
    notify=None,
    log=print,
    now=time.time,
    plan_override: dict | None = None,
    by: str = "window",
) -> dict:
    """跑完整条重启。返回 `{ok, phase, text, ...}`；失败也**不抛**（窗口线程要能回报）。

    `spawn_cmd` 只给测试用：换成一条假的"宿主"，就能把整条链路跑通而不动真 DSH。

    `wait_idle_sec`：**默认 None = 不设上限**。2026-11-27 真机第一次跑通后改的 ——
    原来的 15 分钟上限会让「点了没成」变成常态：一个长回合就能吃掉它，而等待期间
    窗口什么也没做错。等待是常态，放弃才需要理由（DSH 不在了 / 她再点一次取消）。
    """
    see = Path(see or see_dir())
    say = notify or (lambda _t: None)
    started = int(now() * 1000)
    p = plan_override or plan(see)
    log(plan_text(p))
    if not p["ok"]:
        return {"ok": False, "phase": "failed", "reason": "；".join(p["problems"]), "plan": p}

    exe, cwd, app_pid, host_pid = p["exe"], p["cwd"], p["appPid"], p["hostPid"]
    # 插件（模型）排的请求：沿用它的 `by` / `session` / 「什么时候排的」——
    # 回执要投进**排队那个会话**，而重启前后绑定会漂，丢了 session 就只能猜
    prev = read_json(see / RESTART_FILE) or {}
    queued_at = None
    if str(prev.get("phase")) == "queued":
        queued_at = prev.get("at")
        by = str(prev.get("by") or by)
    intent = {
        "v": 1,
        "at": started,
        "by": by,
        "phase": "requested",
        "oldAppPid": app_pid,
        "oldHostPid": host_pid,
        "fromVersion": p["version"],
    }
    if queued_at:
        intent["queuedAt"] = queued_at
    if prev.get("session"):
        intent["session"] = str(prev["session"])
    write_json(see / RESTART_FILE, intent)

    # 1) 等空闲：正在跑的回合会被这一刀掐断。
    #    **上限默认不设**：回合长度不可预知，而等待本身没有代价（窗口线程不占人）；
    #    只有「DSH 不在了」或「她再点一次」才该退出等待。
    if wait_idle and p["busyTurns"]:
        intent.update({"phase": "waiting-idle", "busyTurns": len(p["busyTurns"])})
        write_json(see / RESTART_FILE, intent)
        say("重启 DSH：有回合在跑，记下了，等它跑完就重启（不用守着）")
        t0 = now()
        deadline = None if not wait_idle_sec else t0 + float(wait_idle_sec)
        last_note = t0
        while running_turns(see):
            if not pid_alive(int(app_pid)):
                intent.update({"phase": "failed", "failedAt": now_ms(), "reason": "DSH 已经不在了（崩溃？）"})
                write_json(see / RESTART_FILE, intent)
                say("重启 DSH：等待期间 DSH 已经不在了（可能崩溃），没有重启")
                return {"ok": False, "phase": "failed", "reason": "app-gone-while-waiting", "plan": p}
            if deadline is not None and now() >= deadline:
                intent.update({"phase": "failed", "failedAt": now_ms(), "reason": "等空闲超时"})
                write_json(see / RESTART_FILE, intent)
                say("重启 DSH：等空闲超时，先不重启了（可以稍后再点，或手动重启）")
                return {"ok": False, "phase": "failed", "reason": "wait-idle-timeout", "plan": p}
            time.sleep(2.0)
            if now() - last_note >= 300:
                last_note = now()
                say(f"重启 DSH：还在等回合跑完（已等 {int((now() - t0) // 60)} 分钟）")

    # 2) 关掉旧进程。**按 pid 杀，不用 /T**：窗口自己在这棵树里，/T 会把自己也带走
    #    （见 kill_pid 的注释）。先 Electron 主进程，Host 会跟着 IPC 断开优雅退出。
    intent.update({"phase": "killing", "killAt": now_ms()})
    write_json(see / RESTART_FILE, intent)
    say("重启 DSH：关掉旧进程…")
    gone, msg = stop_app(int(app_pid), int(host_pid) if host_pid else None,
                         timeout=kill_timeout, log=log)
    log(f"关旧进程：{msg}")
    if not gone:
        intent.update({"phase": "failed", "failedAt": now_ms(), "reason": f"旧进程没退：{msg}"})
        write_json(see / RESTART_FILE, intent)
        say(f"重启 DSH 失败：旧进程 {app_pid} 没退干净（{msg}），请手动看一下")
        return {"ok": False, "phase": "failed", "reason": "old-not-exited", "plan": p}

    # 3) 拉起新的（剥毒环境；不带参数 —— 原来怎么起的桌面端就是没有参数）
    intent.update({"phase": "launched", "launchedAt": now_ms()})
    write_json(see / RESTART_FILE, intent)
    cmd = list(spawn_cmd or [exe])
    try:
        proc = spawn_app(cmd, cwd, clean_env(poison=p["poison"]))
    except Exception as e:  # noqa: BLE001 - 起不来也要能回报
        intent.update({"phase": "failed", "failedAt": now_ms(), "reason": f"spawn 失败：{e}"})
        write_json(see / RESTART_FILE, intent)
        say(f"重启 DSH 失败：拉不起来（{e}）。DSH 现在关着，请手动打开。")
        return {"ok": False, "phase": "failed", "reason": f"spawn: {e}", "plan": p}
    log(f"spawn {cmd[0]} pid={getattr(proc, 'pid', '?')} cwd={cwd}")
    say("重启 DSH：已拉起，等插件写回来…")

    # 4) 等新宿主写 host.json（插件在工具注册成功之后才写）
    rec = wait_host_back(see, host_pid, started, back_timeout)
    if rec is None:
        # **旧版插件不写 host.json**：升级到本版之后的**第一次**重启就会撞上这条路
        # （正在跑的宿主还是旧代码，它没有写坐标的能力）。这时进程起来了就不是失败 ——
        # 只是"没法自核版本"，要如实说，别报成 host-not-back 让她以为 DSH 没回来。
        proc_alive = getattr(proc, "poll", lambda: 0)() is None
        spawned_pid = getattr(proc, "pid", None)
        # 只认**这一条**新进程的窗口；按标题泛匹配会把浏览器里带 "DeepSeek" 的页面也算进来
        window_up = bool(spawned_pid) and int(spawned_pid) in _window_pids()
        if proc_alive or window_up:
            intent.update({"phase": "launched-legacy", "launchedAt": now_ms(),
                           "reason": "旧版插件不写 host.json，无法自核"})
            write_json(see / RESTART_FILE, intent)
            text = ("DSH 已拉起，但这次没法自核：跑着的还是不写 host.json 的旧版插件。"
                    "从下一版起每次重启都会自核版本与工具注册。")
            say(text)
            return {"ok": True, "phase": "degraded", "text": text, "plan": p,
                    "spawnedPid": getattr(proc, "pid", None), "elapsedMs": now_ms() - started}
        intent.update({"phase": "failed", "failedAt": now_ms(), "reason": "宿主没回来",
                       "newPid": getattr(proc, "pid", None)})
        write_json(see / RESTART_FILE, intent)
        tail = ""
        try:
            tail = (see / PLUGIN_ERROR).read_text(encoding="utf-8", errors="replace")[-400:]
        except Exception:
            pass
        say("重启 DSH 失败：" + f"{int(back_timeout)} 秒内插件没写回 host.json。"
            + ("（plugin-error.log 有新内容，看一眼）" if tail else "（DSH 可能起来了但插件没加载）"))
        return {"ok": False, "phase": "failed", "reason": "host-not-back", "plan": p, "errorTail": tail}

    text = (f"DSH 已拉起：宿主 {host_pid if host_pid else '?'} → {rec.get('hostPid')}，"
            f"版本 {rec.get('version')}（回执由插件写进窗里）")
    say(text)
    return {"ok": True, "phase": "waiting-receipt", "text": text, "plan": p, "host": rec,
            "elapsedMs": now_ms() - started}


# ---------------------------------------------------------------- CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="重启 DSH（悬浮窗侧的编排；默认只检查，不动手）")
    ap.add_argument("--restart", action="store_true", help="真的重启（默认只检查）")
    ap.add_argument("--check", action="store_true", help="只打印计划（默认行为）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--no-wait-idle", "--force", dest="no_wait_idle", action="store_true",
                    help="有回合并跑时也立刻重启（会掐断这一轮）")
    ap.add_argument("--wait-idle", type=float, default=0.0,
                    help="等空闲的上限秒数；0（默认）= 不设上限")
    ap.add_argument("--timeout", type=float, default=120.0, help="等新宿主写回的秒数（默认 120）")
    ap.add_argument("--see", default=None, help="see-now 状态目录（默认按 DSH_VIDEO_CACHE_DIR 推）")
    args = ap.parse_args(argv)

    see = Path(args.see) if args.see else see_dir()
    p = plan(see)
    if args.json and not args.restart:
        print(json.dumps(p, ensure_ascii=False, indent=2))
        return 0 if p["ok"] else 1
    print(plan_text(p))
    if not args.restart:
        return 0 if p["ok"] else 1

    res = perform_restart(
        see=see, wait_idle=not args.no_wait_idle, wait_idle_sec=args.wait_idle or None,
        back_timeout=args.timeout, log=lambda m: print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True),
    )
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    print(res.get("text") or res.get("reason") or res.get("phase"))
    return 0 if res.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
