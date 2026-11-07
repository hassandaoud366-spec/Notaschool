-- ============================================================
-- Notaschool — table des profils (identifiant + rôle) et RLS
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query
-- ============================================================

-- 1. Table des profils, liée 1:1 aux comptes Supabase Auth
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  identifiant text unique not null,
  role text not null check (role in ('admin','directeur','enseignant','secretaire')),
  nom_complet text,
  actif boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 2. Chacun peut lire son propre profil (nécessaire pour connaître son rôle après connexion)
drop policy if exists "profil propre lecture" on public.profiles;
create policy "profil propre lecture" on public.profiles
  for select using (auth.uid() = id);

-- 3. Les admins actifs peuvent lire tous les profils (panneau "Utilisateurs")
drop policy if exists "admin lit tout" on public.profiles;
create policy "admin lit tout" on public.profiles
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin' and p.actif = true
    )
  );

-- 4. Aucune policy d'insertion/mise à jour/suppression n'est ajoutée pour les rôles
--    anon / authenticated : avec RLS activé et sans policy correspondante, ces opérations
--    sont bloquées côté client (navigateur). Seules les fonctions serveur Vercel
--    (api/admin-create-user.js, api/admin-update-user.js), qui utilisent la clé
--    service_role et contournent RLS, peuvent créer ou modifier des profils.

-- ============================================================
-- Bootstrap du tout premier compte administrateur (ADMIN001)
-- ============================================================
-- Ce compte doit être créé une seule fois, manuellement, car la fonction serveur
-- exige déjà un administrateur existant pour créer un nouveau compte.
--
-- Étape A — dans Supabase Dashboard → Authentication → Users → "Add user" :
--   Email            : admin001@notaschool.internal
--   Password         : (votre choix, à garder en lieu sûr)
--   Auto Confirm User: coché (oui)
--
-- Étape B — copiez l'UUID du compte créé (colonne "User UID" de la liste), puis
-- exécutez ci-dessous en remplaçant <UUID-COPIE> :
--
-- insert into public.profiles (id, identifiant, role, nom_complet, actif)
-- values ('<UUID-COPIE>', 'ADMIN001', 'admin', 'Administrateur principal', true);
