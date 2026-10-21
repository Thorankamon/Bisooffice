#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Serveur d'impression thermique pour imprimante ESC/POS
Port: 8088
Version améliorée avec tous les champs de rapport
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import subprocess
import sys

# Configuration
PRINTER_DEVICE = "/dev/usb/lp1"
PORT = 8088

class PrinterHandler(BaseHTTPRequestHandler):
    
    def do_OPTIONS(self):
        """Gestion CORS pour les requêtes OPTIONS"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def do_POST(self):
        """Gestion des requêtes d'impression"""
        if self.path == '/print':
            try:
                # Lecture des données
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
                
                # Impression ticket normal
                success = self.print_ticket(data)
                
                # Réponse
                self.send_response(200 if success else 500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                
                response = {'success': success}
                self.wfile.write(json.dumps(response).encode('utf-8'))
                
            except Exception as e:
                print(f"Erreur: {e}")
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
        
        elif self.path == '/print-rapport':
            try:
                # Lecture des données
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
                
                # Impression rapport X/Z
                success = self.print_rapport(data)
                
                # Réponse
                self.send_response(200 if success else 500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                
                response = {'success': success}
                self.wfile.write(json.dumps(response).encode('utf-8'))
                
            except Exception as e:
                print(f"Erreur: {e}")
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
        elif self.path == '/print-ticket':
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
                
                success = self.print_ticket_session(data)
                
                self.send_response(200 if success else 500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                
                response = {'success': success}
                self.wfile.write(json.dumps(response).encode('utf-8'))
                
            except Exception as e:
                print(f"Erreur: {e}")
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': f'Route inconnue: {self.path}'}).encode('utf-8'))
    
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
            with open(PRINTER_DEVICE, 'wb') as printer:
                printer.write(output)
            
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
            
            output += f"Banque: {data.get('totalBanque', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
            # Dons banque (si présents)
            if data.get('afficherDons') and data.get('donsBanque', 0) > 0:
                output += f"  dont dons: {data.get('donsBanque', 0):.2f} EUR\n".encode('cp850', errors='replace')
            
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
                    montant = membre_data.get('montant', 0)
                    nb = membre_data.get('nb', 0)
                    
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
            with open(PRINTER_DEVICE, 'wb') as printer:
                printer.write(output)
            
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

            with open(PRINTER_DEVICE, "wb") as printer:
                printer.write(output)

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
    print(f"Imprimante: {PRINTER_DEVICE}")
    print(f"URL Ticket     : http://localhost:{PORT}/print")
    print(f"URL Ticket sess: http://localhost:{PORT}/print-ticket")
    print(f"URL Rapports   : http://localhost:{PORT}/print-rapport")
    print("=" * 50)
    print("\n✓ Serveur démarré. Appuyez sur Ctrl+C pour arrêter.\n")
    
    try:
        server = HTTPServer(('localhost', PORT), PrinterHandler)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n✓ Serveur arrêté proprement.")
        sys.exit(0)
    except Exception as e:
        print(f"\n✗ Erreur: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
