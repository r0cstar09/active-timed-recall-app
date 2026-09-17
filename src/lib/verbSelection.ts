/**
 * The exact ranked inventory supplied by Tony in
 * "Quantitative Corpus Analysis of the Sixty Most Frequent Spanish Verbs".
 * This is his chosen curriculum, not a claim that all corpora share this ranking.
 * Do not substitute morphological categories or the legacy email rotation.
 */
export const CORE_SPANISH_VERBS = Object.freeze([
  "ser", "haber", "estar", "tener", "hacer", "poder", "decir", "ir", "ver", "dar",
  "saber", "querer", "llegar", "pasar", "deber", "poner", "parecer", "quedar", "creer", "hablar",
  "llevar", "dejar", "seguir", "encontrar", "llamar", "venir", "pensar", "salir", "volver", "tomar",
  "conocer", "vivir", "sentir", "tratar", "mirar", "contar", "empezar", "esperar", "buscar", "existir",
  "entrar", "trabajar", "escribir", "perder", "producir", "ocurrir", "entender", "pedir", "recibir", "recordar",
  "terminar", "permitir", "aparecer", "conseguir", "comenzar", "servir", "sacar", "necesitar", "mantener", "resultar",
] as const);

const coreRanks = new Map<string, number>(CORE_SPANISH_VERBS.map((verb, index) => [verb, index + 1]));

export function coreVerbRank(verb: string): number | undefined {
  return coreRanks.get(verb);
}

/** A presentation-only projection used for both the live API and bundled fallback.
 * Saved completion wins over frequency, category, and historical pass thresholds.
 * Entries and progress are never changed; non-core relative order stays stable.
 */
export function groupVerbCatalog<T extends { verb: string }>(
  verbs: readonly T[],
  progress: Readonly<Record<string, { completed: number | boolean }>>,
) {
  const completed: T[] = [];
  const core: T[] = [];
  const other: T[] = [];
  const available = new Set<string>();
  let coreCompleted = 0;
  for (const entry of verbs) {
    available.add(entry.verb);
    const inCore = coreRanks.has(entry.verb);
    const savedCompletion = progress[entry.verb]?.completed;
    if (savedCompletion === 1 || savedCompletion === true) {
      completed.push(entry);
      if (inCore) coreCompleted += 1;
    } else if (inCore) {
      core.push(entry);
    } else {
      other.push(entry);
    }
  }
  core.sort((a, b) => coreRanks.get(a.verb)! - coreRanks.get(b.verb)!);
  return {
    completed, core, other, coreCompleted,
    missingCore: CORE_SPANISH_VERBS.filter((verb) => !available.has(verb)),
  };
}
