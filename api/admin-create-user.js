// Fonction serveur Vercel : création d'un compte utilisateur par un administrateur.
// Version avec diagnostics temporaires (aucune clé complète n'est jamais affichée).

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const ROLES_VALIDES = ['admin', 'directeur', 'enseignant', 'secretaire'];
const IDENTIFIANT_DOMAIN = '@notaschool.internal';

function maskKey(k) {
  if (!k) return null;
  return k.slice(0, 12) + '...(' + k.length + ' caractères)...' + k.slice(-4);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    res.status(500).json({ error: "Configuration manquante.", diag: { url: SUPABASE_URL, hasService: !!SERVICE_ROLE_KEY, hasAnon: !!ANON_KEY } });
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
      res.status(401).json({ error: 'Session invalide : ' + (callerErr ? callerErr.message : 'utilisateur introuvable') });
      return;
    }
    const callerId = callerData.user.id;

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Diagnostic A : la clé service_role est-elle valide pour l'API Admin Auth (GoTrue) ?
    let adminAuthOk = null, adminAuthErr = null;
    try {
      const { error: listErr } = await adminClient.auth.admin.listUsers({ perPage: 1 });
      adminAuthOk = !listErr;
      adminAuthErr = listErr ? listErr.message : null;
    } catch (e) {
      adminAuthOk = false;
      adminAuthErr = e.message;
    }

    // Diagnostic B : la requête Postgres (PostgREST) sur profiles
    const { data: callerProfile, error: profileErr } = await adminClient
      .from('profiles')
      .select('role, actif')
      .eq('id', callerId)
      .maybeSingle();

    if (profileErr || !callerProfile || callerProfile.role !== 'admin' || !callerProfile.actif) {
      res.status(403).json({
        error: 'Réservé aux administrateurs.',
        diag: {
          projectUrl: SUPABASE_URL,
          serviceKeyPreview: maskKey(SERVICE_ROLE_KEY),
          anonKeyPreview: maskKey(ANON_KEY),
          callerId: callerId,
          adminAuthApiOk: adminAuthOk,
          adminAuthApiErr: adminAuthErr,
          profileQuery: {
            error: profileErr ? profileErr.message : null,
            code: profileErr ? profileErr.code : null,
            details: profileErr ? profileErr.details : null,
            hint: profileErr ? profileErr.hint : null,
            foundProfile: callerProfile
          }
        }
      });
      return;
    }

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

    const { error: insertErr } = await adminClient.from('profiles').insert({
  id: newUserId,
  identifiant,
  email,
  role,
  full_name: nomComplet || null,
  actif: true
});

    if (insertErr) {
      await adminClient.auth.admin.deleteUser(newUserId);
      res.status(400).json({ error: "Profil non créé, opération annulée : " + insertErr.message });
      return;
    }

    res.status(200).json({ ok: true, id: newUserId, identifiant, role });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur : ' + (err && err.message ? err.message : String(err)) });
  }
};
