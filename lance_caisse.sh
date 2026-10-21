#!/bin/bash

# ═══════════════════════════════════════════════════════════════
# 🍺 Lanceur de Caisse Linux — Version Auto-Install
# ═══════════════════════════════════════════════════════════════

# Répertoire du script lui-même
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

REBOOT_REQUIRED=false

# ──────────────────────────────────────────────────────────────
# Détection terminal (utilisée ici pour le fallback zenity,
# et plus bas pour le serveur mail)
# ──────────────────────────────────────────────────────────────

TERMINAL=""

for T in xfce4-terminal gnome-terminal konsole lxterminal mate-terminal tilix xterm; do

    if command -v "$T" &>/dev/null; then
        TERMINAL="$T"
        break
    fi

done

# ──────────────────────────────────────────────────────────────
# Vérifier Zenity
# ──────────────────────────────────────────────────────────────
# Si zenity est absent ET qu'on n'est pas déjà dans un terminal
# interactif (cas du lancement par double-clic), on se relance
# soi-même dans un terminal détecté afin que l'utilisateur voie
# l'installation (apt) et puisse répondre au prompt sudo.

if ! command -v zenity &>/dev/null; then

    if [ -z "$LANCE_CAISSE_DANS_TERMINAL" ] && [ ! -t 0 ]; then

        if [ -n "$TERMINAL" ]; then

            case "$TERMINAL" in

                gnome-terminal)
                    gnome-terminal -- bash -c "LANCE_CAISSE_DANS_TERMINAL=1 bash '$SCRIPT_PATH'; read -p 'Appuyez sur Entrée pour fermer...'" &
                    ;;

                xterm)
                    xterm -hold -e "LANCE_CAISSE_DANS_TERMINAL=1 bash '$SCRIPT_PATH'" &
                    ;;

                *)
                    $TERMINAL --hold -e "LANCE_CAISSE_DANS_TERMINAL=1 bash '$SCRIPT_PATH'" &
                    ;;

            esac

            exit 0

        else

            echo "⚠️ Zenity n'est pas installé et aucun terminal graphique n'a été détecté."
            echo "Tentative d'installation sans terminal (le mot de passe sudo pourrait échouer)..."

        fi
    fi

    echo "Zenity non installé."
    sudo apt update
    sudo apt install -y zenity
fi

# ──────────────────────────────────────────────────────────────
# Choix du mode de lancement
# ──────────────────────────────────────────────────────────────

MODE=$(zenity --list \
    --title="🍺 Lancement de la Caisse" \
    --text="Comment voulez-vous lancer la caisse ?" \
    --radiolist \
    --column="" --column="Mode" --column="Description" \
    TRUE  "local"   "Serveur local (localhost:8000) — recommandé" \
    FALSE "enligne" "Fichier direct (index.html sans serveur)" \
    --width=480 --height=220)

if [ $? -ne 0 ]; then
    zenity --error --text="Opération annulée"
    exit 1
fi

# ──────────────────────────────────────────────────────────────
# Demande du mot de passe sudo
# ──────────────────────────────────────────────────────────────

while true; do

    PASSWORD=$(zenity --password \
        --title="Autorisation Système" \
        --text="Veuillez entrer votre mot de passe administrateur :")

    if [ $? -ne 0 ]; then
        zenity --error --text="Opération annulée"
        exit 1
    fi

    if echo "$PASSWORD" | sudo -S -v 2>/dev/null; then
        break
    else
        zenity --warning \
            --title="Mot de passe incorrect" \
            --text="❌ Mot de passe incorrect."
    fi

done

# ──────────────────────────────────────────────────────────────
# Vérifier Python3
# ──────────────────────────────────────────────────────────────

if ! command -v python3 &>/dev/null; then

    zenity --question \
        --title="Python manquant" \
        --text="Python3 n'est pas installé.\n\nVoulez-vous l'installer automatiquement ?"

    if [ $? -eq 0 ]; then

        zenity --info --text="Installation de Python3 en cours..."

        echo "$PASSWORD" | sudo -S apt update
        echo "$PASSWORD" | sudo -S apt install -y python3 python3-pip

        REBOOT_REQUIRED=true

    else

        zenity --error --text="Python3 est obligatoire pour lancer la caisse."
        exit 1

    fi
fi

# ──────────────────────────────────────────────────────────────
# Vérifier pip
# ──────────────────────────────────────────────────────────────

if ! command -v pip3 &>/dev/null; then

    zenity --info --text="Installation de pip3..."
    echo "$PASSWORD" | sudo -S apt install -y python3-pip

fi

# ──────────────────────────────────────────────────────────────
# Vérifier openpyxl
# ──────────────────────────────────────────────────────────────

if ! python3 -c "import openpyxl" 2>/dev/null; then

    zenity --question \
        --title="openpyxl manquant" \
        --text="Le module openpyxl n'est pas installé.\n\nVoulez-vous l'installer automatiquement ?"

    if [ $? -eq 0 ]; then

        zenity --info --text="Installation de openpyxl..."

        echo "$PASSWORD" | sudo -S apt install -y python3-openpyxl

        # Fallback pip si le paquet apt échoue
        if ! python3 -c "import openpyxl" 2>/dev/null; then
            python3 -m pip install --break-system-packages openpyxl
        fi

    else

        zenity --warning \
            --text="Le module openpyxl est absent.\nL'export Excel ne fonctionnera pas."

    fi
fi

# ──────────────────────────────────────────────────────────────
# Vérifier Node.js
# ──────────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then

    zenity --question \
        --title="Node.js manquant" \
        --text="Node.js n'est pas installé.\n\nVoulez-vous l'installer automatiquement ?"

    if [ $? -eq 0 ]; then

        zenity --info --text="Installation de Node.js..."

        echo "$PASSWORD" | sudo -S apt install -y nodejs npm

    else

        zenity --error --text="Node.js est obligatoire pour le serveur mail."
        exit 1

    fi
fi

# ──────────────────────────────────────────────────────────────
# Installer dépendances Node.js
# ──────────────────────────────────────────────────────────────

if [ -f "$SCRIPT_DIR/server.js" ]; then

    cd "$SCRIPT_DIR"

    # ⚡ Vérifier si les dépendances sont présentes ET utilisables (un node_modules
    # présent mais corrompu par une install interrompue ne sera pas réparé par un
    # simple "npm install" par-dessus — c'est exactement ce qui causait le crash
    # "Cannot find module .../math-intrinsics/floor.js")
    NEEDS_INSTALL=false

    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        NEEDS_INSTALL=true
    elif ! node -e "require('express'); require('nodemailer'); require('cors');" 2>/dev/null; then
        NEEDS_INSTALL=true
    fi

    if [ "$NEEDS_INSTALL" = true ]; then

        zenity --info --text="Installation des dépendances Node.js..."

        npm install express nodemailer cors --silent

        # Revérifier après l'install : si ça échoue toujours, node_modules est
        # corrompu → on repart de zéro une fois avant d'abandonner
        if ! node -e "require('express'); require('nodemailer'); require('cors');" 2>/dev/null; then

            zenity --info --text="Dépendances Node.js corrompues détectées.\nRéinstallation complète en cours..."

            rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/package-lock.json"
            npm install express nodemailer cors --silent

            if ! node -e "require('express'); require('nodemailer'); require('cors');" 2>/dev/null; then
                zenity --warning --text="⚠️ Impossible d'installer les dépendances Node.js correctement.\nLe serveur mail risque de ne pas démarrer.\n(Vérifiez la connexion internet ou l'espace disque.)"
            fi

        fi

    fi

fi

# ──────────────────────────────────────────────────────────────
# Configurer imprimante USB
# ──────────────────────────────────────────────────────────────

# L'imprimante est retrouvée automatiquement par serveur_impression.py (par son
# identifiant USB : plus de /dev/usb/lp1 codé en dur). Si la règle udev a été
# installée depuis Paramètres > Imprimante de tickets, les droits sont déjà
# corrects et il n'y a rien à faire ici. Sinon : ouverture temporaire des droits
# sur chaque /dev/usb/lp* présent.

IMPRIMANTE_TROUVEE=false

for LP in /dev/usb/lp*; do

    [ -e "$LP" ] || continue

    IMPRIMANTE_TROUVEE=true

    if [ ! -w "$LP" ]; then
        echo "$PASSWORD" | sudo -S chmod 666 "$LP"
    fi

done

if [ "$IMPRIMANTE_TROUVEE" = false ]; then

    echo "⚠️ Imprimante USB non détectée (Paramètres > Imprimante de tickets > Détecter)"

fi

# ──────────────────────────────────────────────────────────────
# Lancer serveur impression
# ──────────────────────────────────────────────────────────────

IMPRESSION_PY=""

[ -f "$SCRIPT_DIR/serveur_impression.py" ] && IMPRESSION_PY="$SCRIPT_DIR/serveur_impression.py"

[ -z "$IMPRESSION_PY" ] && [ -f "$SCRIPT_DIR/serveur_impression_v3TVA.py" ] && IMPRESSION_PY="$SCRIPT_DIR/serveur_impression_v3TVA.py"

if [ -n "$IMPRESSION_PY" ]; then

    # ⚡ Tuer une éventuelle instance déjà lancée sur le port 8088.
    # Sinon la nouvelle instance plante silencieusement en arrière-plan
    # avec "Address already in use" et le statut affiché reste "démarré ✅"
    # alors que le serveur d'impression n'écoute plus.
    fuser -k 8088/tcp 2>/dev/null
    sleep 0.3

    python3 "$IMPRESSION_PY" &
    IMPRESSION_PID=$!

    sleep 0.5

    # ⚡ Vérifier que le process est toujours vivant (s'il a planté au démarrage,
    # il sera déjà mort à ce stade)
    if kill -0 "$IMPRESSION_PID" 2>/dev/null; then
        IMPRESSION_STATUS="démarré ✅"
    else
        IMPRESSION_STATUS="échec au démarrage ❌ (port 8088 déjà utilisé ou erreur Python)"
    fi

else

    IMPRESSION_STATUS="introuvable ⚠️"

fi

# ──────────────────────────────────────────────────────────────
# Lancer pont eID (lecture carte d'identité)
# ──────────────────────────────────────────────────────────────

EID_BRIDGE_PY=""

[ -f "$SCRIPT_DIR/eid_bridge.py" ] && EID_BRIDGE_PY="$SCRIPT_DIR/eid_bridge.py"

if [ -n "$EID_BRIDGE_PY" ]; then

    # ⚡ Tuer une éventuelle instance déjà lancée sur le port 8765
    fuser -k 8765/tcp 2>/dev/null
    sleep 0.3

    python3 "$EID_BRIDGE_PY" &
    EID_BRIDGE_PID=$!

    sleep 0.5

    if kill -0 "$EID_BRIDGE_PID" 2>/dev/null; then
        EID_BRIDGE_STATUS="démarré ✅"
    else
        EID_BRIDGE_STATUS="échec au démarrage ❌ (port 8765 déjà utilisé ou erreur Python)"
    fi

else

    EID_BRIDGE_STATUS="introuvable ⚠️"

fi

# ──────────────────────────────────────────────────────────────
# Détection terminal
# ──────────────────────────────────────────────────────────────

TERMINAL=""

for T in xfce4-terminal gnome-terminal konsole lxterminal mate-terminal tilix xterm; do

    if command -v "$T" &>/dev/null; then
        TERMINAL="$T"
        break
    fi

done

# ──────────────────────────────────────────────────────────────
# Lancer serveur mail
# ──────────────────────────────────────────────────────────────

if [ -f "$SCRIPT_DIR/serveurmail.sh" ]; then

    if [ -n "$TERMINAL" ]; then

        case "$TERMINAL" in

            gnome-terminal)
                gnome-terminal -- bash -c "bash '$SCRIPT_DIR/serveurmail.sh'; read" &
                ;;

            xterm)
                xterm -hold -e "bash '$SCRIPT_DIR/serveurmail.sh'" &
                ;;

            *)
                $TERMINAL --hold -e "bash '$SCRIPT_DIR/serveurmail.sh'" &
                ;;

        esac

    else

        bash "$SCRIPT_DIR/serveurmail.sh" &

    fi

    MAIL_STATUS="démarré ✅"

else

    MAIL_STATUS="introuvable ⚠️"

fi

# ──────────────────────────────────────────────────────────────
# Mode LOCAL
# ──────────────────────────────────────────────────────────────

if [ "$MODE" = "local" ]; then

    if [ -f "$SCRIPT_DIR/serveur.py" ]; then

        fuser -k 8000/tcp 2>/dev/null
        sleep 0.3

        python3 "$SCRIPT_DIR/serveur.py" &

        SERVEUR_BAR_STATUT="démarré ✅"

        sleep 1

        for i in {1..10}; do

            if curl -s http://localhost:8000/api/status >/dev/null 2>&1; then
                break
            fi

            sleep 0.5

        done

        xdg-open "http://localhost:8000/index.html"

    else

        SERVEUR_BAR_STATUT="introuvable ⚠️"

        zenity --warning \
            --text="serveur.py introuvable.\nPassage en mode fichier direct."

        MODE="enligne"

    fi
fi

# ──────────────────────────────────────────────────────────────
# Mode fichier direct
# ──────────────────────────────────────────────────────────────

if [ "$MODE" = "enligne" ]; then

    SERVEUR_BAR_STATUT="mode fichier"

    if [ -f "$SCRIPT_DIR/index.html" ]; then

        xdg-open "$SCRIPT_DIR/index.html"

    else

        zenity --error \
            --text="Impossible de trouver index.html"

        exit 1

    fi
fi

# ──────────────────────────────────────────────────────────────
# Lire URL serveur mail
# ──────────────────────────────────────────────────────────────

SERVER_URL="http://localhost:3000"
CONFIG_FILE="$SCRIPT_DIR/config.json"

if [ -f "$CONFIG_FILE" ]; then

    PARSED_URL=$(python3 -c "
import json
try:
    cfg = json.load(open('$CONFIG_FILE'))
    print(cfg.get('serverUrl', 'http://localhost:3000'))
except:
    print('http://localhost:3000')
")

    [ -n "$PARSED_URL" ] && SERVER_URL="$PARSED_URL"

fi

# ──────────────────────────────────────────────────────────────
# Adresse IP locale
# ──────────────────────────────────────────────────────────────

LOCAL_IP=$(hostname -I | awk '{print $1}')

# ──────────────────────────────────────────────────────────────
# Message final
# ──────────────────────────────────────────────────────────────

zenity --info --title="Succès" --text="La caisse est maintenant lancée !

Serveur impression : $IMPRESSION_STATUS
Serveur mail        : $MAIL_STATUS ($SERVER_URL)
Serveur bar         : $SERVEUR_BAR_STATUT
Pont eID (carte ID) : $EID_BRIDGE_STATUS

📱 Adresse GSM :
http://$LOCAL_IP:8000/commande.html?mode=serveur"

# ──────────────────────────────────────────────────────────────
# Redémarrage conseillé
# ──────────────────────────────────────────────────────────────

if [ "$REBOOT_REQUIRED" = true ]; then

    zenity --question \
        --title="Redémarrage conseillé" \
        --text="Python vient d'être installé.\n\nUn redémarrage est conseillé.\n\nRedémarrer maintenant ?"

    if [ $? -eq 0 ]; then

        echo "$PASSWORD" | sudo -S reboot

    fi
fi
