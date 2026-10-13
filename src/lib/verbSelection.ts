/**
 * The exact ranked inventory supplied by Tony in
 * "Quantitative Corpus Analysis of the Sixty Most Frequent Spanish Verbs".
 * Preserved as the original curriculum, not a universal everyday-utility ranking.
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

/**
 * Personalized practical supplement: everyday needs, communication, routines,
 * transactions and relationships, including all fourteen gaps Tony identified.
 * The order is a study recommendation, NOT measured corpus frequency ranks 61–90
 * or a coverage percentage. No prerequisite gate and no changes to saved learning.
 */
export const NEXT_30_SPANISH_VERBS = Object.freeze([
  "gustar", "ayudar", "usar", "cambiar", "comprar", "pagar", "comer", "beber", "dormir", "escuchar",
  "preguntar", "responder", "explicar", "aprender", "estudiar", "leer", "abrir", "cerrar", "traer", "subir",
  "bajar", "jugar", "ganar", "viajar", "preferir", "olvidar", "levantar", "lavar", "amar", "mentir",
] as const);

const coreRanks = new Map<string, number>(CORE_SPANISH_VERBS.map((verb, index) => [verb, index + 1]));
const nextPriorities = new Map<string, number>(NEXT_30_SPANISH_VERBS.map((verb, index) => [verb, index + 1]));

export function coreVerbRank(verb: string): number | undefined {
  return coreRanks.get(verb);
}

export function nextVerbPriority(verb: string): number | undefined {
  return nextPriorities.get(verb);
}

/** Presentation only, shared by the live API and bundled fallback.
 * Saved completion wins over priority, category and historical pass thresholds.
 * Entries/progress are never changed; non-priority relative order stays stable.
 */
export function groupVerbCatalog<T extends { verb: string }>(
  verbs: readonly T[],
  progress: Readonly<Record<string, { completed: number | boolean }>>,
) {
  const completed: T[] = [];
  const core: T[] = [];
  const next: T[] = [];
  const other: T[] = [];
  const available = new Set<string>();
  let coreCompleted = 0;
  let nextCompleted = 0;
  for (const entry of verbs) {
    available.add(entry.verb);
    const inCore = coreRanks.has(entry.verb);
    const inNext = nextPriorities.has(entry.verb);
    const savedCompletion = progress[entry.verb]?.completed;
    if (savedCompletion === 1 || savedCompletion === true) {
      completed.push(entry);
      if (inCore) coreCompleted += 1;
      if (inNext) nextCompleted += 1;
    } else if (inCore) {
      core.push(entry);
    } else if (inNext) {
      next.push(entry);
    } else {
      other.push(entry);
    }
  }
  core.sort((a, b) => coreRanks.get(a.verb)! - coreRanks.get(b.verb)!);
  next.sort((a, b) => nextPriorities.get(a.verb)! - nextPriorities.get(b.verb)!);
  return {
    completed, core, next, other, coreCompleted, nextCompleted,
    missingCore: CORE_SPANISH_VERBS.filter((verb) => !available.has(verb)),
    missingNext: NEXT_30_SPANISH_VERBS.filter((verb) => !available.has(verb)),
  };
}
