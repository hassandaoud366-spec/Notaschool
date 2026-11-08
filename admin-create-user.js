// Fonction serveur Vercel : création d'un compte utilisateur par un administrateur.
// Utilise la clé service_role (jamais exposée au navigateur) pour créer le compte
// via l'API Admin de Supabase, après avoir vérifié que l'appelant est bien admin.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const ROLES_VALIDES = ['admin', 'directeur', 'enseignant', 'secretaire'];
const IDENTIFIANT_DOMAIN = '@notaschool.internal';

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
    // 1. Vérifier que l'appelant est authentifié
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

    // 2. Vérifier que l'appelant est bien un admin actif (lecture via service_role, hors RLS)
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

    // 3. Valider les données reçues
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const identifiant = (body.identifiant || '').trim();
    const password = body.password || '';
    const role = body.role || '';
    const nomComplet = (body.nomComplet || '').trim();

    if (!/^[A-Za-z0-9_-]{3,32}$/.test(identifiant)) {
      res.status(400).json({ error: 'Identifiant invalide (3 à 32 caractères : lettres, chiffres, - ou _).' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
      return;
    }
    if (ROLES_VALIDES.indexOf(role) === -1) {
      res.status(400).json({ error: 'Rôle invalide.' });
      return;
    }

    const email = identifiant.toLowerCase() + IDENTIFIANT_DOMAIN;

    // 4. Créer le compte Supabase Auth (email interne, jamais utilisé pour envoyer de vrais e-mails)
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { identifiant }
    });

    if (createErr) {
      const msg = /already registered|already exists/i.test(createErr.message)
        ? 'Cet identifiant est déjà utilisé.'
        : ('Création impossible : ' + createErr.message);
      res.status(400).json({ error: msg });
      return;
    }

    const newUserId = created.user.id;

    // 5. Créer la ligne de profil (rôle, identifiant)
    const { error: insertErr } = await adminClient.from('profiles').insert({
      id: newUserId,
      identifiant,
      role,
      nom_complet: nomComplet || null,
      actif: true
    });

    if (insertErr) {
      // Annule la création du compte Auth si le profil n'a pas pu être créé, pour éviter un compte orphelin
      await adminClient.auth.admin.deleteUser(newUserId);
      res.status(400).json({ error: "Profil non créé, opération annulée : " + insertErr.message });
      return;
    }

    res.status(200).json({ ok: true, id: newUserId, identifiant, role });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur : ' + (err && err.message ? err.message : String(err)) });
  }
};
