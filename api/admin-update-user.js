const { createClient } = require('@supabase/supabase-js');

const ROLES_VALIDES = ['admin', 'directeur', 'enseignant', 'secretaire', 'surveillant'];
const ROLES_DIRECTEUR_PEUT_GERER = ['enseignant', 'secretaire', 'surveillant'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    res.status(500).json({ error: 'Configuration serveur manquante (variables d\'environnement Supabase).' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Authentification requise.' });
    return;
  }

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: callerData, error: callerErr } = await anonClient.auth.getUser(token);
  if (callerErr || !callerData || !callerData.user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  const { data: callerProfile, error: callerProfileErr } = await adminClient
    .from('profiles')
    .select('role, actif')
    .eq('id', callerData.user.id)
    .maybeSingle();

  if (callerProfileErr) {
    res.status(500).json({ error: 'Erreur lecture profil : ' + callerProfileErr.message });
    return;
  }
  if (!callerProfile || (callerProfile.role !== 'admin' && callerProfile.role !== 'directeur') || !callerProfile.actif) {
    res.status(403).json({ error: 'Réservé aux administrateurs et directeurs.' });
    return;
  }

  const body = req.body || {};
  const userId = String(body.userId || '');
  if (!userId) {
    res.status(400).json({ error: 'Utilisateur cible manquant.' });
    return;
  }
  if (callerProfile.role !== 'admin' && userId === callerData.user.id) {
    // un directeur peut gérer son propre mot de passe, mais pas son propre rôle/statut via cette route pour les autres champs sensibles
  }

  let targetProfile = null;
  if (callerProfile.role === 'directeur') {
    const { data: tp, error: tpErr } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (tpErr || !tp) {
      res.status(400).json({ error: 'Utilisateur cible introuvable.' });
      return;
    }
    targetProfile = tp;
    if (!ROLES_DIRECTEUR_PEUT_GERER.includes(tp.role)) {
      res.status(403).json({ error: 'Un directeur ne peut gérer que les comptes Enseignant, Secrétaire ou Surveillant.' });
      return;
    }
  }

  const updates = {};
  const authUpdates = {};

  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 6) {
      res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
      return;
    }
    authUpdates.password = body.password;
  }

  if (typeof body.role === 'string' && body.role) {
    if (!ROLES_VALIDES.includes(body.role)) {
      res.status(400).json({ error: 'Rôle invalide.' });
      return;
    }
    if (callerProfile.role === 'directeur' && !ROLES_DIRECTEUR_PEUT_GERER.includes(body.role)) {
      res.status(403).json({ error: 'Un directeur ne peut attribuer que le rôle Enseignant, Secrétaire ou Surveillant.' });
      return;
    }
    updates.role = body.role;
  }

  if (typeof body.nomComplet === 'string') {
    updates.full_name = body.nomComplet;
  }

  if (typeof body.actif === 'boolean') {
    if (userId === callerData.user.id && body.actif === false) {
      res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
      return;
    }
    updates.actif = body.actif;
    updates.active = body.actif;
    authUpdates.ban_duration = body.actif ? 'none' : '876000h';
  }

  if (Object.keys(authUpdates).length) {
    const { error: authErr } = await adminClient.auth.admin.updateUserById(userId, authUpdates);
    if (authErr) {
      res.status(400).json({ error: 'Mise à jour du compte impossible : ' + authErr.message });
      return;
    }
  }

  if (Object.keys(updates).length) {
    const { error: updErr } = await adminClient.from('profiles').update(updates).eq('id', userId);
    if (updErr) {
      res.status(400).json({ error: 'Mise à jour du profil impossible : ' + updErr.message });
      return;
    }
  }

  res.status(200).json({ ok: true });
};
