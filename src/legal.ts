/**
 * Pages publiques exigées par Meta pour passer l'app en mode Live :
 * politique de confidentialité et instructions de suppression des données.
 *
 * Contrairement au tableau de bord, elles doivent être accessibles sans
 * authentification et lisibles par les robots de Meta.
 */

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

/** Coordonnées du responsable de traitement, surchargeables par l'environnement. */
function controller() {
  return {
    name: process.env.LEGAL_COMPANY_NAME || 'Pause-Com',
    address: process.env.LEGAL_COMPANY_ADDRESS || '32 Rue des Volontaires, 75015 Paris, France',
    email: process.env.LEGAL_CONTACT_EMAIL || 'paris.pausecom@gmail.com',
    site: process.env.LEGAL_WEBSITE || 'https://www.pause-com.fr',
  };
}

const UPDATED = '16 septembre 2026';

function layout(title: string, description: string, path: string, body: string): string {
  const origin = (process.env.RENDER_EXTERNAL_URL ?? '').replace(/\/$/, '');
  const c = controller();
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(c.name)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow">
${origin ? `<link rel="canonical" href="${esc(origin + path)}">` : ''}
<meta property="og:type" content="article">
<meta property="og:site_name" content="${esc(c.name)}">
<meta property="og:title" content="${esc(title)} — ${esc(c.name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:locale" content="fr_FR">
${origin ? `<meta property="og:image" content="${esc(origin)}/logo.png">` : ''}
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#0b0b0b">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;600&display=swap">
<style>
:root { color-scheme: light dark; --ink:#141312; --paper:#f6f2ea; --surface:#fffdf8; --muted:#5d5850; --line:#e6dfd2; --accent:#b3261e; }
@media (prefers-color-scheme: dark) { :root { --ink:#f2ede3; --paper:#0d0c0b; --surface:#161513; --muted:#b8b0a3; --line:#2a2824; --accent:#ff7a6e; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.7 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
a { color: var(--accent); text-underline-offset: 3px; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.skip { position: absolute; left: 16px; top: -60px; background: #f7f3e8; color: #0b0b0b; padding: 10px 16px; border-radius: 10px; font-weight: 600; }
.skip:focus { top: 12px; }
header { background: #0b0b0b; color: #f7f3e8; }
.bar { max-width: 820px; margin: 0 auto; padding: 22px 20px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.bar img { height: 48px; width: auto; display: block; }
.bar nav ul { list-style: none; margin: 0; padding: 0; display: flex; gap: 18px; flex-wrap: wrap; }
.bar nav a { color: #f7f3e8; text-decoration: none; font-weight: 600; font-size: 14.5px; }
.bar nav a[aria-current="page"] { text-decoration: underline; text-decoration-color: #ff7a6e; text-decoration-thickness: 2px; }
main { max-width: 820px; margin: 0 auto; padding: 40px 20px 64px; }
article { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: clamp(22px, 5vw, 48px); }
h1 { font: 600 clamp(28px, 5vw, 40px)/1.15 'Fraunces', Georgia, serif; margin: 0 0 6px; }
h2 { font: 600 22px/1.3 'Fraunces', Georgia, serif; margin: 36px 0 10px; }
.meta { color: var(--muted); margin: 0 0 24px; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 15px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.box { border-left: 3px solid var(--accent); background: #b3261e0d; padding: 14px 18px; border-radius: 0 10px 10px 0; }
footer { max-width: 820px; margin: 0 auto; padding: 0 20px 40px; color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>
<header>
  <div class="bar">
    <a href="${esc(c.site)}"><img src="/logo.png" alt="${esc(c.name)} — accueil du site" width="96" height="48"></a>
    <nav aria-label="Informations légales">
      <ul>
        <li><a href="/confidentialite"${path === '/confidentialite' ? ' aria-current="page"' : ''}>Confidentialité</a></li>
        <li><a href="/suppression-des-donnees"${path === '/suppression-des-donnees' ? ' aria-current="page"' : ''}>Suppression des données</a></li>
      </ul>
    </nav>
  </div>
</header>
<main id="contenu">
  <article>${body}</article>
</main>
<footer><p>© ${new Date().getFullYear()} ${esc(c.name)} · ${esc(c.address)} · <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p></footer>
</body>
</html>`;
}

export function renderPrivacy(): string {
  const c = controller();
  const mail = `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`;
  return layout(
    'Politique de confidentialité',
    `Comment ${c.name} collecte, utilise et protège les données transmises via ses formulaires Facebook et Instagram.`,
    '/confidentialite',
    `<h1>Politique de confidentialité</h1>
<p class="meta">Dernière mise à jour : ${UPDATED}</p>

<p>La présente politique décrit la manière dont ${esc(c.name)} traite les données personnelles transmises par l’intermédiaire de ses formulaires de contact publicitaires sur Facebook et Instagram (« Instant Forms » de Meta), ainsi que par l’application « Pausecom Leads » qui les rapatrie.</p>

<h2>1. Responsable du traitement</h2>
<p>${esc(c.name)}, ${esc(c.address)}. Contact : ${mail}.</p>

<h2>2. Données collectées</h2>
<p>Uniquement les informations que vous saisissez vous-même dans un formulaire ${esc(c.name)} sur Facebook ou Instagram :</p>
<ul>
  <li>nom et prénom ;</li>
  <li>numéro de téléphone et, le cas échéant, adresse e-mail ;</li>
  <li>nom de votre entreprise ou établissement ;</li>
  <li>vos réponses aux questions du formulaire (par exemple votre profil ou le type d’accompagnement recherché) ;</li>
  <li>la date d’envoi, le formulaire utilisé et la plateforme (Facebook ou Instagram).</li>
</ul>
<p>Aucune autre donnée de votre compte Facebook ou Instagram n’est enregistrée : ni liste d’amis, ni publications, ni messages privés.</p>

<h2>3. Finalités et base légale</h2>
<table>
  <caption class="sr-only">Finalités du traitement et bases légales</caption>
  <thead><tr><th scope="col">Finalité</th><th scope="col">Base légale</th></tr></thead>
  <tbody>
    <tr><td>Vous recontacter pour répondre à votre demande d’information ou de devis</td><td>Mesures précontractuelles prises à votre demande (art. 6.1.b RGPD)</td></tr>
    <tr><td>Suivre et organiser les demandes reçues par l’agence</td><td>Intérêt légitime de ${esc(c.name)} (art. 6.1.f RGPD)</td></tr>
  </tbody>
</table>
<p>Vos données ne sont ni vendues, ni louées, ni utilisées pour de la publicité ciblée par des tiers.</p>

<h2>4. Destinataires et sous-traitants</h2>
<p>Les données sont accessibles uniquement à l’équipe ${esc(c.name)} chargée de répondre aux demandes. Elles transitent ou sont hébergées chez les prestataires techniques suivants :</p>
<ul>
  <li><strong>Meta Platforms Ireland Ltd</strong> — formulaires Facebook et Instagram ;</li>
  <li><strong>Google Ireland Ltd</strong> — stockage dans Google Sheets ;</li>
  <li><strong>Render Services, Inc.</strong> — hébergement du serveur qui reçoit les demandes.</li>
</ul>
<p>Certains de ces prestataires peuvent traiter des données hors de l’Union européenne. Ces transferts sont encadrés par les clauses contractuelles types de la Commission européenne ou par le cadre de protection des données UE–États-Unis.</p>

<h2>5. Durée de conservation</h2>
<p>Les données sont conservées <strong>3 ans à compter du dernier contact</strong> de votre part, puis supprimées, conformément aux recommandations de la CNIL pour les données de prospects. Meta supprime de son côté les réponses aux formulaires au bout de 90 jours.</p>

<h2>6. Sécurité</h2>
<p>Les échanges sont chiffrés (HTTPS). Les notifications de Meta sont authentifiées par signature cryptographique, l’accès au tableau de bord interne est protégé par mot de passe, et le stockage n’est partagé qu’avec un compte technique dédié.</p>

<h2>7. Vos droits</h2>
<p>Conformément au RGPD et à la loi Informatique et Libertés, vous disposez d’un droit d’accès, de rectification, d’effacement, de limitation, d’opposition et de portabilité de vos données. Pour les exercer, écrivez à ${mail} en précisant le nom et le numéro de téléphone indiqués dans le formulaire. Nous répondons sous un mois.</p>
<p>Vous pouvez également introduire une réclamation auprès de la <a href="https://www.cnil.fr/fr/plaintes">CNIL</a>.</p>
<p>Pour la suppression de vos données, consultez la page <a href="/suppression-des-donnees">Suppression des données</a>.</p>

<h2>8. Modifications</h2>
<p>Cette politique peut évoluer. La date de dernière mise à jour figure en haut de la page.</p>`
  );
}

export function renderDeletion(): string {
  const c = controller();
  const subject = encodeURIComponent('Suppression de mes données');
  return layout(
    'Suppression des données',
    `Comment demander à ${c.name} la suppression des données transmises via ses formulaires Facebook et Instagram.`,
    '/suppression-des-donnees',
    `<h1>Suppression de vos données</h1>
<p class="meta">Dernière mise à jour : ${UPDATED}</p>

<p>Si vous avez rempli un formulaire ${esc(c.name)} sur Facebook ou Instagram, vous pouvez demander à tout moment la suppression des informations transmises.</p>

<h2>Comment faire</h2>
<ol>
  <li>Envoyez un e-mail à <a href="mailto:${esc(c.email)}?subject=${subject}">${esc(c.email)}</a> avec pour objet « Suppression de mes données ».</li>
  <li>Indiquez le <strong>nom</strong> et le <strong>numéro de téléphone</strong> (ou l’adresse e-mail) saisis dans le formulaire, pour que nous retrouvions votre demande.</li>
</ol>

<div class="box">
  <p><strong>Délai :</strong> vos données sont supprimées de nos fichiers sous 30 jours, et nous vous le confirmons par e-mail.</p>
</div>

<h2>Ce qui est supprimé</h2>
<p>L’ensemble des informations issues du formulaire : nom, coordonnées, entreprise, réponses et date d’envoi, dans tous les outils de ${esc(c.name)}.</p>

<h2>Côté Meta</h2>
<p>Les réponses conservées par Meta sont effacées automatiquement au bout de 90 jours. Vous pouvez aussi gérer vos informations depuis les <a href="https://www.facebook.com/settings">paramètres de votre compte Facebook</a>.</p>

<p>Pour en savoir plus, consultez notre <a href="/confidentialite">politique de confidentialité</a>.</p>`
  );
}
