# File: autopush.py
import os, time, subprocess, threading
from datetime import datetime
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# === Config ===
REPO_DIR = os.path.abspath(os.path.dirname(__file__))  # cartella della repo
BRANCH = "main"
DEBOUNCE_SEC = 5  # accorpa salvataggi ravvicinati

# Estensioni utili (ignoro roba binaria e pesante)
INCLUDE_EXT = {
    ".py",".js",".jsx",".ts",".tsx",".json",".md",".txt",".yaml",".yml",".toml",
    ".ini",".csv",".ipynb",".css",".html",".ico",".svg",".bat",".ps1"
}
# Cartelle da ignorare sempre
EXCLUDE_DIRS = {".git", "node_modules", "dist", "build", "__pycache__"}

def run(cmd):
    return subprocess.run(cmd, cwd=REPO_DIR, shell=True, capture_output=True, text=True)

def inside_repo() -> bool:
    r = run("git rev-parse --is-inside-work-tree")
    return r.returncode == 0 and (r.stdout.strip() == "true" or r.stderr == "")

def get_remote_url():
    r = run("git remote get-url origin")
    if r.returncode == 0:
        return (r.stdout or "").strip()
    return None

def has_head() -> bool:
    r = run("git rev-parse --verify HEAD")
    return r.returncode == 0

def ensure_branch(branch: str):
    run(f"git checkout -B {branch}")

def bootstrap_initial_commit():
    run("git add -A")
    status = run("git status --porcelain")
    if status.stdout.strip():
        c = run('git commit -m "chore: initial commit"')
        if c.returncode != 0:
            print("[ERRORE] Impossibile creare il commit iniziale:")
            print((c.stderr or c.stdout).strip())

class DebouncedPusher:
    def __init__(self, delay):
        self.delay = delay
        self.timer = None
        self.lock = threading.Lock()

    def schedule(self):
        with self.lock:
            if self.timer:
                self.timer.cancel()
            self.timer = threading.Timer(self.delay, self.do_push)
            self.timer.start()

    def do_push(self):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Se non c'è HEAD (repo appena creata), prova a committare subito
        if not has_head():
            bootstrap_initial_commit()

        # Prova a sincronizzarti con il remoto solo se esiste
        remote_url = get_remote_url()
        if remote_url:
            fetch = run(f"git fetch origin {BRANCH}")
            if fetch.returncode == 0:
                rev_list = run(f"git rev-list --count HEAD..origin/{BRANCH}")
                if rev_list.returncode == 0:
                    try:
                        remote_ahead = int((rev_list.stdout or "0").strip() or "0")
                    except ValueError:
                        remote_ahead = 0
                    if remote_ahead > 0:
                        pull = run(f"git pull --rebase origin {BRANCH}")
                        if pull.returncode != 0:
                            print("[ERRORE PULL]", (pull.stderr or pull.stdout).strip())
                            return
            # se fetch fallisce, proseguo comunque con commit locali

        run("git add -A")
        status = run("git status --porcelain")
        if not status.stdout.strip():
            print("[skip] nulla da committare")
            return

        commit = run(f'git commit -m "auto: sync {ts}"')
        if commit.returncode != 0:
            out = (commit.stdout + "\n" + commit.stderr).lower()
            if "nothing to commit" in out or "no changes added to commit" in out:
                print("[skip] nulla da committare")
                return
            print("[ERRORE COMMIT]", (commit.stderr or commit.stdout).strip())
            return

        if get_remote_url():
            push = run(f"git push origin {BRANCH}")
            if push.returncode != 0:
                print("[ERRORE PUSH]", (push.stderr or push.stdout).strip())
            else:
                print(f"[OK] Pushed at {ts}")
        else:
            print(f"[OK] Commit locale creato alle {ts} (nessun remote configurato).")

class Handler(FileSystemEventHandler):
    def __init__(self, pusher):
        self.pusher = pusher

    def on_any_event(self, event):
        if event.is_directory:
            return
        rel = os.path.relpath(event.src_path, REPO_DIR)
        parts = rel.split(os.sep)
        if any(p in EXCLUDE_DIRS for p in parts):
            return
        ext = os.path.splitext(rel)[1].lower()
        if INCLUDE_EXT and ext and ext not in INCLUDE_EXT:
            return
        self.pusher.schedule()

if __name__ == "__main__":
    if not inside_repo():
        print("[ERRORE GIT] Qui non sembra esserci una repo git. Esegui `git init` prima, oppure sposta lo script nella repo.")
        try:
            input("\nPremi INVIO per chiudere...")
        except:
            pass
        raise SystemExit(1)

    co = run(f"git checkout -B {BRANCH}")
    if co.returncode != 0:
        print("[ERRORE GIT] Impossibile fare checkout del branch.")
        print((co.stderr or co.stdout).strip())
        try:
            input("\nPremi INVIO per chiudere...")
        except:
            pass
        raise SystemExit(1)

    # Primo commit al volo se repo appena creata
    if not has_head():
        bootstrap_initial_commit()

    pusher = DebouncedPusher(DEBOUNCE_SEC)
    obs = Observer()
    obs.schedule(Handler(pusher), REPO_DIR, recursive=True)
    obs.start()
    print("✅ Autopush attivo. Lascia questa finestra aperta.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        obs.stop()
        obs.join()
        try:
            input("\nInterrotto. Premi INVIO per chiudere...")
        except:
            pass
