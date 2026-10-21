#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eid_bridge.py — petit serveur local qui lit une carte d'identité belge (eID)
posée sur un lecteur de cartes à puce, et renvoie prénom/nom/adresse/localité
en JSON pour que membres.html puisse pré-remplir le formulaire.

Pourquoi un serveur à part ?
Un navigateur ne peut pas parler directement à un lecteur de cartes (USB/PC-SC).
Ce petit script fait le pont : il tourne sur le PC (à côté de ton serveur
membres/caisse habituel), et membres.js l'appelle en http://localhost:8765.

INSTALLATION (une seule fois) :
    pip install pyscard

Il faut aussi que le service PC/SC tourne :
    - Windows : déjà présent (service "Smart Card")
    - Linux   : `sudo apt install pcscd pcsc-tools` puis `sudo systemctl start pcscd`
    - macOS   : déjà présent

LANCEMENT :
    python eid_bridge.py
    (le laisser tourner en arrière-plan, comme ton serveur principal)

UTILISATION :
    GET http://localhost:8765/api/eid/status  -> { readerPresent: true/false }
    GET http://localhost:8765/api/eid/read    -> lit la carte posée sur le lecteur

NOTE IMPORTANTE :
Le mapping des "tags" ci-dessous suit la structure publique des fichiers
d'identité/adresse de l'eID belge (fichier "Identity" et fichier "Address"
de l'applet BELPIC). Elle est très stable depuis des années, mais si un jour
un champ ne tombe pas au bon endroit, lance le script avec --debug pour voir
les octets bruts et ajuster la table TLV_ID / TLV_ADDR plus bas.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEBUG = "--debug" in sys.argv
PORT = 8765

try:
    from smartcard.System import readers
    from smartcard.util import toBytes
    from smartcard.Exceptions import NoCardException, CardConnectionException
    PYSCARD_OK = True
except ImportError:
    PYSCARD_OK = False


# ───────────────────────── APDU / lecture carte ─────────────────────────
# On sélectionne chaque fichier en une seule commande "select by path depuis
# la MF" (P1=08, P2=0C), avec le chemin complet 3F00/DF01/<FID> en donnée.
# C'est la méthode la plus fiable/portable pour l'eID belge (celle utilisée
# par la plupart des lecteurs open-source) — l'ancien select en 3 étapes
# (P1=01 puis P1=02) renvoyait SW=6A86 (P1/P2 incorrects) sur pas mal de
# cartes/lecteurs.

SELECT_APPLET    = toBytes("00 A4 04 0C 0C A0 00 00 01 77 50 4B 43 53 2D 31 35") if PYSCARD_OK else None
SELECT_ID_FILE   = toBytes("00 A4 08 0C 06 3F 00 DF 01 40 31") if PYSCARD_OK else None
SELECT_ADDR_FILE = toBytes("00 A4 08 0C 06 3F 00 DF 01 40 33") if PYSCARD_OK else None
READ_BINARY_HEAD = [0x00, 0xB0]  # + offset_hi, offset_lo, longueur

# Tags du fichier "Identity" (voir spec publique eID belge)
TLV_ID = {
    1: "numeroCarte", 2: "numeroPuce", 3: "validiteDebut", 4: "validiteFin",
    5: "communeDelivrance", 6: "numeroNational", 7: "nom", 8: "prenoms",
    9: "troisiemePrenom", 10: "nationalite", 11: "lieuNaissance",
    12: "dateNaissance", 13: "sexe", 14: "conditionNoble", 15: "typeDocument",
    16: "statutSpecial", 17: "hashPhoto",
}
# Tags du fichier "Address"
TLV_ADDR = {1: "rueNumero", 2: "codePostal", 3: "commune", 4: "hash"}


def _connect_reader():
    if not PYSCARD_OK:
        raise RuntimeError("pyscard n'est pas installé (pip install pyscard)")
    rlist = readers()
    if not rlist:
        raise RuntimeError("aucun lecteur de carte détecté")
    conn = rlist[0].createConnection()
    conn.connect()
    return conn


def _transmit(conn, apdu):
    data, sw1, sw2 = conn.transmit(apdu)
    if DEBUG:
        print(">>", " ".join(f"{b:02X}" for b in apdu))
        print("<<", " ".join(f"{b:02X}" for b in data), f"SW={sw1:02X}{sw2:02X}")
    if sw1 != 0x90:
        raise RuntimeError(f"commande carte refusée (SW={sw1:02X}{sw2:02X})")
    return data


def _read_binary_file(conn):
    """Lit un fichier eID sélectionné, en boucle par blocs de 0xF0 octets."""
    out = bytearray()
    offset = 0
    chunk = 0xF0
    while True:
        hi, lo = (offset >> 8) & 0xFF, offset & 0xFF
        apdu = READ_BINARY_HEAD + [hi, lo, chunk]
        data, sw1, sw2 = conn.transmit(apdu)
        if sw1 == 0x6C:  # longueur incorrecte -> SW2 donne la bonne longueur
            apdu = READ_BINARY_HEAD + [hi, lo, sw2]
            data, sw1, sw2 = conn.transmit(apdu)
        if sw1 != 0x90:
            break
        out.extend(data)
        if len(data) < chunk:
            break
        offset += len(data)
        if offset > 5000:  # garde-fou
            break
    return bytes(out)


def _parse_tlv(raw, tag_map):
    result = {}
    i = 0
    n = len(raw)
    while i < n:
        tag = raw[i]
        i += 1
        if i >= n:
            break
        length = raw[i]
        i += 1
        if length & 0x80:  # longueur sur plusieurs octets (BER-TLV)
            nbytes = length & 0x7F
            length = int.from_bytes(raw[i:i + nbytes], "big")
            i += nbytes
        value = raw[i:i + length]
        i += length
        name = tag_map.get(tag)
        if name:
            result[name] = _decode_field(value)
    return result


def _decode_field(value):
    """Décode un champ texte de la carte. La carte encode ses champs en
    UTF-8 pour les caractères accentués (é, è, à, œ...) ; les décoder en
    latin-1 comme avant transformait ces lettres en caractères parasites
    (ex. "Flémalle" -> "Flém@lle"). On essaie donc UTF-8 en premier, et on
    ne retombe sur cp1252/latin-1 que si ce n'est pas de l'UTF-8 valide."""
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return value.decode(enc).strip()
        except UnicodeDecodeError:
            continue
    return value.hex()


def lire_carte():
    conn = _connect_reader()
    try:
        _transmit(conn, SELECT_APPLET)

        _transmit(conn, SELECT_ID_FILE)
        raw_id = _read_binary_file(conn)
        ident = _parse_tlv(raw_id, TLV_ID)

        _transmit(conn, SELECT_ADDR_FILE)
        raw_addr = _read_binary_file(conn)
        adresse = _parse_tlv(raw_addr, TLV_ADDR)
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass

    localite = " ".join(x for x in [adresse.get("codePostal"), adresse.get("commune")] if x).strip()

    return {
        "ok": True,
        "prenom": (ident.get("prenoms") or "").split(" ")[0] if ident.get("prenoms") else "",
        "nom": ident.get("nom", ""),
        "adresse": adresse.get("rueNumero", ""),
        "localite": localite,
        "dateNaissance": ident.get("dateNaissance", ""),
        "nationalite": ident.get("nationalite", ""),
    }


def reader_present():
    if not PYSCARD_OK:
        return False
    try:
        return len(readers()) > 0
    except Exception:
        return False


# ───────────────────────── Serveur HTTP ─────────────────────────

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/eid/status"):
            self._json({"ok": True, "readerPresent": reader_present(), "pyscard": PYSCARD_OK})
            return

        if self.path.startswith("/api/eid/read"):
            if not PYSCARD_OK:
                self._json({"ok": False, "error": "pyscard non installé (pip install pyscard)"})
                return
            try:
                data = lire_carte()
                self._json(data)
            except NoCardException:
                self._json({"ok": False, "error": "aucune carte détectée sur le lecteur"})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
            return

        self._json({"ok": False, "error": "route inconnue"}, status=404)

    def log_message(self, fmt, *args):
        if DEBUG:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if not PYSCARD_OK:
        print("⚠️  pyscard n'est pas installé. Installe-le avec : pip install pyscard")
        print("    Le serveur démarre quand même (statut = lecteur non disponible).")
    print(f"Pont eID démarré sur http://localhost:{PORT}  (Ctrl+C pour arrêter)")
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
