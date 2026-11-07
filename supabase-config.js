// Fonction serveur Vercel : modification d'un compte utilisateur par un administrateur.
// Réinitialisation de mot de passe, changement de rôle, activation/désactivation,
// mise à jour du nom complet. Protégée de la même façon que admin-create-user.js.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const ROLES_VALIDES = ['admin', 'directeur', 'enseignant', 'secretaire'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    res.status(500).json({ error: "Configuration serveur manquante (variables d'environnement Supabase)." });
    return;
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      res.status(401).json({ error: 'Authentification requise.' });
      return;
    }

    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerData, error: callerErr } = await anonClient.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) {
      res.status(401).json({ error: 'Session invalide.' });
      return;
    }
    const callerId = callerData.user.id;

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: callerProfile, error: profileErr } = await adminClient
      .from('profiles')
      .select('role, actif')
      .eq('id', callerId)
      .maybeSingle();

    if (profileErr || !callerProfile || callerProfile.role !== 'admin' || !callerProfile.actif) {
      res.status(403).json({ error: 'Réservé aux administrateurs.' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const userId = body.userId;
    if (!userId) {
      res.status(400).json({ error: 'Utilisateur manquant.' });
      return;
    }

    if (userId === callerId && body.actif === false) {
      res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
      return;
    }

    // Mot de passe
    if (body.password !== undefined) {
      if (String(body.password).length < 6) {
        res.status(400).json({ error: 'Mot de passe trop court (6 caractères minimum).' });
        return;
      }
      const { error } = await adminClient.auth.admin.updateUserById(userId, { password: body.password });
      if (error) {
        res.status(400).json({ error: 'Échec de la réinitialisation : ' + error.message });
        return;
      }
    }

    const profilePatch = {};

    if (body.role !== undefined) {
      if (ROLES_VALIDES.indexOf(body.role) === -1) {
        res.status(400).json({ error: 'Rôle invalide.' });
        return;
      }
      profilePatch.role = body.role;
    }

    if (body.nomComplet !== undefined) {
      profilePatch.nom_complet = String(body.nomComplet).trim() || null;
    }

    if (body.actif !== undefined) {
      profilePatch.actif = !!body.actif;
      // Verrouille réellement la connexion côté Supabase Auth, pas seulement le profil
      const { error: banErr } = await adminClient.auth.admin.updateUserById(userId, {
        ban_duration: body.actif ? 'none' : '876000h'
      });
      if (banErr) {
        res.status(400).json({ error: 'Échec de mise à jour du statut : ' + banErr.message });
        return;
      }
    }

    if (Object.keys(profilePatch).length) {
      const { error: updErr } = await adminClient.from('profiles').update(profilePatch).eq('id', userId);
      if (updErr) {
        res.status(400).json({ error: 'Profil non mis à jour : ' + updErr.message });
        return;
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur : ' + (err && err.message ? err.message : String(err)) });
  }
};
