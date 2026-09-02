/**
 * Publie une image ou un carrousel sur le compte Instagram professionnel.
 *
 * Par sécurité, ce script NE PUBLIE PAS par défaut : il lance une batterie de
 * vérifications et s'arrête. Il faut l'indicateur --publish pour toucher au
 * compte réel.
 *
 *   npm run post        → vérifications seules, aucune publication
 *   npm run post:live   → vérifie puis publie
 *
 * L'API Instagram publie en deux temps : on crée d'abord un « media container »
 * (l'image est téléchargée par Meta depuis une URL publique), puis on publie ce
 * container. Un carrousel crée un container par image, plus un container parent.
 */
import { requireEnv, runCli, errorMessage } from './lib/env.js';
import { graphGet, graphPost, resolveInstagramUserId } from './lib/graph.js';

// --- À éditer ---------------------------------------------------------------
const IMAGE_URL = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1080';
const CAPTION = 'Publié automatiquement 🚀';
// Pour un carrousel, renseigne 2 à 10 URLs ici et laisse IMAGE_URL de côté :
const CAROUSEL_URLS: string[] = [];
// ----------------------------------------------------------------------------

const LIVE = process.argv.includes('--publish');
const CAPTION_MAX = 2200;
const MAX_BYTES = 8 * 1024 * 1024;

const ok = (m: string): void => console.log(`  ✅ ${m}`);
const ko = (m: string): void => console.log(`  ❌ ${m}`);

/** Réponse des endpoints de publication : un identifiant de container. */
interface MediaResponse {
  id: string;
}

/** Résultat d'une vérification d'image : réussie avec détail, ou échouée avec motif. */
type ImageCheck =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

/**
 * Vérifie qu'une URL d'image est publiquement accessible et bien une image.
 *
 * C'est la première cause d'échec de publication : Meta télécharge l'image
 * depuis ses propres serveurs, sans aucun cookie ni en-tête d'authentification.
 * Une URL qui s'affiche dans ton navigateur peut très bien lui être fermée.
 */
async function checkImageUrl(url: string): Promise<ImageCheck> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  } catch (err) {
    return { ok: false, reason: `injoignable (${errorMessage(err)})` };
  }

  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status} — non publique ?` };
  }

  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) {
    return { ok: false, reason: `type « ${type || 'inconnu'} » au lieu d'une image` };
  }
  if (!/jpeg|jpg|png/.test(type)) {
    return { ok: false, reason: `format ${type} — Instagram accepte JPEG et PNG` };
  }

  const size = Number(response.headers.get('content-length') ?? 0);
  const mo = size ? ` — ${(size / 1024 / 1024).toFixed(1)} Mo` : '';
  if (size > MAX_BYTES) {
    return { ok: false, reason: `trop lourde${mo}, la limite est de 8 Mo` };
  }

  return { ok: true, detail: `${type}${mo}` };
}

/**
 * Vérifications qui ne dépendent d'aucun accès Meta.
 *
 * Elles tournent en premier, et sans jeton : c'est ce qui permet de valider
 * ses images et sa légende avant même d'avoir configuré Meta.
 */
async function checkContent(urls: string[], caption: string): Promise<boolean> {
  let allGood = true;

  console.log('\nLégende');
  if (caption.length > CAPTION_MAX) {
    ko(`${caption.length} caractères — le maximum est ${CAPTION_MAX}`);
    allGood = false;
  } else {
    ok(`${caption.length}/${CAPTION_MAX} caractères`);
  }

  console.log('\nImages');
  if (urls.length === 0) {
    ko('aucune image à publier');
    allGood = false;
  }
  if (urls.length > 10) {
    ko(`carrousel de ${urls.length} images — la plage autorisée est 2 à 10`);
    allGood = false;
  }

  for (const url of urls) {
    const result = await checkImageUrl(url);
    if (result.ok) ok(`${url}\n       ${result.detail}`);
    else {
      ko(`${url}\n       ${result.reason}`);
      allGood = false;
    }
  }

  return allGood;
}

/** Vérifications nécessitant un jeton Meta valide. */
async function checkAccount(igId: string): Promise<boolean> {
  let allGood = true;

  console.log('\nQuota de publication');
  try {
    const limit = await graphGet<{ data?: Array<{ quota_usage?: number }> }>(
      `${igId}/content_publishing_limit`,
      { fields: 'quota_usage' }
    );
    const used = limit.data?.[0]?.quota_usage;
    if (used === undefined) {
      ok('quota indisponible — sans incidence sur la publication');
    } else if (used >= 100) {
      ko(`${used}/100 sur 24 h — plafond atteint, la publication échouera`);
      allGood = false;
    } else {
      ok(`${used}/100 sur 24 h glissantes`);
    }
  } catch (err) {
    ok(`quota invérifiable (${errorMessage(err)}) — sans incidence`);
  }

  return allGood;
}

async function postImage(igId: string, imageUrl: string, caption: string): Promise<MediaResponse> {
  console.log(`\nCréation du container...`);
  const container = await graphPost<MediaResponse>(`${igId}/media`, {
    image_url: imageUrl,
    caption,
  });

  console.log(`Publication du container ${container.id}...`);
  const published = await graphPost<MediaResponse>(`${igId}/media_publish`, {
    creation_id: container.id,
  });

  console.log(`\n✅ Publié. ID du média : ${published.id}`);
  return published;
}

async function postCarousel(
  igId: string,
  imageUrls: string[],
  caption: string
): Promise<MediaResponse> {
  console.log(`\nCréation de ${imageUrls.length} containers enfants...`);
  const childIds: string[] = [];
  for (const url of imageUrls) {
    const child = await graphPost<MediaResponse>(`${igId}/media`, {
      image_url: url,
      is_carousel_item: 'true',
    });
    childIds.push(child.id);
    console.log(`  ✓ ${child.id}`);
  }

  console.log(`Création du container parent...`);
  const parent = await graphPost<MediaResponse>(`${igId}/media`, {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption,
  });

  console.log(`Publication du carrousel ${parent.id}...`);
  const published = await graphPost<MediaResponse>(`${igId}/media_publish`, {
    creation_id: parent.id,
  });

  console.log(`\n✅ Carrousel publié. ID du média : ${published.id}`);
  return published;
}

await runCli(async () => {
  const urls = CAROUSEL_URLS.length > 0 ? CAROUSEL_URLS : [IMAGE_URL];

  console.log(`\n── ${LIVE ? 'Publication' : 'Simulation'} ─────────────────────────────────`);

  // Le contenu se valide sans Meta : on commence par là pour donner un retour
  // utile même quand le jeton n'est pas encore configuré.
  const contentOk = await checkContent(urls, CAPTION);

  console.log('\nCompte Meta');
  let igId: string;
  try {
    const pageId = requireEnv('META_PAGE_ID', 'ID de la Page Facebook liée au compte Instagram');
    igId = await resolveInstagramUserId(pageId);
    ok(`compte Instagram ${igId}`);
  } catch (err) {
    ko(errorMessage(err));
    console.log(`\n❌ Accès Meta indisponible — rien n'a été publié.`);
    console.log(`   Les vérifications de contenu ci-dessus restent valables.\n`);
    process.exit(1);
  }

  const accountOk = await checkAccount(igId);

  if (!contentOk || !accountOk) {
    console.log(`\n❌ Vérifications échouées — rien n'a été publié.\n`);
    process.exit(1);
  }

  if (!LIVE) {
    console.log(`\n✅ Tout est prêt. Rien n'a été publié.`);
    console.log(`   Pour publier réellement : npm run post:live\n`);
    return;
  }

  const [first] = urls;
  if (urls.length > 1) await postCarousel(igId, urls, CAPTION);
  else if (first) await postImage(igId, first, CAPTION);
  console.log('');
});
