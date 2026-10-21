#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Serveur d'impression thermique pour imprimante ESC/POS
Port: 8088

Version avec détection automatique de l'imprimante :
  - L'imprimante n'est plus codée en dur (/dev/usb/lp1). Elle est retrouvée par
    son identifiant USB (vendorId:productId), même si son numéro lp0 / lp1 change
    après un rebranchement ou un changement d'ordinateur.
  - Le choix est enregistré dans imprimante_config.json (à côté de ce script).
  - Routes /printer/* utilisées par la page Paramètres pour détecter, tester et
    autoriser l'imprimante (règle udev, module usblp, groupe lp).
"""

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import getpass
import glob
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

# ─── Configuration ────────────────────────────────────────────────────────────
PORT = 8088
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "imprimante_config.json")
PRINTER_DEVICE_PAR_DEFAUT = "/dev/usb/lp1"     # ancien réglage : dernier recours
UDEV_RULE_FILE = "/etc/udev/rules.d/99-caisse-imprimante.rules"
LIEN_STABLE = "/dev/caisse_imprimante"          # créé par la règle udev
IS_LINUX = sys.platform.startswith("linux")

CONFIG_PAR_DEFAUT = {
    "mode": "auto",      # "auto" : retrouvée par vendorId:productId / "manual" : chemin fixe
    "vendorId": "",
    "productId": "",
    "serial": "",
    "name": "",
    "path": "",          # utilisé seulement en mode "manual"
}

RE_HEX4 = re.compile(r"^[0-9a-f]{4}$")
RE_CHEMIN_DEV = re.compile(r"^/dev/[A-Za-z0-9_./-]+$")
RE_UTILISATEUR = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
RE_MOTS_IMPRIMANTE = re.compile(
    r"print|imprim|thermal|receipt|epson|xprinter|bixolon|citizen|munbyn|rongta|"
    r"hprt|zjiang|gprinter|sewoo|star micro|\bpos\b|pos-?\d{2}", re.I)

_verrou_impression = threading.Lock()
_ctx = threading.local()      # dernière erreur d'impression, par requête


# ═══════════════════════════════════════════════════════════════════════════════
#  CONFIGURATION ENREGISTRÉE
# ═══════════════════════════════════════════════════════════════════════════════

def charger_config():
    cfg = dict(CONFIG_PAR_DEFAUT)
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for cle in CONFIG_PAR_DEFAUT:
                if isinstance(data.get(cle), str):
                    cfg[cle] = data[cle]
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"⚠️  Lecture de {CONFIG_FILE} impossible : {e}")
    return cfg


def sauver_config(cfg):
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_FILE)


def valider_config(cfg):
    """Lève ValueError si la configuration est invalide."""
    if cfg["mode"] not in ("auto", "manual"):
        raise ValueError("Mode inconnu (auto ou manual attendu).")
    for cle in ("vendorId", "productId"):
        if cfg[cle] and not RE_HEX4.match(cfg[cle]):
            raise ValueError(f"{cle} invalide (4 caractères hexadécimaux attendus).")
    if cfg["mode"] == "manual":
        if not RE_CHEMIN_DEV.match(cfg["path"]) or ".." in cfg["path"]:
            raise ValueError("Le chemin doit commencer par /dev/ (ex : /dev/usb/lp0).")


# ═══════════════════════════════════════════════════════════════════════════════
#  DÉTECTION (Linux : lecture de /sys, aucune commande root nécessaire)
# ═══════════════════════════════════════════════════════════════════════════════

def _lire(chemin):
    try:
        with open(chemin, "r", encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except Exception:
        return ""


def _dossier_usb_parent(chemin):
    """Remonte depuis une interface USB jusqu'au dossier du périphérique (celui qui a idVendor)."""
    p = os.path.realpath(chemin)
    for _ in range(4):
        if os.path.exists(os.path.join(p, "idVendor")):
            return p
        p = os.path.dirname(p)
    return None


def _infos_usb(dev_dir):
    vide = {"vendorId": "", "productId": "", "manufacturer": "", "product": "", "serial": ""}
    if not dev_dir:
        return vide
    return {
        "vendorId": _lire(os.path.join(dev_dir, "idVendor")).lower(),
        "productId": _lire(os.path.join(dev_dir, "idProduct")).lower(),
        "manufacturer": _lire(os.path.join(dev_dir, "manufacturer")),
        "product": _lire(os.path.join(dev_dir, "product")),
        "serial": _lire(os.path.join(dev_dir, "serial")),
    }


def _statut_acces(chemin):
    return {"exists": os.path.exists(chemin), "writable": os.access(chemin, os.W_OK)}


def lister_peripheriques_lp():
    """Tous les /dev/usb/lpN présents, avec le nom et l'identifiant USB de chaque imprimante."""
    resultats = []
    vus = set()
    for entree in sorted(glob.glob("/sys/class/usbmisc/lp*")):
        nom = os.path.basename(entree)
        chemin = "/dev/usb/" + nom
        vus.add(chemin)
        infos = _infos_usb(_dossier_usb_parent(os.path.join(entree, "device")))
        infos["path"] = chemin
        infos.update(_statut_acces(chemin))
        resultats.append(infos)
    # Filet de sécurité : nœuds présents dans /dev mais absents de sysfs
    for chemin in sorted(glob.glob("/dev/usb/lp*")):
        if chemin not in vus:
            infos = _infos_usb(None)
            infos["path"] = chemin
            infos.update(_statut_acces(chemin))
            resultats.append(infos)
    return resultats


def lister_autres_usb(deja_vus):
    """Périphériques USB qui ressemblent à une imprimante mais n'ont pas de /dev/usb/lpN."""
    resultats = []
    for dev_dir in sorted(glob.glob("/sys/bus/usb/devices/*")):
        base = os.path.basename(dev_dir)
        if ":" in base or base.startswith("usb"):
            continue
        vid = _lire(os.path.join(dev_dir, "idVendor")).lower()
        pid = _lire(os.path.join(dev_dir, "idProduct")).lower()
        if not vid or (vid, pid) in deja_vus:
            continue
        if _lire(os.path.join(dev_dir, "bDeviceClass")) == "09":      # hub
            continue
        infos = _infos_usb(dev_dir)
        nom = (infos["manufacturer"] + " " + infos["product"]).strip()
        classes = [_lire(os.path.join(i, "bInterfaceClass")) for i in glob.glob(dev_dir + ":*")]
        if "07" in classes:
            infos["raison"] = "Classe « imprimante » USB, mais aucun accès /dev/usb/lp (module usblp absent ?)"
        elif RE_MOTS_IMPRIMANTE.search(nom):
            infos["raison"] = "Le nom évoque une imprimante, mais elle ne se présente pas comme une imprimante USB standard"
        else:
            continue
        resultats.append(infos)
    return resultats


def infos_systeme():
    utilisateur = getpass.getuser()
    groupes_session = []
    try:
        import grp
        groupes_session = [grp.getgrgid(g).gr_name for g in os.getgroups()]
    except Exception:
        pass
    groupes_configures = groupes_session
    try:
        r = subprocess.run(["id", "-nG", utilisateur], capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            groupes_configures = r.stdout.split()
    except Exception:
        pass
    return {
        "utilisateur": utilisateur,
        "dansGroupeLp": "lp" in groupes_configures,
        "dansGroupeLpSession": "lp" in groupes_session,
        "peutUtiliserSudo": any(g in groupes_configures for g in ("sudo", "admin", "wheel")),
        "sudoInstalle": bool(shutil.which("sudo")),
        "moduleUsblp": os.path.isdir("/sys/module/usblp") or bool(glob.glob("/sys/class/usbmisc/lp*")),
        "regleUdev": os.path.exists(UDEV_RULE_FILE),
        "lienStable": os.path.exists(LIEN_STABLE),
    }


def resoudre_peripherique(config=None):
    """Retourne (chemin, explication). chemin vaut None si aucune imprimante n'est trouvée."""
    cfg = config or charger_config()

    if cfg["mode"] == "manual" and cfg["path"]:
        return cfg["path"], "chemin manuel"

    if not IS_LINUX:
        return None, "Détection automatique disponible uniquement sous Linux"

    lp = lister_peripheriques_lp()
    vid, pid, serie = cfg["vendorId"], cfg["productId"], cfg["serial"]

    if vid and pid:
        candidats = [d for d in lp if d["vendorId"] == vid and d["productId"] == pid]
        if serie:
            precis = [d for d in candidats if d["serial"] == serie]
            candidats = precis or candidats
        if candidats:
            return candidats[0]["path"], f"retrouvée par son identifiant USB {vid}:{pid}"
        if os.path.exists(LIEN_STABLE):
            return LIEN_STABLE, "lien udev stable"
        return None, f"Imprimante {vid}:{pid} introuvable (éteinte, débranchée ou câble sans données ?)"

    # Pas encore configurée
    if os.path.exists(LIEN_STABLE):
        return LIEN_STABLE, "lien udev stable"
    if len(lp) == 1:
        return lp[0]["path"], "seule imprimante USB détectée"
    if len(lp) > 1:
        accessibles = [d for d in lp if d["writable"]]
        return (accessibles or lp)[0]["path"], "plusieurs imprimantes : choisissez-en une dans les Paramètres"
    if os.path.exists(PRINTER_DEVICE_PAR_DEFAUT):
        return PRINTER_DEVICE_PAR_DEFAUT, "ancien réglage par défaut"
    return None, "Aucune imprimante USB détectée"


def detecter():
    if not IS_LINUX:
        return {"supporte": False, "plateforme": platform.system(),
                "message": "La détection automatique n'est disponible que sous Linux."}
    lp = lister_peripheriques_lp()
    chemin, raison = resoudre_peripherique()
    for d in lp:
        d["selectionne"] = (d["path"] == chemin)
    vus = {(d["vendorId"], d["productId"]) for d in lp}
    return {
        "supporte": True,
        "plateforme": platform.system(),
        "imprimantes": lp,
        "autresUsb": lister_autres_usb(vus),
        "utilise": {"path": chemin, "raison": raison,
                    "existe": bool(chemin) and os.path.exists(chemin),
                    "accessible": bool(chemin) and os.access(chemin, os.W_OK)},
        "config": charger_config(),
        "systeme": infos_systeme(),
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  ENVOI À L'IMPRIMANTE
# ═══════════════════════════════════════════════════════════════════════════════

def envoyer_a_imprimante(octets, chemin=None):
    """Écrit les octets ESC/POS sur l'imprimante configurée. Lève IOError avec un message clair."""
    raison = ""
    if chemin is None:
        chemin, raison = resoudre_peripherique()
    if not chemin:
        msg = (raison or "Aucune imprimante détectée") + \
              " — ouvrez Paramètres > Imprimante de tickets pour la configurer."
        _ctx.derniere_erreur = msg
        raise IOError(msg)
    try:
        with _verrou_impression:
            with open(chemin, "wb") as imprimante:
                imprimante.write(octets)
    except PermissionError:
        msg = (f"Permission refusée sur {chemin} — ouvrez Paramètres > Imprimante de tickets "
               f"et cliquez sur « Autoriser l'accès ».")
        _ctx.derniere_erreur = msg
        raise IOError(msg)
    except FileNotFoundError:
        msg = (f"{chemin} n'existe pas — imprimante éteinte ou débranchée ? "
               f"Sinon, relancez la détection dans Paramètres > Imprimante de tickets.")
        _ctx.derniere_erreur = msg
        raise IOError(msg)
    except OSError as e:
        msg = f"Écriture impossible sur {chemin} : {e.strerror or e} (imprimante éteinte, sans papier ou débranchée ?)"
        _ctx.derniere_erreur = msg
        raise IOError(msg)
    return chemin


def imprimer_test(chemin=None):
    """Petit ticket de test pour vérifier que la bonne imprimante répond."""
    ESC, GS = b'\x1b', b'\x1d'
    if chemin is None:
        chemin, _ = resoudre_peripherique()
    cfg = charger_config()
    lignes = [
        time.strftime("%d/%m/%Y %H:%M:%S"),
        f"Port : {chemin}",
    ]
    if cfg["vendorId"] and cfg["productId"]:
        lignes.append(f"USB  : {cfg['vendorId']}:{cfg['productId']}")
    out = ESC + b'@' + ESC + b't\x10' + ESC + b'a\x01'
    out += ESC + b'!\x30' + "TEST IMPRIMANTE\n".encode('cp850', errors='replace') + ESC + b'!\x00'
    out += ("-" * 32 + "\n").encode('cp850')
    for l in lignes:
        out += (l + "\n").encode('cp850', errors='replace')
    out += ("-" * 32 + "\n").encode('cp850')
    out += "Si vous lisez ceci,\nl'imprimante est bien configuree.\n".encode('cp850', errors='replace')
    out += b'\n\n\n\n' + GS + b'V\x00'
    return envoyer_a_imprimante(out, chemin)


# ═══════════════════════════════════════════════════════════════════════════════
#  AUTORISATIONS LINUX (une seule fois, avec sudo)
# ═══════════════════════════════════════════════════════════════════════════════

def regle_udev(vid, pid):
    return (
        "# Genere par la caisse (Parametres > Imprimante de tickets)\n"
        f'SUBSYSTEM=="usbmisc", KERNEL=="lp[0-9]*", ATTRS{{idVendor}}=="{vid}", '
        f'ATTRS{{idProduct}}=="{pid}", MODE="0666", SYMLINK+="caisse_imprimante"\n'
    )


SCRIPT_ROOT = r"""set -e
install -m 0644 "$1" /etc/udev/rules.d/99-caisse-imprimante.rules
modprobe usblp 2>/dev/null || true
echo usblp > /etc/modules-load.d/usblp.conf
if [ "$3" = "1" ]; then usermod -aG lp "$2"; fi
udevadm control --reload-rules
udevadm trigger --subsystem-match=usbmisc --action=add
udevadm settle --timeout=5 || true
for d in /dev/usb/lp*; do [ -e "$d" ] && chmod 0666 "$d" || true; done
"""


def configurer_autorisations(mot_de_passe, vid, pid, ajouter_groupe_lp=True):
    """Installe la règle udev, charge usblp et (option) ajoute l'utilisateur au groupe lp."""
    if not IS_LINUX:
        return {"success": False, "error": "Disponible uniquement sous Linux."}
    vid, pid = (vid or "").lower(), (pid or "").lower()
    if not (RE_HEX4.match(vid) and RE_HEX4.match(pid)):
        return {"success": False, "error": "Sélectionnez d'abord une imprimante détectée (identifiant USB manquant)."}
    utilisateur = getpass.getuser()
    if not RE_UTILISATEUR.match(utilisateur):
        return {"success": False, "error": f"Nom d'utilisateur inattendu : {utilisateur}"}
    if not shutil.which("sudo"):
        return {"success": False, "manuel": True,
                "error": "sudo n'est pas installé sur cet ordinateur. Utilisez la commande manuelle."}

    tmp = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".rules", delete=False, encoding="utf-8") as f:
            f.write(regle_udev(vid, pid))
            tmp = f.name
        env = dict(os.environ, LC_ALL="C", LANG="C")     # messages sudo en anglais, faciles à reconnaître
        r = subprocess.run(
            ["sudo", "-S", "-p", "", "-k", "bash", "-c", SCRIPT_ROOT, "bash",
             tmp, utilisateur, "1" if ajouter_groupe_lp else "0"],
            input=(mot_de_passe or "") + "\n", capture_output=True, text=True, timeout=60, env=env)
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Délai dépassé pendant la configuration."}
    except Exception as e:
        return {"success": False, "error": f"Erreur : {e}"}
    finally:
        mot_de_passe = None
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    err = (r.stderr or "").strip()
    if r.returncode != 0:
        bas = err.lower()
        if "not in the sudoers" in bas or "not allowed to" in bas:
            return {"success": False, "manuel": True,
                    "error": f"L'utilisateur « {utilisateur} » n'a pas le droit d'utiliser sudo. "
                             f"Depuis un compte administrateur : sudo usermod -aG sudo {utilisateur} "
                             f"(puis fermer/rouvrir la session), ou utilisez la commande manuelle."}
        if "incorrect password" in bas or "try again" in bas or "no password was provided" in bas:
            return {"success": False, "mauvaisMotDePasse": True, "error": "Mot de passe incorrect."}
        return {"success": False, "error": "La configuration a échoué : " + (err[-400:] or f"code {r.returncode}")}

    time.sleep(0.5)
    journal = [
        f"Règle udev installée pour l'imprimante {vid}:{pid} ({UDEV_RULE_FILE})",
        "Module noyau usblp chargé (et rechargé à chaque démarrage)",
        "Accès en écriture accordé, sans redémarrage ni reconnexion de session",
    ]
    if ajouter_groupe_lp:
        journal.append(f"Utilisateur « {utilisateur} » ajouté au groupe lp")
    return {"success": True, "journal": journal, "detection": detecter()}


# ═══════════════════════════════════════════════════════════════════════════════
#  SERVEUR HTTP
# ═══════════════════════════════════════════════════════════════════════════════

ROUTES_IMPRESSION = {
    '/print': 'print_ticket',
    '/print-rapport': 'print_rapport',
    '/print-ticket': 'print_ticket_session',
}


class PrinterHandler(BaseHTTPRequestHandler):

    # ── Utilitaires HTTP ──────────────────────────────────────────────────────

    def _json(self, code, obj):
        corps = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin') or '*')
        self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    def _lire_json(self):
        longueur = int(self.headers.get('Content-Length') or 0)
        if longueur <= 0:
            return {}
        return json.loads(self.rfile.read(longueur).decode('utf-8'))

    def _origine_locale(self):
        """Les routes /printer/* ne répondent qu'aux pages ouvertes sur cet ordinateur."""
        origine = self.headers.get('Origin')
        if not origine or origine == 'null':
            return True
        return urlparse(origine).hostname in ('localhost', '127.0.0.1', '::1')

    def do_OPTIONS(self):
        """Gestion CORS pour les requêtes OPTIONS"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin') or '*')
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ── GET : détection / état ────────────────────────────────────────────────

    def do_GET(self):
        chemin = urlparse(self.path).path
        try:
            if not chemin.startswith('/printer/'):
                return self._json(404, {'success': False, 'error': f'Route inconnue: {chemin}'})
            if not self._origine_locale():
                return self._json(403, {'success': False, 'error': 'Origine refusée'})

            if chemin == '/printer/status':
                cfg = charger_config()
                dev, raison = resoudre_peripherique(cfg)
                info = {'success': True, 'config': cfg, 'path': dev, 'raison': raison,
                        'plateforme': platform.system(), 'utilisateur': getpass.getuser()}
                if dev:
                    info.update(_statut_acces(dev))
                return self._json(200, info)

            if chemin == '/printer/detect':
                return self._json(200, dict(detecter(), success=True))

            return self._json(404, {'success': False, 'error': f'Route inconnue: {chemin}'})
        except Exception as e:
            print(f"Erreur: {e}")
            return self._json(500, {'success': False, 'error': str(e)})

    # ── POST : impression + configuration ─────────────────────────────────────

    def do_POST(self):
        chemin = urlparse(self.path).path
        try:
            # Impressions (inchangé côté page : mêmes routes, mêmes données)
            if chemin in ROUTES_IMPRESSION:
                data = self._lire_json()
                _ctx.derniere_erreur = None
                ok = getattr(self, ROUTES_IMPRESSION[chemin])(data)
                reponse = {'success': ok}
                if not ok:
                    reponse['error'] = getattr(_ctx, 'derniere_erreur', None) or "Erreur d'impression"
                return self._json(200 if ok else 500, reponse)

            # Configuration de l'imprimante (page Paramètres)
            if chemin.startswith('/printer/'):
                if not self._origine_locale():
                    return self._json(403, {'success': False, 'error': 'Origine refusée'})
                return self._route_printer(chemin, self._lire_json())

            return self._json(404, {'success': False, 'error': f'Route inconnue: {chemin}'})

        except Exception as e:
            print(f"Erreur: {e}")
            return self._json(500, {'success': False, 'error': str(e)})

    def _route_printer(self, chemin, data):
        if chemin == '/printer/config':
            cfg = charger_config()
            for cle in CONFIG_PAR_DEFAUT:
                if cle in data:
                    cfg[cle] = str(data[cle] or '').strip()
            for cle in ('vendorId', 'productId'):
                cfg[cle] = cfg[cle].lower()
            try:
                valider_config(cfg)
            except ValueError as e:
                return self._json(400, {'success': False, 'error': str(e)})
            sauver_config(cfg)
            dev, raison = resoudre_peripherique(cfg)
            print(f"✓ Imprimante enregistrée : {cfg['name'] or cfg['path'] or 'auto'} → {dev or 'introuvable'}")
            return self._json(200, {'success': True, 'config': cfg, 'path': dev, 'raison': raison})

        if chemin == '/printer/test':
            _ctx.derniere_erreur = None
            cible = str(data.get('path') or '').strip() or None
            if cible and (not RE_CHEMIN_DEV.match(cible) or '..' in cible):
                return self._json(400, {'success': False, 'error': 'Chemin invalide.'})
            try:
                utilise = imprimer_test(cible)
                return self._json(200, {'success': True, 'path': utilise})
            except Exception as e:
                return self._json(500, {'success': False,
                                        'error': getattr(_ctx, 'derniere_erreur', None) or str(e)})

        if chemin == '/printer/setup-permissions':
            res = configurer_autorisations(
                str(data.get('password') or ''), str(data.get('vendorId') or ''),
                str(data.get('productId') or ''), bool(data.get('addToLp', True)))
            data['password'] = None
            return self._json(200 if res.get('success') else 400, res)

        return self._json(404, {'success': False, 'error': f'Route inconnue: {chemin}'})


    def print_ticket(self, data):
        """Formate et envoie le ticket à l'imprimante"""
        try:
            # Commandes ESC/POS
            ESC = b'\x1b'
            GS = b'\x1d'
            
            # Initialisation
            output = ESC + b'@'  # Reset imprimante
            output += ESC + b't\x10'  # Sélectionne code page CP850
            
            # Centrage ON
            output += ESC + b'a\x01'
            
            # Titre en gras et grand
            output += ESC + b'!\x30'  # Double hauteur + double largeur + gras
            output += "*** TICKET ***\n".encode('cp850', errors='replace')
            output += ESC + b'!\x00'  # Reset style
            
            # Infos ticket
            output += f"{data.get('table', '')}\n".encode('cp850', errors='replace')
            output += f"{data.get('date', '')} {data.get('heure', '')}\n".encode('cp850', errors='replace')
            
            # Ligne de séparation
            output += ("-" * 32 + "\n").encode('cp850')
            output += "\n".encode('cp850')
            
            # Alignement gauche pour les articles
            output += ESC + b'a\x00'
            
            # Articles
            total = 0
            for article in data.get('articles', []):
                nom = article['nom'][:20].ljust(20)
                qte = str(article['qte']).rjust(2)
                prix = article['prix']
                total_ligne = prix * article['qte']
                total += total_ligne
                
                ligne = f"{nom} {qte}x {prix:.2f}EUR\n"
                output += ligne.encode('cp850', errors='replace')
            
            output += "\n".encode('cp850')
            output += ("-" * 32 + "\n").encode('cp850')
            
            # Total aligné à droite
            output += ESC + b'a\x02'  # Alignement droite
            output += ESC + b'!\x30'  # Gras + grand
            output += f"TOTAL: {total:.2f} EUR\n".encode('cp850', errors='replace')
            output += ESC + b'!\x00'  # Reset style
            
            # ========================================
            # VENTILATION TVA (si activée)
            # ========================================
            if data.get('tvaEnabled') and data.get('tvaVentilation'):
                output += ESC + b'a\x00'  # Alignement gauche
                output += "\n".encode('cp850')
                output += ("-" * 32 + "\n").encode('cp850')
                output += ESC + b'!\x10'  # Gras
                output += "VENTILATION TVA\n".encode('cp850', errors='replace')
                output += ESC + b'!\x00'
                output += "{:<8} {:>7} {:>7} {:>7}\n".format("Taux", "HTVA", "TVA", "TVAC").encode('cp850', errors='replace')
                output += ("-" * 32 + "\n").encode('cp850')
                for t in data['tvaVentilation']:
                    taux  = t.get('taux', 0)
                    base  = t.get('base', 0)
                    tva   = t.get('tva', 0)
                    tvac  = t.get('total', 0)
                    ligne = "{:<8} {:>7.2f} {:>7.2f} {:>7.2f}\n".format(
                        f"{taux}%", base, tva, tvac)
                    output += ligne.encode('cp850', errors='replace')
            
            # Pied de ticket
            output += ESC + b'a\x01'  # Centrage
            output += "\n".encode('cp850')
            output += ("-" * 32 + "\n").encode('cp850')
            
            # Info paiement si présentes
            if data.get('modePaiement'):
                mode = data.get('modePaiement', '')
                output += f"Mode: {mode}\n".encode('cp850', errors='replace')
            
            if data.get('rendu', 0) > 0:
                output += f"Rendu: {data.get('rendu', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            if data.get('montantBanque', 0) > 0:
                output += f"Banque: {data.get('montantBanque', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            if data.get('membreNom'):
                output += f"Membre: {data.get('membreNom')}\n".encode('cp850', errors='replace')
            
            output += ("-" * 32 + "\n").encode('cp850')
            output += "Merci pour votre visite\n".encode('cp850', errors='replace')
            output += "ASBL - TVA sous franchise\n".encode('cp850', errors='replace')
            output += "\n".encode('cp850')
            output += "Logiciel BisOffice\n".encode('cp850', errors='replace')
            
            # Coupe papier (si supportée)
            output += b'\n\n\n\n'
            output += GS + b'V\x00'  # Coupe totale
            
            # Envoi à l'imprimante
            envoyer_a_imprimante(output)
            
            print(f"✓ Ticket imprimé - Total: {total:.2f}EUR")
            return True
            
        except Exception as e:
            print(f"✗ Erreur d'impression: {e}")
            return False
    
    def print_rapport(self, data):
        """Formate et envoie un rapport X/Z à l'imprimante"""
        try:
            # Commandes ESC/POS
            ESC = b'\x1b'
            GS = b'\x1d'
            
            # Initialisation
            output = ESC + b'@'  # Reset imprimante
            output += ESC + b't\x10'  # Sélectionne code page CP850
            
            # Centrage ON
            output += ESC + b'a\x01'
            
            # Titre en gras et très grand
            output += ESC + b'!\x38'  # Triple taille + gras
            output += f"TICKET {data.get('type', '')}-{data.get('numero', '')}\n".encode('cp850', errors='replace')
            output += ESC + b'!\x00'  # Reset style

            # Mention COPIE si réimpression
            if data.get('estCopie'):
                output += ESC + b'!\x18'  # Gras + double hauteur
                output += f"*** COPIE - {data.get('type', '')}-{data.get('numero', '')} ***\n".encode('cp850', errors='replace')
                output += ESC + b'!\x00'  # Reset style

            output += "\n".encode('cp850')
            
            # Infos entreprise
            entreprise = data.get('entreprise', {})
            output += f"{entreprise.get('nom', '')}\n".encode('cp850', errors='replace')
            output += f"{entreprise.get('adresse', '')}\n".encode('cp850', errors='replace')
            output += f"{entreprise.get('localite', '')}\n".encode('cp850', errors='replace')
            output += f"N: {entreprise.get('num', '')}\n".encode('cp850', errors='replace')
            
            output += "\n".encode('cp850')
            output += ("-" * 32 + "\n").encode('cp850')
            
            # Alignement gauche pour les infos
            output += ESC + b'a\x00'
            
            # Utilisateur et dates
            output += f"Utilisateur: {data.get('utilisateur', 'N/A')}\n".encode('cp850', errors='replace')
            output += f"Ouverture: {data.get('dateOuverture', '')} {data.get('heureOuverture', '')}\n".encode('cp850', errors='replace')
            output += f"Cloture: {data.get('dateCloture', '')} {data.get('heureCloture', '')}\n".encode('cp850', errors='replace')
            
            output += "\n".encode('cp850')
            output += ("-" * 32 + "\n").encode('cp850')
            
            # ========================================
            # TOTAUX DÉTAILLÉS (NOUVEAU)
            # ========================================
            output += ESC + b'!\x10'  # Gras
            output += f"Fond caisse: {data.get('fondCaisse', 0):.2f} EUR\n".encode('cp850', errors='replace')
            output += f"Especes: {data.get('totalEspeces', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            # Dons espèces (si présents)
            if data.get('afficherDons') and data.get('donsEspeces', 0) > 0:
                output += f"  dont dons: {data.get('donsEspeces', 0):.2f} EUR\n".encode('cp850', errors='replace')
                output += f"  Esp. hors dons: {data.get('totalEspeces', 0) - data.get('donsEspeces', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            output += f"Banque: {data.get('totalBanque', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            # Dons banque (si présents)
            if data.get('afficherDons') and data.get('donsBanque', 0) > 0:
                output += f"  dont dons: {data.get('donsBanque', 0):.2f} EUR\n".encode('cp850', errors='replace')
                output += f"  Banque hors dons: {data.get('totalBanque', 0) - data.get('donsBanque', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            output += f"Total global: {data.get('totalGlobal', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            output += "\n".encode('cp850')
            
            # ========================================
            # C.A. GLOBAL ET NET (NOUVEAU)
            # ========================================
            output += ESC + b'!\x30'  # Double taille + gras
            output += f"C.A. GLOBAL: {data.get('caGlobal', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            # CA Net si dons affichés
            if data.get('afficherDons') and data.get('totalDons', 0) > 0:
                output += f"C.A. NET: {data.get('ca', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            output += ESC + b'!\x00'  # Reset style
            
            output += "\n".encode('cp850')
            
            # ========================================
            # STATS DÉTAILLÉES (AMÉLIORÉ)
            # ========================================
            output += ESC + b'!\x10'  # Gras
            output += f"Articles vendus: {data.get('totalArticles', 0)}\n".encode('cp850', errors='replace')
            output += f"Nombre tickets: {data.get('nbTickets', 0)}\n".encode('cp850', errors='replace')
            
            # Panier moyen (NOUVEAU)
            nb_tickets = data.get('nbTickets', 0)
            ca_global = data.get('caGlobal', 0)
            if nb_tickets > 0:
                panier_moyen = ca_global / nb_tickets
                output += f"Panier moyen: {panier_moyen:.2f} EUR\n".encode('cp850', errors='replace')
            
            output += f"Offerts: {data.get('totalOfferts', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            # Total dons (NOUVEAU)
            if data.get('afficherDons') and data.get('totalDons', 0) > 0:
                output += f"Total dons: {data.get('totalDons', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            output += ESC + b'!\x00'  # Reset style
            
            output += "\n".encode('cp850')
            output += ("-" * 32 + "\n").encode('cp850')
            
            # ========================================
            # VENTILATION TVA (si activée)
            # ========================================
            if data.get('tvaActif') and data.get('tvaVentilation'):
                tva_vent = data['tvaVentilation']
                if isinstance(tva_vent, dict) and len(tva_vent) > 0:
                    output += ESC + b'!\x18'  # Gras + double hauteur
                    output += "=== VENTILATION TVA ===\n".encode('cp850', errors='replace')
                    output += ESC + b'!\x00'
                    output += ("-" * 32 + "\n").encode('cp850')
                    output += "{:<8} {:>7} {:>7} {:>7}\n".format("Taux", "HTVA", "TVA", "TVAC").encode('cp850', errors='replace')
                    output += ("-" * 32 + "\n").encode('cp850')
                    tot_htva = 0
                    tot_tva  = 0
                    tot_tvac = 0
                    for taux_key in sorted(tva_vent.keys(), key=lambda x: float(x)):
                        v    = tva_vent[taux_key]
                        base = v.get('base', 0)
                        tva  = v.get('tva', 0)
                        tvac = v.get('total', 0)
                        tot_htva += base
                        tot_tva  += tva
                        tot_tvac += tvac
                        ligne = "{:<8} {:>7.2f} {:>7.2f} {:>7.2f}\n".format(
                            f"{taux_key}%", base, tva, tvac)
                        output += ligne.encode('cp850', errors='replace')
                    output += ("-" * 32 + "\n").encode('cp850')
                    output += ESC + b'!\x10'  # Gras
                    output += "{:<8} {:>7.2f} {:>7.2f} {:>7.2f}\n".format(
                        "TOTAL", tot_htva, tot_tva, tot_tvac).encode('cp850', errors='replace')
                    output += ESC + b'!\x00'
                    output += "\n".encode('cp850')
                    output += ("-" * 32 + "\n").encode('cp850')
            
            # ========================================
            # MEMBRES BANQUE (NOUVEAU)
            # ========================================
            membresBanque = data.get('membresBanque', {})
            if data.get('inclureMembresBanque') and membresBanque and len(membresBanque) > 0:
                output += ESC + b'!\x18'  # Gras + double hauteur
                output += "=== PAIEMENTS BANQUE ===\n".encode('cp850', errors='replace')
                output += ESC + b'!\x00'  # Reset style
                output += ("-" * 32 + "\n").encode('cp850')
                
                for membre_nom, membre_data in membresBanque.items():
                    # Compat : anciens rapports où membre_data est un simple nombre
                    # au lieu d'un objet {montant, nb}
                    if isinstance(membre_data, dict):
                        montant = membre_data.get('montant', 0) or 0
                        nb = membre_data.get('nb', 0) or 0
                    else:
                        montant = membre_data or 0
                        nb = 1
                    try:
                        montant = float(montant)
                    except (TypeError, ValueError):
                        montant = 0.0
                    
                    # Tronquer le nom si trop long
                    nom_court = membre_nom[:20] if len(membre_nom) > 20 else membre_nom
                    
                    output += ESC + b'!\x10'  # Gras
                    output += f"{nom_court}\n".encode('cp850', errors='replace')
                    output += ESC + b'!\x00'  # Reset
                    output += f"  {nb} paiement(s): {montant:.2f} EUR\n".encode('cp850', errors='replace')
                
                output += "\n".encode('cp850')
                output += ("-" * 32 + "\n").encode('cp850')
            
            # ========================================
            # ARTICLES PAR CATÉGORIES
            # ========================================
            output += ESC + b'!\x10'  # Gras
            output += "Articles par categories\n".encode('cp850', errors='replace')
            output += ESC + b'!\x00'  # Reset style
            output += ("-" * 32 + "\n").encode('cp850')
            
            categories = data.get('categories', {})
            for cat_nom, articles in categories.items():
                # Nom catégorie en gras
                output += ESC + b'!\x10'
                output += f"\n{cat_nom}\n".encode('cp850', errors='replace')
                output += ESC + b'!\x00'
                
                for art_nom, art_data in articles.items():
                    qte = art_data.get('qte', 0)
                    total = art_data.get('total', 0)
                    # Tronque le nom si trop long
                    nom_court = art_nom[:18] if len(art_nom) > 18 else art_nom
                    ligne = f"  {nom_court} ({int(qte)}): {total:.2f}EUR\n"
                    output += ligne.encode('cp850', errors='replace')
            
            output += "\n".encode('cp850')
            
            # ========================================
            # ARTICLES OFFERTS
            # ========================================
            articlesOfferts = data.get('articlesOfferts', {})
            if articlesOfferts and len(articlesOfferts) > 0:
                output += ("-" * 32 + "\n").encode('cp850')
                output += ESC + b'!\x18'  # Gras + double hauteur
                output += "=== OFFERTS ===\n".encode('cp850', errors='replace')
                output += ESC + b'!\x00'  # Reset style
                output += ("-" * 32 + "\n").encode('cp850')
                
                for art_nom, art_data in articlesOfferts.items():
                    qte = int(art_data.get('qte', 0))
                    prix_original = art_data.get('prixOriginal', 0)
                    total_offert = qte * prix_original
                    
                    # Tronque le nom si trop long
                    nom_court = art_nom[:15] if len(art_nom) > 15 else art_nom
                    ligne = f"  {nom_court} ({qte})\n"
                    output += ligne.encode('cp850', errors='replace')
                    ligne2 = f"    {qte}x {prix_original:.2f} = {total_offert:.2f}EUR\n"
                    output += ligne2.encode('cp850', errors='replace')
                
                output += "\n".encode('cp850')
            
            output += ("-" * 32 + "\n").encode('cp850')
            
            # ========================================
            # PIED DE PAGE
            # ========================================
            output += ESC + b'a\x01'  # Centrage
            if data.get('estCopie'):
                output += ESC + b'!\x10'  # Gras
                output += f"*** COPIE - {data.get('type', '')}-{data.get('numero', '')} ***\n".encode('cp850', errors='replace')
                output += ESC + b'!\x00'  # Reset style
            output += "\nMerci et a bientot !\n".encode('cp850', errors='replace')
            output += "ASBL - TVA sous franchise\n".encode('cp850', errors='replace')
            
            # Coupe papier
            output += b'\n\n\n\n'
            output += GS + b'V\x00'  # Coupe totale
            
            # Envoi à l'imprimante
            envoyer_a_imprimante(output)
            
            print(f"✓ Rapport {data.get('type', '')}-{data.get('numero', '')} imprimé")
            return True
            
        except Exception as e:
            print(f"✗ Erreur d'impression rapport: {e}")
            return False
    
    def print_ticket_session(self, data):
        """Formate et envoie un ticket de session a l imprimante.
        Champs attendus depuis rapports.html :
          numero, entreprise, datePaiement, heurePaiement,
          tableNom, membreNom, membrePrenom,
          articles [{nom, qte, prix, offert}],
          total, modePaiement, montantEspeces, montantBanque
        """
        try:
            ESC = b'\x1b'
            GS  = b'\x1d'

            output  = ESC + b'@'
            output += ESC + b't\x10'

            # En-tete centre
            output += ESC + b'a\x01'
            output += ESC + b'!\x30'
            output += ("TICKET #" + str(data.get("numero", "")) + "\n").encode("cp850", errors="replace")
            output += ESC + b'!\x00'

            entreprise = data.get("entreprise", {})
            if entreprise.get("nom"):
                output += (entreprise.get("nom", "") + "\n").encode("cp850", errors="replace")
            if entreprise.get("adresse"):
                output += (entreprise.get("adresse", "") + "\n").encode("cp850", errors="replace")
            if entreprise.get("localite"):
                output += (entreprise.get("localite", "") + "\n").encode("cp850", errors="replace")
            if entreprise.get("num"):
                output += ("N: " + entreprise.get("num", "") + "\n").encode("cp850", errors="replace")

            output += ("-" * 32 + "\n").encode("cp850")

            # Infos ticket
            output += ESC + b'a\x00'
            date_str  = data.get("datePaiement", "")
            heure_str = data.get("heurePaiement", "")
            output += ("Date : " + date_str + " " + heure_str + "\n").encode("cp850", errors="replace")

            if data.get("tableNom"):
                output += ("Table : " + str(data.get("tableNom")) + "\n").encode("cp850", errors="replace")

            prenom = data.get("membrePrenom", "")
            nom_m  = data.get("membreNom", "")
            if prenom or nom_m:
                output += ("Client : " + prenom + " " + nom_m).strip().encode("cp850", errors="replace")
                output += b'\n'

            output += ("-" * 32 + "\n").encode("cp850")

            # Articles
            output += ESC + b'!\x10'
            output += "Article                Qte   Total\n".encode("cp850", errors="replace")
            output += ESC + b'!\x00'
            output += ("-" * 32 + "\n").encode("cp850")

            for article in data.get("articles", []):
                nom_art    = str(article.get("nom", ""))[:20]
                qte        = float(article.get("qte", 0))
                prix       = float(article.get("prix", 0))
                offert     = article.get("offert", False)
                sous_total = qte * prix

                if offert:
                    ligne = "{:<20} {:>3}x OFFERT\n".format(nom_art, int(qte))
                else:
                    ligne = "{:<20} {:>3}x {:>6.2f}EUR\n".format(nom_art, int(qte), sous_total)
                output += ligne.encode("cp850", errors="replace")

            output += ("-" * 32 + "\n").encode("cp850")

            # Total
            output += ESC + b'a\x02'
            output += ESC + b'!\x30'
            total = float(data.get("total", 0))
            output += ("TOTAL : " + "{:.2f}".format(total) + " EUR\n").encode("cp850", errors="replace")
            output += ESC + b'!\x00'

            # ========================================
            # VENTILATION TVA (si activée)
            # ========================================
            if data.get('tvaEnabled') and data.get('tvaVentilation'):
                output += ESC + b'a\x00'
                output += "\n".encode('cp850')
                output += ("-" * 32 + "\n").encode("cp850")
                output += ESC + b'!\x10'
                output += "VENTILATION TVA\n".encode("cp850", errors="replace")
                output += ESC + b'!\x00'
                output += "{:<8} {:>7} {:>7} {:>7}\n".format("Taux", "HTVA", "TVA", "TVAC").encode("cp850", errors="replace")
                output += ("-" * 32 + "\n").encode("cp850")
                for t in data['tvaVentilation']:
                    taux  = t.get('taux', 0)
                    base  = t.get('base', 0)
                    tva   = t.get('tva', 0)
                    tvac  = t.get('total', 0)
                    ligne = "{:<8} {:>7.2f} {:>7.2f} {:>7.2f}\n".format(
                        f"{taux}%", base, tva, tvac)
                    output += ligne.encode("cp850", errors="replace")

            # Mode de paiement
            output += ESC + b'a\x00'
            output += ("-" * 32 + "\n").encode("cp850")

            mode = data.get("modePaiement", "")
            mode_labels = {"especes": "Especes", "banque": "Banque / Carte", "mixte": "Mixte"}
            mode_display = mode_labels.get(mode, mode or "N/A")
            output += ("Paiement : " + mode_display + "\n").encode("cp850", errors="replace")

            if mode == "mixte":
                esp = float(data.get("montantEspeces", 0))
                bq  = float(data.get("montantBanque", 0))
                if esp > 0:
                    output += ("  Especes : " + "{:.2f}".format(esp) + " EUR\n").encode("cp850", errors="replace")
                if bq > 0:
                    output += ("  Banque  : " + "{:.2f}".format(bq) + " EUR\n").encode("cp850", errors="replace")
            elif mode == "banque":
                bq = float(data.get("montantBanque", 0))
                if bq > 0:
                    output += ("  Montant : " + "{:.2f}".format(bq) + " EUR\n").encode("cp850", errors="replace")

            # Pied de page
            output += ESC + b'a\x01'
            output += ("-" * 32 + "\n").encode("cp850")
            output += "Merci de votre visite !\n".encode("cp850", errors="replace")
            output += "ASBL - TVA sous franchise\n".encode("cp850", errors="replace")
            output += "\n".encode("cp850")
            output += "Logiciel BisOffice\n".encode("cp850", errors="replace")

            output += b'\n\n\n\n'
            output += GS + b'V\x00'

            envoyer_a_imprimante(output)

            print("OK Ticket session #" + str(data.get("numero", "")) + " imprime - Total: " + "{:.2f}".format(total) + " EUR")
            return True

        except Exception as e:
            print("Erreur impression ticket session: " + str(e))
            return False

    def log_message(self, format, *args):
        """Logs personnalisés"""
        print(f"[{self.date_time_string()}] {format % args}")


def main():
    print("=" * 50)
    print("🖨️  SERVEUR D'IMPRESSION THERMIQUE")
    print("=" * 50)
    print(f"Port: {PORT}")
    dev, raison = resoudre_peripherique()
    if dev:
        print(f"Imprimante: {dev} ({raison})")
    else:
        print(f"Imprimante: ⚠️  {raison}")
        print("            → Paramètres > Imprimante de tickets > Détecter")
    print(f"URL Ticket     : http://localhost:{PORT}/print")
    print(f"URL Ticket sess: http://localhost:{PORT}/print-ticket")
    print(f"URL Rapports   : http://localhost:{PORT}/print-rapport")
    print(f"URL Config     : http://localhost:{PORT}/printer/detect")
    print("=" * 50)
    print("\n✓ Serveur démarré. Appuyez sur Ctrl+C pour arrêter.\n")

    try:
        server = ThreadingHTTPServer(('localhost', PORT), PrinterHandler)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n✓ Serveur arrêté proprement.")
        sys.exit(0)
    except Exception as e:
        print(f"\n✗ Erreur: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
