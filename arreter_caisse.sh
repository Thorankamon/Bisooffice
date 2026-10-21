#!/bin/bash
# ════════════════════════════════════════════════════════════════
# 🛑 Arrêt complet — Serveur bar / Serveur impression / Serveur mail
# ════════════════════════════════════════════════════════════════
# Tue tout ce qui écoute sur les ports des 3 serveurs, peu importe
# leur PID (pas besoin de retenir un numéro qui change à chaque
# lancement — voir fuser -k, déjà utilisé dans lance_caisse.sh).

echo "════════════════════════════════════════════"
echo "🛑 Arrêt des serveurs BisOffice"
echo "════════════════════════════════════════════"
echo

stop_port() {
    local PORT="$1"
    local NOM="$2"

    if fuser "$PORT"/tcp &>/dev/null; then
        fuser -k "$PORT"/tcp 2>/dev/null
        sleep 0.3
        echo "✅ $NOM (port $PORT) arrêté."
    else
        echo "⚠️  $NOM (port $PORT) n'était pas lancé."
    fi
}

stop_port 8000 "Serveur bar (caisse)"
stop_port 8088 "Serveur d'impression"
stop_port 3000 "Serveur mail"

echo
echo "════════════════════════════════════════════"
echo "✔ Tous les serveurs ont été arrêtés."
echo "════════════════════════════════════════════"

if command -v zenity &>/dev/null; then
    zenity --info --title="Arrêt de la caisse" \
        --text="✔ Serveur bar, serveur d'impression et serveur mail ont été arrêtés."
fi

read -p "Appuyez sur Entrée pour fermer..."
