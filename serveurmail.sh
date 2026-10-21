#!/bin/bash
# =============================
# 🚀 Script de lancement du serveur d'envoi
#    - Cartes membres  → POST /send-email
#    - Factures        → POST /send-email-facture
# =============================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Vérification de Node.js ==="
if ! command -v node &> /dev/null; then
    echo "❌ Node.js n'est pas installé. Installation..."
    sudo apt update && sudo apt install -y nodejs npm
else
    echo "✅ Node.js $(node -v) détecté."
fi

echo
echo "=== Installation des dépendances ==="

NEEDS_INSTALL=false

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    NEEDS_INSTALL=true
elif ! node -e "require('express'); require('nodemailer'); require('cors');" 2>/dev/null; then
    NEEDS_INSTALL=true
fi

if [ "$NEEDS_INSTALL" = true ]; then

    npm install express nodemailer cors --silent

    # Revérifier après l'install : si ça échoue toujours, node_modules est
    # corrompu (install précédente interrompue) → on repart de zéro une fois
    if ! node -e "require('express'); require('nodemailer'); require('cors');" 2>/dev/null; then
        echo "⚠️ Dépendances corrompues détectées, réinstallation complète..."
        rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/package-lock.json"
        npm install express nodemailer cors --silent
    fi

fi

if node -e "require('express'); require('nodemailer'); require('cors');" 2>/dev/null; then
    echo "✅ Dépendances OK."
else
    echo "❌ Impossible d'installer les dépendances Node.js correctement."
    echo "   (Vérifiez la connexion internet ou l'espace disque.)"
    exit 1
fi

echo
echo "=== Lancement du serveur ==="
node "$SCRIPT_DIR/server.js" &
SERVER_PID=$!

sleep 2
echo

# ⚡ Vérifier que le process est toujours vivant avant d'annoncer le succès
# (sinon on affichait "✅ Serveur lancé" même quand Node avait planté juste au-dessus)
if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✅ Serveur lancé sur : http://localhost:3000"
    echo "   → POST /send-email          (cartes membres)"
    echo "   → POST /send-email-facture  (factures)"
    echo
    echo "📦 Pour arrêter : kill $SERVER_PID"
    echo

    wait $SERVER_PID
else
    echo "❌ Le serveur mail n'a pas démarré (il a planté juste après le lancement)."
    echo "   Regardez le message d'erreur ci-dessus pour la cause exacte."
    echo
    exit 1
fi
