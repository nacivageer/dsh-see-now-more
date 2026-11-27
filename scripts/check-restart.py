"""check-restart.py — 「重启 DSH」编排的验收脚本（2026-11-27，`0.1.1-more.39`）。

**不动真 DSH**：拿一个假的"应用"跑完整条链路 —— 读 host.json → 杀 → 等进程消失 →
拉起 → 轮询新 host.json。测的是编排，不是 Electron。

拓扑按真机摆：

    假应用（= Electron 主进程）
      └── 假 Host（= 桌面端 Host，host.json 的 hostPid）
            └── 假窗口（detached，重启时必须活下来）

最后这层是重点：**重启不能把窗口自己杀掉**，否则"关掉旧的、拉起新的"只做一半。
所以杀进程一律按 pid、不带 `/T`。

    python scripts/check-restart.py

退出码 0 = 全过；1 = 有断言失败；2 = 环境跑不起来。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "examples" / "floating-chat"))

import host_restart as hr  # noqa: E402

PY = sys.executable

# 假 Host：拉起一个 detached 的"窗口"，把它的 pid 写下来，然后睡
FAKE_HOST = r"""
import subprocess, sys, time
from pathlib import Path
see = Path(sys.argv[1])
flags = 0x00000008 if sys.platform == "win32" else 0   # DETACHED_PROCESS
win = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(180)"], creationflags=flags)
(see / "survivor.pid").write_text(str(win.pid), encoding="utf-8")
time.sleep(180)
"""

# 假应用：Host 是它的子进程；它把两边 pid 写进 host.json
FAKE_APP = r"""
import json, os, subprocess, sys, time
from pathlib import Path
see = Path(sys.argv[1]); gen = sys.argv[2]
host = subprocess.Popen([sys.executable, "-c", sys.argv[3], str(see)])
rec = {
    "v": 1, "at": int(time.time() * 1000), "exe": sys.executable,
    "appPid": os.getpid(), "hostPid": host.pid, "cwd": os.getcwd(),
    "version": "fake-" + gen, "poison": ["ELECTRON_RUN_AS_NODE"],
    "argv": [sys.executable, "fake"], "env": {},
}
tmp = see / "host.json.tmp"
tmp.write_text(json.dumps(rec), encoding="utf-8")
os.replace(tmp, see / "host.json")
time.sleep(180)
"""

FAILED = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + name + (f" — {detail}" if detail else ""), flush=True)
    if not cond:
        FAILED.append(name)


def wait_for(pred, timeout=20.0, poll=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = pred()
        if v:
            return v
        time.sleep(poll)
    return None


def read_host(see: Path) -> dict:
    try:
        return json.loads((see / "host.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def read_pid(path: Path) -> int:
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except Exception:
        return 0


def start_fake(see: Path, gen: str) -> dict:
    p = subprocess.Popen([PY, "-c", FAKE_APP, str(see), gen, FAKE_HOST],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rec = wait_for(lambda: (read_host(see) if read_host(see).get("appPid") == p.pid else None), 20)
    if not rec:
        p.kill()
        raise RuntimeError(f"假应用（{gen}）没有写出 host.json")
    win = wait_for(lambda: read_pid(see / "survivor.pid") or None, 10) or 0
    return {**rec, "survivor": win}


def cleanup(see: Path) -> None:
    rec = read_host(see)
    for pid in (read_pid(see / "survivor.pid"), rec.get("hostPid"), rec.get("appPid")):
        if isinstance(pid, int) and pid > 0:
            hr.kill_pid(pid)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="see-restart-"))
    print(f"临时目录：{tmp}")
    try:
        # --- 1：正常一轮（+ 窗口活下来 + 环境干净） ---------------------------
        old = start_fake(tmp, "1")
        print(f"旧：app {old['appPid']} / host {old['hostPid']} / 窗口 {old.get('survivor')}")
        said = []
        res = hr.perform_restart(
            see=tmp, spawn_cmd=[PY, "-c", FAKE_APP, str(tmp), "2", FAKE_HOST],
            wait_idle=False, kill_timeout=4, back_timeout=30, notify=said.append,
            log=lambda m: print("  · " + m),
        )
        check("正常一轮：返回 ok", res.get("ok") is True, str(res.get("reason") or res.get("phase")))
        gone = wait_for(lambda: not hr.pid_alive(old["appPid"]) and not hr.pid_alive(old["hostPid"]), 10)
        check("正常一轮：旧 app 与旧 host 都已消失", bool(gone))
        check("正常一轮：窗口（detached 子进程）活下来了", hr.pid_alive(old.get("survivor") or 0),
              f"pid={old.get('survivor')}")
        new = read_host(tmp)
        check("正常一轮：新 host.json 的 pid 变了",
              bool(new.get("appPid")) and new.get("appPid") != old.get("appPid")
              and new.get("hostPid") != old.get("hostPid"))
        check("正常一轮：新版本号来自新一轮", str(new.get("version")) == "fake-2", str(new.get("version")))
        intent = hr.read_json(tmp / "restart.json") or {}
        check("正常一轮：相位停在 launched（done 留给插件）", intent.get("phase") == "launched",
              str(intent.get("phase")))
        check("正常一轮：窗口报了开始与拉起",
              any("关掉旧进程" in s for s in said) and any("已拉起" in s for s in said))
        check("干净环境：ELECTRON_RUN_AS_NODE 被剥掉",
              "ELECTRON_RUN_AS_NODE" not in hr.clean_env({"ELECTRON_RUN_AS_NODE": "1", "PATH": "x"}))
        cleanup(tmp)
        for f in ("host.json", "restart.json", "survivor.pid"):
            (tmp / f).unlink(missing_ok=True)

        # --- 2：坏坐标（appPid 已死）------------------------------------------
        dead = subprocess.Popen([PY, "-c", "import time; time.sleep(0.1)"])
        dead.wait()
        hr.write_json(tmp / "host.json", {
            "v": 1, "at": int(time.time() * 1000), "exe": PY,
            "appPid": dead.pid, "hostPid": None, "cwd": str(tmp), "version": "ghost",
        })
        bystander = subprocess.Popen([PY, "-c", "import time; time.sleep(30)"])
        try:
            res = hr.perform_restart(see=tmp, spawn_cmd=[PY, "-c", "pass"], wait_idle=False,
                                     back_timeout=5, log=lambda _m: None, notify=lambda _t: None)
            check("坏坐标：拒绝并说明原因",
                  res.get("ok") is False and "appPid" in str(res.get("reason")), str(res.get("reason")))
            check("坏坐标：没有误杀别的进程", hr.pid_alive(bystander.pid))
        finally:
            bystander.kill()
        for f in ("host.json", "restart.json"):
            (tmp / f).unlink(missing_ok=True)

        # --- 3：新进程起不来 ---------------------------------------------------
        app = start_fake(tmp, "3")
        res = hr.perform_restart(see=tmp, spawn_cmd=[PY, "-c", "pass"], wait_idle=False,
                                 kill_timeout=4, back_timeout=4,
                                 log=lambda _m: None, notify=lambda _t: None)
        check("起不来：4 秒内判失败，不卡死", res.get("ok") is False and res.get("reason") == "host-not-back",
              str(res.get("reason")))
        check("起不来：旧进程已被收掉（DSH 确实被关了）", not hr.pid_alive(app["appPid"]))
        check("起不来：窗口仍在（它可以再点一次）", hr.pid_alive(app.get("survivor") or 0))
        intent = hr.read_json(tmp / "restart.json") or {}
        check("起不来：相位是 failed 且带原因",
              intent.get("phase") == "failed" and bool(intent.get("reason")), str(intent.get("reason")))

        # --- 4：等空闲 ---------------------------------------------------------
        for f in ("host.json", "restart.json", "survivor.pid"):
            (tmp / f).unlink(missing_ok=True)
        app = start_fake(tmp, "4")
        hr.write_json(tmp / "turn-state.json", {
            "session-x": {"state": "running", "startedAt": int(time.time() * 1000)},
        })
        t0 = time.time()
        res = hr.perform_restart(see=tmp, spawn_cmd=[PY, "-c", "pass"], wait_idle=True,
                                 wait_idle_sec=2, kill_timeout=4, back_timeout=3,
                                 log=lambda _m: None, notify=lambda _t: None)
        check("等空闲：超时就放弃，不动进程",
              res.get("ok") is False and res.get("reason") == "wait-idle-timeout", str(res.get("reason")))
        check("等空闲：旧进程没被动过", hr.pid_alive(app["appPid"]), f"{time.time() - t0:.1f}s")
        (tmp / "turn-state.json").unlink(missing_ok=True)
        cleanup(tmp)

        # --- 5：排队（不设上限）→ 回合结束后自己动手 ---------------------------
        for f in ("host.json", "restart.json", "survivor.pid"):
            (tmp / f).unlink(missing_ok=True)
        app = start_fake(tmp, "5")
        hr.write_json(tmp / "turn-state.json", {
            "session-y": {"state": "running", "startedAt": int(time.time() * 1000)},
        })
        seen_phases = []

        def _sample():
            while time.time() - t0 < 10:
                it = hr.read_json(tmp / "restart.json") or {}
                ph = it.get("phase")
                if ph and (not seen_phases or seen_phases[-1] != ph):
                    seen_phases.append(ph)
                time.sleep(0.15)

        sampler = threading.Thread(target=_sample, daemon=True)
        sampler.start()

        def _clear_turn():
            time.sleep(2.0)
            (tmp / "turn-state.json").unlink(missing_ok=True)

        threading.Thread(target=_clear_turn, daemon=True).start()
        res = hr.perform_restart(see=tmp, spawn_cmd=[PY, "-c", FAKE_APP, str(tmp), "6", FAKE_HOST],
                                 wait_idle=True, wait_idle_sec=None, kill_timeout=4, back_timeout=20,
                                 log=lambda _m: None, notify=lambda _t: None)
        check("排队：不设上限时等到回合结束就动手", res.get("ok") is True, str(res.get("reason")))
        check("排队：等待期间相位被记成 waiting-idle", "waiting-idle" in seen_phases, "/".join(seen_phases))
        check("排队：新版本号是排队之后那一轮", str(read_host(tmp).get("version")) == "fake-6",
              str(read_host(tmp).get("version")))
        cleanup(tmp)

        # --- 6：旧版插件（不写 host.json）→ 进程起来了就不能报失败 -----------------
        for f in ("host.json", "restart.json", "survivor.pid"):
            (tmp / f).unlink(missing_ok=True)
        app = start_fake(tmp, "7")
        said = []
        res = hr.perform_restart(see=tmp, spawn_cmd=[PY, "-c", "import time; time.sleep(30)"],
                                 wait_idle=False, kill_timeout=4, back_timeout=3,
                                 log=lambda _m: None, notify=said.append)
        check("旧版插件：不报失败（进程起来了就是起来了）", res.get("ok") is True, str(res.get("reason")))
        check("旧版插件：相位是 degraded 且说明了原因",
              res.get("phase") == "degraded" and "旧版" in res.get("text", ""), str(res.get("phase")))
        check("旧版插件：窗口报了「没法自核」", any("没法自核" in s for s in said), " / ".join(said[-1:]))
        intent = hr.read_json(tmp / "restart.json") or {}
        check("旧版插件：相位写 launched-legacy（插件不会误当重启完成）",
              intent.get("phase") == "launched-legacy", str(intent.get("phase")))
        cleanup(tmp)
    except Exception as e:  # noqa: BLE001
        print(f"ERROR {type(e).__name__}: {e}")
        cleanup(tmp)
        return 2
    finally:
        cleanup(tmp)
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILED:
        print(f"失败 {len(FAILED)} 条：{'；'.join(FAILED)}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
