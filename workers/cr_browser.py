"""Content Rewards in the owner's own logged-in Chrome (same setup as wn-watcher: real Chrome, own profile, CDP).

No --enable-automation flag, so the site sees a normal browser. The profile lives on E: and holds only the CR login.
Navigation is by clicks only (owner's wish): <target> is a sidebar label (Discover, Settings, ...) or a campaign id/url,
reached by clicking its card. The site is opened once per run; Chrome closes when the run is done.
Usage: cr_browser.py open [target]     start Chrome (if needed) and show the CR tab, e.g. to log in once
       cr_browser.py dump <target>     JSON: page text, links, JSON API calls seen while getting there
       cr_browser.py discover          JSON: campaigns the Discover page loads
       cr_browser.py join <target>     join a campaign, JSON: page text with the brief
       cr_browser.py click <target> <label> [shot]  click a button/tab, JSON: text and buttons after
Output is one JSON object on stdout.
"""
import json
import os
import random
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


def ensure_chrome() -> bool:
    """Starts the CR Chrome if it is not running. True when this run started it."""
    if port_open():
        return False
    exe = next((p for p in CHROME if p.is_file()), None)
    if not exe:
        raise SystemExit(json.dumps({"error": "Chrome not found"}))
    PROFILE.mkdir(parents=True, exist_ok=True)
    subprocess.Popen([str(exe), f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                      "--no-first-run", "--no-default-browser-check", "--mute-audio", "--start-maximized", HOME],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if port_open():
            return True
        time.sleep(0.5)
    raise SystemExit(json.dumps({"error": "Chrome debug port did not open"}))


def with_page(fn):
    """Runs fn on the one CR tab. The site is opened once (HOME); after that the bot only clicks, like a person."""
    import msvcrt
    from playwright.sync_api import sync_playwright
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
        ensure_chrome()  # inside the lock: a run that waited never finds a Chrome that is closing
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
            ctx = browser.contexts[0]
            page = next((p for p in ctx.pages if "contentrewards.com" in p.url), None)
            if not page:
                page = ctx.new_page()
                page.goto(HOME, wait_until="networkidle", timeout=60_000)
            page.bring_to_front()
            try:  # full screen, also when the owner left the window small
                cdp = ctx.new_cdp_session(page)
                win = cdp.send("Browser.getWindowForTarget")["windowId"]
                cdp.send("Browser.setWindowBounds", {"windowId": win, "bounds": {"windowState": "maximized"}})
            except Exception:
                pass
            try:
                return fn(page)
            finally:
                if sys.argv[1:2] != ["open"]:  # owner's wish: the CR Chrome closes when a run is done; "open" (to log in) keeps it
                    browser.new_browser_cdp_session().send("Browser.close")


def pause(lo: float = 0.4, hi: float = 1.2) -> None:
    """A person's think time between actions: never two clicks in the same instant."""
    time.sleep(random.uniform(lo, hi))


def move_to(page, x: float, y: float) -> None:
    """Moves the pointer in a slightly curved path with many small steps, like a hand on a mouse."""
    sx, sy = getattr(page, "_cr_xy", (random.uniform(200, 900), random.uniform(150, 600)))
    mx, my = (sx + x) / 2 + random.uniform(-80, 80), (sy + y) / 2 + random.uniform(-60, 60)
    n = random.randint(14, 28)
    for i in range(1, n + 1):
        t = i / n
        page.mouse.move((1 - t) ** 2 * sx + 2 * (1 - t) * t * mx + t * t * x, (1 - t) ** 2 * sy + 2 * (1 - t) * t * my + t * t * y)
        time.sleep(random.uniform(0.006, 0.02))
    page._cr_xy = (x, y)


def human_click(page, el, timeout: int = 15_000) -> None:
    """Scrolls el into view, glides the pointer to a random spot inside it, hovers a moment, then clicks."""
    el.scroll_into_view_if_needed(timeout=timeout)
    box = el.bounding_box(timeout=timeout)
    if not box:
        el.click(timeout=timeout)
        return
    move_to(page, box["x"] + box["width"] * random.uniform(0.3, 0.7), box["y"] + box["height"] * random.uniform(0.3, 0.7))
    pause(0.15, 0.5)
    el.click(timeout=timeout, position={"x": box["width"] * random.uniform(0.35, 0.65), "y": box["height"] * random.uniform(0.35, 0.65)})
    pause()


def scroll(page, total: int = 1600) -> None:
    """Scrolls total pixels in a few uneven wheel turns with short reading pauses."""
    done = 0
    while done < total:
        step = random.randint(220, 520)
        page.mouse.wheel(0, step)
        done += step
        time.sleep(random.uniform(0.15, 0.6))
    pause(0.6, 1.6)


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
        human_click(page, links.nth(i))
        return settle(page)
    raise SystemExit(json.dumps({"error": f"no clickable sidebar link: {label}"}))


def campaign_id(target: str) -> str | None:
    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", target)
    return m.group(1) if m else None


def search(page, cid: str, name: str) -> bool:
    """Types the campaign title in Discover's search bar (it shows a few seconds after load) and clicks the matching card."""
    nav(page, "Discover")
    box = page.locator("input[placeholder]:visible, textarea[placeholder]:visible").last  # the sidebar has no input; the bar sits at the bottom
    try:
        box.wait_for(timeout=20_000)
    except Exception:
        return False
    human_click(page, box)
    page.keyboard.type(name, delay=random.randint(40, 110))
    pause()
    page.keyboard.press("Enter")
    settle(page)
    card = page.locator(f'a[href*="/campaigns/{cid}"]').filter(visible=True)
    try:
        card.first.wait_for(timeout=15_000)
    except Exception:
        return False
    human_click(page, card.first)
    settle(page)
    return cid in page.url


def go(page, target: str, name: str = "") -> None:
    """Gets to target by clicking: a sidebar label, or a campaign via Discover search, or its card on Campaigns (joined) or Discover."""
    cid = campaign_id(target)
    if not cid:
        return nav(page, target or "Campaigns")
    if cid in page.url:
        return
    if name and search(page, cid, name):
        return
    for section in ("Campaigns", "Discover"):
        nav(page, section)
        card = page.locator(f'a[href*="/campaigns/{cid}"]')
        for _ in range(15):  # cards load while scrolling; Discover rows also page sideways
            if card.count() or (section == "Discover" and page_rows(page, card.count)):
                human_click(page, card.filter(visible=True).first)
                return settle(page)
            scroll(page, random.randint(1200, 2200))
    # Not on Discover as a link: joined cards are "Preview <name>" buttons, so open each until the id matches.
    nav(page, "Campaigns")
    names = [b.get_attribute("aria-label") for b in page.locator('button[aria-label^="Preview "]').all()]
    for name in names:
        nav(page, "Campaigns")
        btn = page.locator(f'button[aria-label="{name}"]')
        if not btn.count():  # list did not render this card again: skip it, not fail the whole run
            continue
        human_click(page, btn.filter(visible=True).first)
        settle(page)
        if cid in page.url:
            return
    raise SystemExit(json.dumps({"error": f"campaign card not found: {cid}"}))


def click_label(page, label: str) -> None:
    for role in ("button", "tab", "link", "menuitem"):
        el = page.get_by_role(role, name=label, exact=True)
        if el.count():
            return human_click(page, el.filter(visible=True).first)
    human_click(page, page.get_by_text(label, exact=True).filter(visible=True).first)


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


def page_rows(page, found=None) -> bool:
    """Click each on-screen row's "Scroll forward" arrow until it greys out: rows show only ~7 cards until paged.
    Stops early and returns True once found() is true."""
    for _ in range(60):  # shortcut: cap per scroll round, so a row that never disables cannot loop forever
        if found and found():
            return True
        arrow = page.locator('button[aria-label="Scroll forward"]:not([disabled])').filter(visible=True)
        h = page.evaluate("innerHeight")  # real Chrome over CDP: viewport_size is None
        btn = next((arrow.nth(i) for i in range(arrow.count()) if (b := arrow.nth(i).bounding_box()) and 0 < b["y"] < h - 40), None)
        if btn is None:
            return bool(found and found())
        human_click(page, btn)
        page.wait_for_timeout(random.randint(500, 1100))


# Joined cards are server-rendered (no JSON): per "Preview <name>" button, its card's text.
JOINED_JS = r"""bs => bs.map(b => {
  let e = b;
  while (e.parentElement && e.parentElement.querySelectorAll('button[aria-label^="Preview "]').length === 1) e = e.parentElement;
  const t = e.innerText.replace(/\s+/g, ' '), m = /\$([\d.,]+K?)\s*\/\s*\$([\d.,]+K?)/.exec(t);
  return { name: b.getAttribute('aria-label').slice(8), closed: /submissions closed/i.test(t), spent: m ? m[1] : null, budget: m ? m[2] : null };
})"""


def discover() -> dict:
    """All campaigns the Discover page loads, from CR's own JSON responses (the site's fetches; ours get 'Failed to fetch').
    Scrolls down like a person reading until no new campaigns load (the list pages in while scrolling)."""
    def run(page):
        seen = []
        nav(page, "Campaigns")  # leave Discover first, so clicking it loads the list fresh; also read our joined cards here
        page.wait_for_timeout(random.randint(1500, 2500))
        joined = page.eval_on_selector_all('button[aria-label^="Preview "]', JOINED_JS)
        page.on("response", lambda r: seen.append(r) if "/api/campaign/campaigns/discover" in r.url else None)
        nav(page, "Discover")
        out, read, still = {}, 0, 0
        for _ in range(25):  # at most ~25 scroll rounds; stops once three rounds bring nothing new
            for r in seen[read:]:
                try:
                    data = r.json().get("data")
                except Exception:
                    continue
                rows = data if isinstance(data, list) else (data or {}).get("campaigns") if isinstance(data, dict) else None
                for c in rows or []:
                    if isinstance(c, dict) and c.get("id") and c.get("name"):
                        out[c["id"]] = c
            before, read = len(out), len(seen)
            page_rows(page)
            move_to(page, random.uniform(400, 1100), random.uniform(250, 650))
            scroll(page, random.randint(1400, 2600))
            page.wait_for_timeout(random.randint(800, 1800))
            still = still + 1 if len(out) == before else 0
            if still >= 3:
                break
        return {"campaigns": list(out.values()), "joined": joined}
    return with_page(run)


DOC_HOSTS = ("notion.so", "notion.site", "notion.com", "docs.google.com", "reachclipping.com")


def read_docs(page) -> str:
    """Text of the brief's rules docs (Notion, Google Docs), opened by clicking their links; they render in JS, so fetch() sees nothing."""
    hrefs = page.eval_on_selector_all("a[href]", "as => as.map(a => a.href)")
    out = []
    for href in list(dict.fromkeys(h for h in hrefs if any(d in h for d in DOC_HOSTS)))[:3]:
        try:
            with page.context.expect_page(timeout=15_000) as info:
                human_click(page, page.locator(f'a[href="{href}"]').first)
            doc = info.value
            doc.wait_for_load_state("domcontentloaded")
            move_to(doc, random.uniform(500, 800), random.uniform(300, 500))  # Notion scrolls an inner panel: the wheel only reaches it with the pointer over the page
            text, same = "", 0
            for _ in range(16):  # JS docs (Notion) fill in while scrolling: stop once the text stops growing twice in a row
                scroll(doc, random.randint(1800, 3000))
                now = doc.inner_text("body")
                same = same + 1 if len(now) > 200 and len(now) == len(text) else 0
                if same >= 2:
                    break
                text = now
            out.append(now[:12000])
            pause(1, 3)
            doc.close()  # only the tab this click opened
        except Exception as e:
            out.append(f"(could not read {href.split('?')[0]}: {type(e).__name__})")
    return "\n".join(out)


def join(target: str, name: str = "") -> dict:
    """Joins a campaign (owner allowed this) and returns the page text, which shows the brief only after joining."""
    def run(page):
        go(page, target, name)
        if "Joined" not in page.inner_text("body"):
            scroll(page, random.randint(300, 900))  # read the card before joining
            human_click(page, page.get_by_role("button", name="Join Campaign").filter(visible=True).first)  # the page has a hidden copy for small screens
            page.wait_for_timeout(4000)
            settle(page)
        more = page.get_by_role("button", name="Show more")
        if more.count():
            human_click(page, more.filter(visible=True).first)
            page.wait_for_timeout(800)
        text = page.inner_text("body")
        return {"joined": "Joined" in text, "text": text[:20000], "docs": read_docs(page)}
    return with_page(run)


if __name__ == "__main__":
    cmd, arg, name = (sys.argv[1:] + ["", "", ""])[:3]
    if cmd == "open":
        with_page(lambda page: go(page, arg, name) if arg else None)
        print(json.dumps({"ok": True}))
    elif cmd == "dump":
        print(json.dumps(dump(arg)))
    elif cmd == "discover":
        print(json.dumps(discover()))
    elif cmd == "join":
        print(json.dumps(join(arg, name)))
    elif cmd == "click":
        print(json.dumps(click(arg, sys.argv[3], (sys.argv[4:] or [""])[0])))
    else:
        raise SystemExit(__doc__)
