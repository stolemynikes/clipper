"""Content Rewards in the owner's own logged-in Chrome (same setup as wn-watcher: real Chrome, own profile, CDP).

No --enable-automation flag, so the site sees a normal browser. The profile lives on E: and holds only the CR login.
Navigation is by clicks only (owner's wish): <target> is a sidebar label (Discover, Settings, ...) or a campaign id/url,
reached by clicking its card. The site itself is opened once, in one tab that stays open.
Usage: cr_browser.py open [target]     start Chrome (if needed) and show the CR tab, e.g. to log in once
       cr_browser.py dump <target>     JSON: page text, links, JSON API calls seen while getting there
       cr_browser.py discover          JSON: campaigns the Discover page loads
       cr_browser.py join <target>     join a campaign, JSON: page text with the brief
       cr_browser.py click <target> <label> [shot]  click a button/tab, JSON: text and buttons after
Output is one JSON object on stdout.
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / "data" / "cr-chrome"
LOCK = ROOT / "data" / "cr-chrome.lock"
PORT = 9333  # wn-watcher uses 9222: never share its browser
CHROME = [Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
          Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"]
HOME = "https://contentrewards.com/c/campaigns"


def port_open() -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def ensure_chrome() -> None:
    if port_open():
        return
    exe = next((p for p in CHROME if p.is_file()), None)
    if not exe:
        raise SystemExit(json.dumps({"error": "Chrome not found"}))
    PROFILE.mkdir(parents=True, exist_ok=True)
    subprocess.Popen([str(exe), f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                      "--no-first-run", "--no-default-browser-check", "--mute-audio", HOME],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if port_open():
            return
        time.sleep(0.5)
    raise SystemExit(json.dumps({"error": "Chrome debug port did not open"}))


def with_page(fn):
    """Runs fn on the one CR tab. The site is opened once (HOME); after that the bot only clicks, like a person."""
    import msvcrt
    from playwright.sync_api import sync_playwright
    ensure_chrome()
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK, "a+b") as lock:
        for _ in range(600):  # one command at a time on the shared tab; the OS frees the lock if a run dies
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                time.sleep(1)
        else:
            raise SystemExit(json.dumps({"error": "CR tab busy"}))
        with sync_playwright() as pw:
            ctx = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}").contexts[0]
            page = next((p for p in ctx.pages if "contentrewards.com" in p.url), None)
            if not page:
                page = ctx.new_page()
                page.goto(HOME, wait_until="networkidle", timeout=60_000)
            page.bring_to_front()
            return fn(page)  # the tab stays open for the next run


def settle(page) -> None:
    page.wait_for_load_state("networkidle", timeout=60_000)
    page.wait_for_timeout(1500)


def nav(page, label: str) -> None:
    """Clicks a sidebar item (Discover, Campaigns, Settings, Submissions, ...)."""
    links = page.get_by_role("link", name=label, exact=True)
    for i in range(links.count()):  # an icon rail and the open sidebar both carry the link; only one takes clicks
        try:
            links.nth(i).click(timeout=3000, trial=True)
        except Exception:
            continue
        links.nth(i).click(timeout=15_000)
        return settle(page)
    raise SystemExit(json.dumps({"error": f"no clickable sidebar link: {label}"}))


def campaign_id(target: str) -> str | None:
    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", target)
    return m.group(1) if m else None


def go(page, target: str) -> None:
    """Gets to target by clicking: a sidebar label, or a campaign via its card on Campaigns (joined) or Discover."""
    cid = campaign_id(target)
    if not cid:
        return nav(page, target or "Campaigns")
    if cid in page.url:
        return
    for section in ("Campaigns", "Discover"):
        nav(page, section)
        card = page.locator(f'a[href*="/campaigns/{cid}"]')
        for _ in range(15):  # cards load while scrolling
            if card.count():
                card.first.click(timeout=15_000)
                return settle(page)
            page.mouse.wheel(0, 4000)
            page.wait_for_timeout(1200)
    raise SystemExit(json.dumps({"error": f"campaign card not found: {cid}"}))


def click_label(page, label: str) -> None:
    for role in ("button", "tab", "link", "menuitem"):
        el = page.get_by_role(role, name=label, exact=True)
        if el.count():
            el.first.click(timeout=15_000)
            return
    page.get_by_text(label, exact=True).first.click(timeout=15_000)


def dump(target: str) -> dict:
    def run(page):
        seen = []
        page.on("response", lambda r: seen.append(r) if "json" in (r.headers.get("content-type") or "") else None)
        go(page, target)
        calls = []
        for r in seen:
            try:
                body = r.json() if "/api/" in r.url else None
            except Exception:
                body = None
            calls.append({"url": r.url.split("?")[0], "method": r.request.method, "status": r.status, "body": body})
        links = page.eval_on_selector_all("a[href]", "as => as.map(a => ({text: a.innerText.trim().slice(0, 80), href: a.href}))")
        return {"url": page.url, "title": page.title(), "text": page.inner_text("body")[:20000], "links": links, "json": calls}
    return with_page(run)


def click(target: str, label: str, shot: str = "") -> dict:
    """Goes to target, clicks the first button named label, returns what changed: API writes and the visible text after."""
    def run(page):
        writes = []
        page.on("response", lambda r: writes.append({"url": r.url.split("?")[0], "method": r.request.method, "status": r.status,
                                                     "req": r.request.post_data})
                if r.request.method != "GET" and "/api/" in r.url else None)
        go(page, target)
        click_label(page, label)
        page.wait_for_timeout(4000)
        if shot:
            page.screenshot(path=shot)
        buttons = [b.inner_text().strip() for b in page.get_by_role("button").all() if b.is_visible()]
        return {"url": page.url, "text": page.inner_text("body")[:8000], "buttons": [b for b in buttons if b], "writes": writes}
    return with_page(run)


def discover() -> dict:
    """All campaigns the Discover page loads, from CR's own JSON responses (the site's fetches; ours get 'Failed to fetch').
    shortcut: only what the page loads on open (~100 campaigns, no scrolling for more pages), fine while that covers the GTA/streamer rows."""
    def run(page):
        seen = []
        if "/c/discover" in page.url:
            nav(page, "Campaigns")  # leave first, so clicking Discover loads the list fresh
        page.on("response", lambda r: seen.append(r) if "/api/campaign/campaigns/discover" in r.url else None)
        nav(page, "Discover")
        out = {}
        for r in seen:
            try:
                data = r.json().get("data")
            except Exception:
                continue
            rows = data if isinstance(data, list) else (data or {}).get("campaigns") if isinstance(data, dict) else None
            for c in rows or []:
                if isinstance(c, dict) and c.get("id") and c.get("name"):
                    out[c["id"]] = c
        return {"campaigns": list(out.values())}
    return with_page(run)


def join(target: str) -> dict:
    """Joins a campaign (owner allowed this) and returns the page text, which shows the brief only after joining."""
    def run(page):
        go(page, target)
        if "Joined" not in page.inner_text("body"):
            page.get_by_role("button", name="Join Campaign").first.click(timeout=15_000)
            page.wait_for_timeout(4000)
            settle(page)
        text = page.inner_text("body")
        return {"joined": "Joined" in text, "text": text[:20000]}
    return with_page(run)


if __name__ == "__main__":
    cmd, arg = (sys.argv[1:] + ["", ""])[:2]
    if cmd == "open":
        with_page(lambda page: go(page, arg) if arg else None)
        print(json.dumps({"ok": True}))
    elif cmd == "dump":
        print(json.dumps(dump(arg)))
    elif cmd == "discover":
        print(json.dumps(discover()))
    elif cmd == "join":
        print(json.dumps(join(arg)))
    elif cmd == "click":
        print(json.dumps(click(arg, sys.argv[3], (sys.argv[4:] or [""])[0])))
    else:
        raise SystemExit(__doc__)
