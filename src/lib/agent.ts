/**
 * Agent de prospection : qualifie un compte Instagram et rédige le premier
 * message, via l'API OpenAI en sortie structurée.
 *
 * Le modèle ne décide de rien d'irréversible : il propose une catégorie, un
 * score et un brouillon, que le code range dans le Sheet. L'envoi reste une
 * action humaine (ou une réponse privée autorisée par Meta).
 *
 * Seules des données publiques de compte professionnel lui sont transmises :
 * nom, bio, site, nombre d'abonnés, extrait du commentaire.
 */
import { optionalEnv, requireEnv } from './env.js';
import type { Prospect } from './prospection.js';

const MODEL = optionalEnv('OPENAI_MODEL', 'gpt-5-mini');

export interface Qualification {
  category: 'prospect' | 'client' | 'concurrent' | 'particulier' | 'createur' | 'autre';
  sector: string;
  score: number;
  reason: string;
  message: string;
}

const SCHEMA = {
  name: 'qualification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'sector', 'score', 'reason', 'message'],
    properties: {
      category: { type: 'string', enum: ['prospect', 'client', 'concurrent', 'particulier', 'createur', 'autre'] },
      sector: { type: 'string', description: 'Secteur d’activité en deux ou trois mots, en français.' },
      score: { type: 'integer', description: 'Intérêt commercial de 0 à 100.' },
      reason: { type: 'string', description: 'Justification en une phrase.' },
      message: { type: 'string', description: 'Premier message privé, vide si la catégorie n’est pas « prospect ».' },
    },
  },
} as const;

const SYSTEM = `Tu es l'assistant commercial de Pause-Com (@pausecom.agency, https://www.pause-com.fr), agence de communication et de réseaux sociaux présente en France, aux États-Unis et en Suisse. Sa promesse : « Nous imaginons des solutions sur-mesure pour renforcer votre visibilité, raconter votre histoire et attirer davantage de clients. » Ses clients sont surtout des restaurants, commerces de bouche et marques lifestyle.

On te donne un compte Instagram qui a commenté une publication de Pause-Com. Tu dois :
1. Le classer :
   - prospect : une entreprise, un commerce, un restaurant, une marque ou un indépendant qui pourrait confier sa communication à une agence ;
   - client : il semble déjà travailler avec Pause-Com ;
   - concurrent : agence, freelance en communication, community manager, social media manager ;
   - createur : influenceur, photographe ou vidéaste qui vit de son audience ;
   - particulier : compte personnel ;
   - autre : impossible à déterminer.
2. Donner un score de 0 à 100 : probabilité qu'il ait besoin d'une agence et puisse la payer. Un établissement local actif avec peu d'abonnés et sans communication soignée vaut plus qu'une grande marque qui a déjà son agence.
3. Si et seulement si c'est un prospect, rédiger le premier message privé Instagram :
   - en français, vouvoiement, ton chaleureux et direct, 450 caractères maximum, sans emoji en excès ;
   - commencer par dire d'où vient le contact (son commentaire sur une publication de Pause-Com) ;
   - citer une référence UNIQUEMENT si elle figure dans la liste « Références autorisées » ; sinon parler de « nos clients » sans nom ;
   - si le prospect est venu via une publication réalisée avec une référence autorisée, la citer en priorité ;
   - proposer simplement d'en parler (par exemple un court appel), sans promesse chiffrée ni information inventée ;
   - finir par : « Si vous ne souhaitez pas être recontacté, dites-le-moi simplement. »
N'invente jamais un fait absent des données fournies.`;

function describe(p: Prospect, references: Prospect[]): string {
  const viaAllowed = (p.Via ?? '').split(', ').filter((v) => references.some((r) => r.Compte === v));
  return [
    `Compte : @${p.Compte}`,
    `Nom : ${p.Nom || '(inconnu)'}`,
    `Bio : ${p.Bio || '(vide)'}`,
    `Site : ${p.Site || '(aucun)'}`,
    `Abonnés : ${p.Abonnés || '(inconnu)'}`,
    `Compte professionnel : ${p['Compte pro'] || 'non'}`,
    `Son dernier commentaire : « ${p.Extrait || ''} »`,
    `Publication commentée réalisée avec : ${viaAllowed.length ? viaAllowed.map((v) => '@' + v).join(', ') : '(aucune référence autorisée)'}`,
    '',
    'Références autorisées :',
    ...(references.length
      ? references.map((r) => `- @${r.Compte}${r.Nom ? ` (${r.Nom})` : ''}${r.Secteur ? `, ${r.Secteur}` : ''}`)
      : ['(aucune : ne cite aucun client)']),
  ].join('\n');
}

export async function qualify(p: Prospect, references: Prospect[]): Promise<Qualification> {
  const key = requireEnv('OPENAI_API_KEY');
  const body = JSON.stringify({
    model: MODEL,
    reasoning_effort: 'low',
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: describe(p, references) },
    ],
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(90_000),
    });
    // Limite de débit ou panne passagère : une seule nouvelle tentative.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    const data = (await res.json()) as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string; refusal?: string } }>;
    };
    if (!res.ok) throw new Error(`OpenAI ${res.status} — ${data.error?.message ?? 'erreur inconnue'}`);
    const msg = data.choices?.[0]?.message;
    if (!msg?.content) throw new Error(`OpenAI : réponse vide${msg?.refusal ? ` (${msg.refusal})` : ''}`);
    const q = JSON.parse(msg.content) as Qualification;
    q.score = Math.max(0, Math.min(100, Math.round(q.score)));
    if (q.category !== 'prospect') q.message = '';
    return q;
  }
}
