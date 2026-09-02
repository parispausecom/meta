import 'dotenv/config';

/**
 * Lit une variable d'environnement obligatoire, ou arrête le process avec un
 * message explicite plutôt qu'un `undefined` qui échouerait plus loin.
 *
 * Le type de retour `string` (et non `string | undefined`) est ce qui rend le
 * reste du code lisible : l'appelant n'a jamais à re-tester la valeur.
 */
export function requireEnv(name: string, hint = ''): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variable d'environnement manquante : ${name}`);
    if (hint) console.error(`  → ${hint}`);
    console.error(`  Renseigne-la dans le fichier .env (voir .env.example).`);
    process.exit(1);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** Extrait un message lisible de n'importe quelle valeur levée. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Exécute un script CLI en affichant les erreurs lisiblement plutôt qu'en
 * stack trace Node brute.
 */
export async function runCli(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`\n❌ ${errorMessage(err)}`);
    if (process.env.DEBUG) console.error(err);
    else console.error(`\n   (relance avec DEBUG=1 pour la trace complète)`);
    process.exit(1);
  }
}
