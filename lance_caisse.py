#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🍺 Lanceur de Caisse — Windows
Lance automatiquement tous les serveurs et ouvre la caisse dans le navigateur.
"""

import tkinter as tk
from tkinter import messagebox
import subprocess
import threading
import sys
import os
import time
import webbrowser
import shutil
import urllib.request
import json
import socket

# ─── Chemins ──────────────────────────────────────────────────────────────────
if getattr(sys, "frozen", False):
    SCRIPT_DIR = os.path.dirname(sys.executable)
else:
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# PIDs des processus lancés (pour pouvoir les arrêter)
processes = []

# ══════════════════════════════════════════════════════════════════════════════
#  INTERFACE GRAPHIQUE
# ══════════════════════════════════════════════════════════════════════════════

class LanceurCaisse:
    def __init__(self, root):
        self.root = root
        self.root.title("🍺 Lancement de la Caisse")
        self.root.geometry("520x700")
        self.root.minsize(520, 700)
        self.root.resizable(True, True)
        self.root.configure(bg="#1a1a2e")

        # Centrer la fenêtre
        self.root.eval('tk::PlaceWindow . center')

        self._build_ui()

    def _build_ui(self):
        bg = "#1a1a2e"
        card = "#16213e"
        accent = "#e94560"
        text_light = "#eaeaea"
        text_dim = "#8892a4"
        green = "#4ade80"
        yellow = "#facc15"

        # Titre
        tk.Label(self.root, text="🍺 Caisse", font=("Segoe UI", 22, "bold"),
                 bg=bg, fg=accent).pack(pady=(22, 0))
        tk.Label(self.root, text="Système de lancement automatique",
                 font=("Segoe UI", 10), bg=bg, fg=text_dim).pack(pady=(2, 18))

        # ── Cadre de statut ──
        frame = tk.Frame(self.root, bg=card, bd=0, relief="flat",
                         highlightbackground="#2a2a4a", highlightthickness=1)
        frame.pack(padx=28, fill="x", pady=(0, 12))

        tk.Label(frame, text="État des services", font=("Segoe UI", 10, "bold"),
                 bg=card, fg=text_dim).pack(anchor="w", padx=16, pady=(12, 6))

        self.status_labels = {}
        services = [
            ("python",     "🐍 Python"),
            ("node",       "🟩 Node.js"),
            ("impression", "🖨️  Serveur impression"),
            ("eid",        "🪪 Pont eID (port 8765)"),
            ("bar",        "🌐 Serveur bar (port 8000)"),
            ("mail",       "📧 Serveur mail (port 3000)"),
            ("caisse",     "💻 Interface caisse"),
        ]
        for key, label in services:
            row = tk.Frame(frame, bg=card)
            row.pack(fill="x", padx=16, pady=2)
            tk.Label(row, text=label, font=("Segoe UI", 10),
                     bg=card, fg=text_light, width=26, anchor="w").pack(side="left")
            lbl = tk.Label(row, text="En attente…", font=("Segoe UI", 10),
                           bg=card, fg=text_dim, anchor="w")
            lbl.pack(side="left")
            self.status_labels[key] = lbl

        tk.Frame(frame, bg=card, height=10).pack()

        # ── Log ──
        log_frame = tk.Frame(self.root, bg=card,
                             highlightbackground="#2a2a4a", highlightthickness=1)
        log_frame.pack(padx=28, fill="x", pady=(0, 14))

        tk.Label(log_frame, text="Journal", font=("Segoe UI", 10, "bold"),
                 bg=card, fg=text_dim).pack(anchor="w", padx=16, pady=(10, 4))

        self.log_text = tk.Text(log_frame, height=6, bg="#0f0f23", fg="#a0f0a0",
                                font=("Consolas", 9), bd=0, relief="flat",
                                state="disabled", wrap="word",
                                insertbackground="white")
        self.log_text.pack(padx=10, pady=(0, 10), fill="x")

        # ── Choix du mode ──
        tk.Label(self.root, text="Mode de lancement", font=("Segoe UI", 10, "bold"),
                 bg=bg, fg=text_dim).pack(anchor="center")

        self.mode_var = tk.StringVar(value="local")
        mode_frame = tk.Frame(self.root, bg=bg)
        mode_frame.pack(pady=(2, 6))

        tk.Radiobutton(mode_frame, text="Serveur local (localhost:8000) — recommandé",
                       variable=self.mode_var, value="local",
                       bg=bg, fg=text_light, selectcolor=card,
                       activebackground=bg, activeforeground=text_light,
                       font=("Segoe UI", 9)).pack(anchor="w")
        tk.Radiobutton(mode_frame, text="Fichier direct (index.html sans serveur)",
                       variable=self.mode_var, value="enligne",
                       bg=bg, fg=text_light, selectcolor=card,
                       activebackground=bg, activeforeground=text_light,
                       font=("Segoe UI", 9)).pack(anchor="w")

        # ── Boutons ──
        btn_frame = tk.Frame(self.root, bg=bg)
        btn_frame.pack(pady=4)

        self.btn_launch = tk.Button(btn_frame, text="▶  Lancer la caisse",
                                    font=("Segoe UI", 11, "bold"),
                                    bg=accent, fg="white", relief="flat",
                                    padx=22, pady=10, cursor="hand2",
                                    activebackground="#c73652", activeforeground="white",
                                    command=self._start_launch_thread)
        self.btn_launch.pack(side="left", padx=6)

        self.btn_stop = tk.Button(btn_frame, text="⏹  Tout arrêter",
                                  font=("Segoe UI", 11),
                                  bg="#2a2a4a", fg=text_light, relief="flat",
                                  padx=22, pady=10, cursor="hand2",
                                  activebackground="#3a3a5a", activeforeground="white",
                                  state="disabled",
                                  command=self._stop_all)
        self.btn_stop.pack(side="left", padx=6)

        # Couleurs stockées pour référence
        self._colors = {
            "green": green, "yellow": yellow, "accent": accent,
            "text_dim": text_dim, "text_light": "#eaeaea"
        }

    # ── Helpers UI ─────────────────────────────────────────────────────────────

    def _set_status(self, key, text, color_key="text_light"):
        color = self._colors.get(color_key, "#eaeaea")
        self.status_labels[key].config(text=text, fg=color)

    def _log(self, msg):
        def _do():
            self.log_text.config(state="normal")
            self.log_text.insert("end", msg + "\n")
            self.log_text.see("end")
            self.log_text.config(state="disabled")
        self.root.after(0, _do)

    def _set_status_main(self, key, text, color_key):
        self.root.after(0, lambda: self._set_status(key, text, color_key))

    # ── Lancement (dans un thread séparé) ──────────────────────────────────────

    def _start_launch_thread(self):
        self._selected_mode = self.mode_var.get()
        self.btn_launch.config(state="disabled", text="Lancement…")
        self.btn_stop.config(state="disabled")
        t = threading.Thread(target=self._launch_all, daemon=True)
        t.start()

    def _launch_all(self):
        self._log("=== Démarrage du système de caisse ===")

        # 1. Vérifier Python
        self._set_status_main("python", "Vérification…", "yellow")
        py = shutil.which("python") or shutil.which("python3")
        if py:
            self._log(f"✅ Python détecté : {py}")
            self._set_status_main("python", "✅ Installé", "green")
        else:
            self._log("⚠️  Python non trouvé — installation depuis le dossier Installation/")
            self._set_status_main("python", "Installation…", "yellow")
            msix = os.path.join(SCRIPT_DIR, "Installation", "python-manager-26.0.msix")
            if os.path.exists(msix):
                self._log("📦 Installation de Python depuis python-manager-26.0.msix…")
                try:
                    result = subprocess.run(
                        ["powershell", "-Command",
                         f"Add-AppxPackage -Path '{msix}'"],
                        capture_output=True, text=True
                    )
                    if result.returncode == 0:
                        self._log("✅ Python installé avec succès !")
                        py = shutil.which("python") or shutil.which("python3")
                        self._set_status_main("python", "✅ Installé", "green")
                    else:
                        raise Exception(result.stderr.strip())
                except Exception as e:
                    self._log(f"❌ Échec installation Python : {e}")
                    self._set_status_main("python", "❌ Échec", "accent")
                    self._show_error("L'installation de Python a échoué.\nEssaie de double-cliquer sur :\nInstallation/python-manager-26.0.msix")
                    self._reset_btn()
                    return
            else:
                self._log("❌ Installeur Python introuvable dans Installation/")
                self._set_status_main("python", "❌ Introuvable", "accent")
                webbrowser.open("https://www.python.org/downloads/")
                self._show_error("python-manager-26.0.msix introuvable dans Installation/.\nLa page de téléchargement s'est ouverte.")
                self._reset_btn()
                return

        # 1bis. Vérifier openpyxl (nécessaire pour l'export Excel)
        self._log("🔍 Vérification du module openpyxl…")
        try:
            check = subprocess.run([py, "-c", "import openpyxl"], capture_output=True)
            has_openpyxl = (check.returncode == 0)
        except Exception:
            has_openpyxl = False
        if has_openpyxl:
            self._log("✅ openpyxl présent")
        else:
            self._log("⚠️  openpyxl non installé — installation en cours…")
            result = subprocess.run(
                [py, "-m", "pip", "install", "openpyxl", "--quiet", "--disable-pip-version-check"],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                self._log("✅ openpyxl installé")
            else:
                self._log("⚠️  Échec installation openpyxl — l'export Excel risque de ne pas fonctionner")

        # 2. Vérifier Node.js
        self._set_status_main("node", "Vérification…", "yellow")
        node = shutil.which("node")
        npm = shutil.which("npm")
        if node and npm:
            self._log(f"✅ Node.js détecté : {node}")
            self._set_status_main("node", "✅ Installé", "green")
        else:
            self._log("⚠️  Node.js non trouvé — installation depuis le dossier Installation/")
            self._set_status_main("node", "Installation…", "yellow")
            msi = os.path.join(SCRIPT_DIR, "Installation", "node-v25.8.1-x64.msi")
            if os.path.exists(msi):
                self._log(f"📦 Installation de Node.js depuis {msi}…")
                result = subprocess.run(
                    ["msiexec", "/i", msi, "/qb"],
                    capture_output=True
                )
                if result.returncode == 0:
                    self._log("✅ Node.js installé avec succès !")
                    # Rafraîchir le PATH
                    node_paths = [
                        r"C:\Program Files\nodejs",
                        r"C:\Program Files (x86)\nodejs",
                    ]
                    for np in node_paths:
                        if os.path.exists(os.path.join(np, "node.exe")):
                            os.environ["PATH"] = np + os.pathsep + os.environ.get("PATH", "")
                            node = os.path.join(np, "node.exe")
                            npm = os.path.join(np, "npm.cmd")
                            break
                    self._set_status_main("node", "✅ Installé", "green")
                else:
                    self._log("❌ Échec installation Node.js")
                    self._set_status_main("node", "❌ Échec installation", "accent")
                    self._show_error("L'installation de Node.js a échoué.\nEssaie de l'installer manuellement depuis :\nhttps://nodejs.org")
                    self._reset_btn()
                    return
            else:
                self._log("❌ Installeur Node.js introuvable dans Installation/")
                self._set_status_main("node", "❌ Introuvable", "accent")
                webbrowser.open("https://nodejs.org/fr/download")
                self._show_error("Node.js n'est pas installé et l'installeur est introuvable dans Installation/.\n\nLa page de téléchargement s'est ouverte.")
                self._reset_btn()
                return
        node = node or shutil.which("node")
        npm = npm or shutil.which("npm")

        # 3. npm install (server.js)
        server_js = os.path.join(SCRIPT_DIR, "server.js")
        if os.path.exists(server_js):
            self._log("📦 Installation des dépendances Node.js…")
            result = subprocess.run(
                ["npm", "install", "express", "nodemailer", "cors", "--silent"],
                cwd=SCRIPT_DIR, capture_output=True, text=True, shell=(sys.platform == "win32")
            )
            if result.returncode == 0:
                self._log("✅ Dépendances Node.js OK")
            else:
                self._log(f"⚠️  npm install: {result.stderr.strip()}")

        # 4. Serveur impression
        self._set_status_main("impression", "Démarrage…", "yellow")
        impression_py = self._find_file(["serveur_impression.py", "serveur_impression_v3TVA.py"])
        if impression_py:
            p = subprocess.Popen(
                [py, impression_py],
                cwd=SCRIPT_DIR,
                creationflags=subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0
            )
            processes.append(p)
            self._log(f"✅ Serveur impression lancé (PID {p.pid})")
            self._set_status_main("impression", f"✅ Actif (PID {p.pid})", "green")
        else:
            self._log("⚠️  serveur_impression.py introuvable — ignoré")
            self._set_status_main("impression", "⚠️  Introuvable", "yellow")

        # 4bis. Pont eID (lecture carte d'identité)
        self._set_status_main("eid", "Démarrage…", "yellow")
        eid_bridge_py = os.path.join(SCRIPT_DIR, "eid_bridge.py")
        if os.path.exists(eid_bridge_py):
            # Libérer le port 8765 si occupé
            subprocess.run(
                ["cmd", "/c", "for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :8765') do taskkill /F /PID %a"],
                capture_output=True, shell=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )
            time.sleep(0.3)
            p = subprocess.Popen(
                [py, eid_bridge_py],
                cwd=SCRIPT_DIR,
                creationflags=subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0
            )
            processes.append(p)
            self._log(f"✅ Pont eID lancé sur port 8765 (PID {p.pid})")
            self._set_status_main("eid", f"✅ Port 8765 (PID {p.pid})", "green")
        else:
            self._log("⚠️  eid_bridge.py introuvable — ignoré")
            self._set_status_main("eid", "⚠️  Introuvable", "yellow")

        # 5. Serveur bar / caisse (serveur.py port 8000) — selon le mode choisi
        mode = getattr(self, "_selected_mode", "local")
        serveur_py = os.path.join(SCRIPT_DIR, "serveur.py")
        bar_launched = False

        if mode == "enligne":
            self._log("ℹ️  Mode fichier direct sélectionné — serveur bar non lancé")
            self._set_status_main("bar", "Mode fichier direct", "text_dim")
        elif os.path.exists(serveur_py):
            self._set_status_main("bar", "Démarrage…", "yellow")
            # Libérer le port 8000 si occupé
            subprocess.run(
                ["cmd", "/c", "for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :8000') do taskkill /F /PID %a"],
                capture_output=True, shell=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )
            time.sleep(0.3)
            p = subprocess.Popen(
                [py, serveur_py],
                cwd=SCRIPT_DIR,
                creationflags=subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0
            )
            processes.append(p)
            bar_launched = True
            self._log(f"✅ Serveur bar lancé sur port 8000 (PID {p.pid})")
            self._set_status_main("bar", f"✅ Port 8000 (PID {p.pid})", "green")
        else:
            self._log("⚠️  serveur.py introuvable — mode fichier direct")
            self._set_status_main("bar", "⚠️  Mode fichier direct", "yellow")

        # 5bis. Lire l'URL du serveur mail dans config.json (si présent)
        server_url = "http://localhost:3000"
        config_path = os.path.join(SCRIPT_DIR, "config.json")
        if os.path.exists(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                server_url = cfg.get("serverUrl", server_url)
            except Exception as e:
                self._log(f"⚠️  Lecture config.json impossible : {e}")

        # 6. Serveur mail (server.js port 3000)
        self._set_status_main("mail", "Démarrage…", "yellow")
        if os.path.exists(server_js):
            p = subprocess.Popen(
                [node, server_js],
                cwd=SCRIPT_DIR,
                creationflags=subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0
            )
            processes.append(p)
            self._log(f"✅ Serveur mail lancé ({server_url})")
            self._set_status_main("mail", f"✅ {server_url}", "green")
        else:
            self._log("⚠️  server.js introuvable — serveur mail non lancé")
            self._set_status_main("mail", "⚠️  Introuvable", "yellow")

        # 7. Ouvrir la caisse dans le navigateur
        self._set_status_main("caisse", "Ouverture…", "yellow")
        time.sleep(1.2)

        if bar_launched:
            # Attendre que le serveur soit prêt (max 15s)
            self._log("⏳ Attente du démarrage du serveur…")
            for _ in range(30):
                try:
                    urllib.request.urlopen("http://localhost:8000/index.html", timeout=1)
                    break
                except Exception:
                    time.sleep(0.5)
            webbrowser.open("http://localhost:8000/index.html")
            self._log("🌐 Caisse ouverte → http://localhost:8000/index.html")
            self._set_status_main("caisse", "✅ Ouverte (localhost:8000)", "green")
        else:
            index = os.path.join(SCRIPT_DIR, "index.html")
            if os.path.exists(index):
                webbrowser.open(f"file:///{index.replace(os.sep, '/')}")
                self._log(f"🌐 Caisse ouverte → {index}")
                self._set_status_main("caisse", "✅ Ouverte (fichier local)", "green")
            else:
                self._log("❌ index.html introuvable")
                self._set_status_main("caisse", "❌ index.html introuvable", "accent")

        self._log("\n✅ Tout est lancé ! Fermez cette fenêtre pour TOUT arrêter.")

        # 8. Adresse GSM (même réseau), uniquement pertinent en mode serveur local
        if bar_launched:
            local_ip = self._get_local_ip()
            self._log(f"\n📱 Adresse GSM (même réseau) :\n   http://{local_ip}:8000/commande.html?mode=serveur")

        # Activer le bouton Stop
        self.root.after(0, lambda: self.btn_stop.config(state="normal"))
        self.root.after(0, lambda: self.btn_launch.config(
            text="✅ Lancé", bg="#1a4a2e", state="disabled"
        ))

    # ── Arrêt ──────────────────────────────────────────────────────────────────

    def _stop_all(self):
        self._log("\n🛑 Arrêt de tous les serveurs…")
        for p in processes:
            try:
                if sys.platform == "win32":
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                                   capture_output=True)
                else:
                    p.terminate()
                self._log(f"   → PID {p.pid} arrêté")
            except Exception as e:
                self._log(f"   ⚠️  {e}")
        processes.clear()

        for key in self.status_labels:
            if key != "python" and key != "node":
                self._set_status(key, "Arrêté", "text_dim")

        self.btn_launch.config(state="normal", text="▶  Lancer la caisse",
                               bg="#e94560")
        self.btn_stop.config(state="disabled")
        self._log("✅ Tous les serveurs sont arrêtés.")

    # ── Utilitaires ────────────────────────────────────────────────────────────

    def _get_local_ip(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"

    def _find_file(self, names):
        for name in names:
            path = os.path.join(SCRIPT_DIR, name)
            if os.path.exists(path):
                return path
        return None

    def _show_error(self, msg):
        self.root.after(0, lambda: messagebox.showerror("Erreur", msg, parent=self.root))

    def _reset_btn(self):
        self.root.after(0, lambda: self.btn_launch.config(
            state="normal", text="▶  Lancer la caisse"))

    def on_close(self):
        if processes:
            if messagebox.askyesno("Quitter",
                    "Des serveurs sont encore actifs.\nVoulez-vous les arrêter avant de quitter ?",
                    parent=self.root):
                self._stop_all()
        self.root.destroy()


# ══════════════════════════════════════════════════════════════════════════════
#  POINT D'ENTRÉE
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    root = tk.Tk()
    app = LanceurCaisse(root)
    root.protocol("WM_DELETE_WINDOW", app.on_close)
    root.mainloop()
