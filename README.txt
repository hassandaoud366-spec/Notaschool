NOTASCHOOL — DOSSIER DE PRÉPARATION
Établissement : CEM-Lycée de Bouya

CONTENU
- index.html : application existante enrichie avec le sexe dans la fiche élève, une grille Dev1 à Dev4 et une moyenne automatique, et une liste d'appel quotidienne.
- supabase-config.js : fichier à configurer avec l'URL du projet et la clé Publishable.
- MODELE_DONNEES.txt : structure des données à conserver.
- SECURITE_AVANT_PUBLICATION.txt : étapes obligatoires avant toute mise en production.

INSTALLATION LOCALE
1. Décompresser ce ZIP dans un dossier.
2. Ouvrir le dossier et vérifier que index.html et supabase-config.js sont au même niveau.
3. Ouvrir supabase-config.js avec un éditeur de texte.
4. Remplacer les deux valeurs de démonstration par l'URL du projet Supabase et la clé Publishable.
5. Ne jamais ajouter une clé Secret ou service_role dans le navigateur.

IMPORTANT
Ce dossier est une version de préparation pour les listes élèves, les devoirs et l'appel. Ce n'est PAS encore la version finale sécurisée multi-rôles demandée. L'écran de connexion existant utilise encore l'adresse e-mail Supabase et il n'y a pas encore les espaces/permissions complets administrateur, enseignant, élève et parent, ni l'obligation sécurisée de changer le mot de passe provisoire.

Ne lancez pas un ancien script SQL permissif et ne publiez pas cette version avec des données réelles d'élèves. La configuration des rôles, les Edge Functions et les politiques RLS strictes doivent être développées et testées avant la mise en production.
