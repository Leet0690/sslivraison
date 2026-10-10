# SSlivraison

Application web légère pour les courses à Sidi Slimane, avec livraison fixe à **10 DH**, Supabase et hébergement statique Netlify.

## Activer cette mise à jour

1. Dans le tableau de bord de votre projet Supabase, ouvrez **SQL Editor → New query**.
2. Copiez **tout** le contenu de `supabase.sql`, puis cliquez sur **Run**.
   Ce fichier installe aussi la migration `supabase/migrations/202610100001_operations.sql`.
   Exécutez l'un des deux fichiers, pas besoin d'exécuter les deux. Ils sont identiques.
3. Conservez **Anonymous Sign-ins** activé pour les clients et **Email** pour l'équipe.
4. Rechargez l'application. Les fonctions de cette version nécessitent cette migration.
   Elle conserve vos commandes, comptes et rôles existants.
5. En cas d'erreur SQL, la transaction complète est annulée : envoyez le message exact avant de relancer.

La configuration publique est dans `supabase-config.js`. N'y mettez jamais de clé secrète.
Le code ne peut pas appliquer cette migration à distance avec la seule clé publishable.

## Créer les trois comptes livreurs

Dans Supabase **Authentication → Users → Add user**, créez chaque compte email/mot de passe.
Pour votre compte administrateur et chaque livreur, exécutez ensuite en remplaçant les UUID :

```sql
-- Votre compte administrateur
update public.profiles
set role = 'admin', full_name = 'Responsable SSlivraison'
where id = 'UUID_ADMIN';

-- Répéter pour chacun des trois livreurs
update public.profiles
set role = 'driver', full_name = 'Nom du livreur', phone = '0612345678'
where id = 'UUID_LIVREUR';
```

Les nouveaux comptes ont toujours le rôle client par défaut, même s'ils fournissent un rôle dans leurs métadonnées.
L'administrateur peut modifier le nom et le téléphone des livreurs depuis le tableau de bord.
La création des comptes et les changements de rôle restent réservés au propriétaire du projet Supabase.

## Tester le parcours

1. Un client choisit un service, saisit ses coordonnées et son adresse, vérifie le récapitulatif, puis confirme.
2. L'administrateur ouvre `dashboard.html`, attribue la commande à un livreur.
3. Le livreur se connecte avec son propre compte et accepte sa commande.
4. Il avance les étapes, enregistre le montant des achats, puis partage sa position s'il le souhaite.
5. Le client voit son véritable statut, le contact du livreur et la dernière position récente.
6. À la livraison, le livreur confirme la somme effectivement encaissée après monnaie rendue : achats + 10 DH.

Le budget est un plafond pour les achats, hors livraison. Un dépassement est refusé.
Si le besoin change, contactez le client avant les achats ; cette version ne gère pas de validation de dépassement.
Les commandes terminées ne sont plus modifiables par l'application.

## Lancer en local

```powershell
cd D:\sslivraison
python -m http.server 4174 --bind 127.0.0.1
```

Ouvrir `http://localhost:4174/` ou `http://localhost:4174/dashboard.html`.
Les dépendances npm servent uniquement aux tests et à la préparation du déploiement.

## Vérifier et préparer le déploiement

```powershell
npm ci
npm test
npm run build
```

`dist/` contient uniquement les fichiers publics à déployer. SQL, tests, dépendances et fichiers privés sont exclus.
`netlify.toml` configure la commande `npm run build` et le dossier de publication `dist`.
Avec le dépôt connecté à Netlify, les mises à jour de `main` déclenchent un déploiement.
Le domaine de production est à ajouter dans la configuration d'URL Supabase pour de futurs liens d'authentification.

## Sécurité et consommation

- Lectures protégées par RLS : client propriétaire, livreur attribué, administrateur.
- Écritures uniquement par fonctions SQL contrôlées, avec tarif, transitions, budgets et encaissements validés.
- Déduplication d'une demande par clé conservée en session pendant une reprise réseau.
- Historique des créations, attributions et changements d'étape à partir de l'installation de cette version.
- Index, pagination de 20 commandes et subscriptions Realtime filtrées.
- Actualisation de secours toutes les 60 secondes, suspendue quand l'onglet est caché.
- GPS : au plus un envoi toutes les 15 secondes, moins si la position ne change pas.
- La position n'est visible au client que pendant une commande active et si elle a moins de deux minutes.
- Bouton d'arrêt du GPS, autorisation explicite du navigateur ; aucune commande n'est mise en file hors ligne.
- Les frais, achats et espèces sont séparés. Les statistiques journalières utilisent **Africa/Casablanca**.

Le compteur du jour exclut les anciennes livraisons sans `delivered_at` : leur date exacte ne peut pas être déduite.
La limitation des commandes protège une session contre les envois répétés ; elle ne remplace pas une protection CAPTCHA contre des comptes anonymes créés en masse.

## Installation sur téléphone

Sur un navigateur compatible, choisissez **Installer l'app**.
Sur iPhone/Safari : **Partager → Sur l'écran d'accueil**.

L'application installée reste une application web : le téléphone peut suspendre la localisation lorsque la page devient invisible ou l'écran est verrouillé.
Les clients anonymes retrouvent leurs commandes uniquement dans le navigateur conservant leur session ; la récupération sur un autre appareil n'est pas encore disponible.
Le service worker ne met en cache que les fichiers publics de l'application, jamais les réponses Supabase ou les positions.

## Validation

`npm test` exécute :
- une vraie base PostgreSQL embarquée (PGlite) avec simulation de Supabase Auth, rôles et RLS ;
- des tests d'interface avec réseau et géolocalisation simulés (Happy DOM).

Ces tests n'écrivent pas dans votre Supabase de production. Un essai réel avec vos comptes et téléphones reste nécessaire après la migration.
