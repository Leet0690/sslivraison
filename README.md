# SSlivraison

MVP léger pour le service de livraison local à Sidi Slimane.

## Lancer la maquette

Ouvrir `index.html` dans un navigateur. Cette première version ne nécessite ni build ni installation.

## Brancher Supabase

1. Créer un projet Supabase gratuit.
2. Exécuter [`supabase.sql`](supabase.sql) dans le SQL Editor.
3. Ajouter Supabase Auth (téléphone ou email) et remplacer les actions de `app.js` par les appels `supabase-js`.

Le MVP conserve un tarif fixe de 10 DH et prévoit trois rôles : client, livreur et administrateur.
