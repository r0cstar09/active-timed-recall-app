import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { DashboardStats } from "../lib/types";
import { loadSession } from "../lib/timer";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "¡Buenos días!";
  if (h < 19) return "¡Buenas tardes!";
  return "¡Buenas noches!";
}

export default function DueSummary() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasResumable, setHasResumable] = useState(false);

  useEffect(() => {
    setHasResumable(!!loadSession());
    let alive = true;
    (async () => {
      try {
        const [counts, sourceCount] = await Promise.all([
          api.getDashboardCounts(),
          api.countSources(),
        ]);
        if (alive) {
          setStats({
            dueCount: counts.due_count,
            newCount: counts.new_count,
            learningCount: counts.learning_count,
            reviewCount: counts.review_count,
            totalCards:
              counts.new_count +
              counts.learning_count +
              counts.review_count +
              counts.suspended_count,
            sourceCount,
          });
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const dailyGoalCopy = useMemo(() => {
    if (loading) return "Preparando tu sesión…";
    const due = stats?.dueCount ?? 0;
    const learning = stats?.learningCount ?? 0;
    if (due > 0) return `${due} frase${due === 1 ? "" : "s"} esperando tu voz`;
    if (learning > 0) return `${learning} en aprendizaje · perfecto para calentar`;
    return "Nada urgente: practica libre o aprende algo nuevo.";
  }, [loading, stats]);

  return (
    <div className="stack">
      {error && (
        <div className="alert alert-error">
          {error}
          <div className="small faint" style={{ marginTop: 6 }}>
            Confirm the backend is reachable over Tailscale, then check the API base URL in Ajustes.
          </div>
        </div>
      )}

      <div className="card card-tile stack">
        <div className="row between wrap">
          <div>
            <div className="spanish-kicker">{greeting()}</div>
            <h2 style={{ marginBottom: 4 }}>Tu racha empieza con una frase.</h2>
            <p className="muted" style={{ margin: 0 }}>{dailyGoalCopy}</p>
          </div>
          <span className="pill pill-good">racha · hoy</span>
        </div>
        <a className="btn btn-primary btn-block btn-lg" href={hasResumable ? "/session" : "/session?mode=review"}>
          {hasResumable ? "Continuar sesión" : "Empieza ahora"}
        </a>
      </div>

      <div className="stat-grid" aria-label="Today's Spanish practice counts">
        <div className="stat">
          <div className="num">{loading ? "·" : (stats?.dueCount ?? 0)}</div>
          <div className="lbl">para hablar</div>
        </div>
        <div className="stat">
          <div className="num">{loading ? "·" : (stats?.newCount ?? 0)}</div>
          <div className="lbl">nuevas</div>
        </div>
        <div className="stat">
          <div className="num">{loading ? "·" : (stats?.learningCount ?? 0)}</div>
          <div className="lbl">calentando</div>
        </div>
      </div>

      {hasResumable && (
        <div className="alert">
          Tu conversación está pausada. <a href="/session">Retómala →</a>
        </div>
      )}

      <div className="card stack">
        <div className="spanish-kicker">modo de práctica</div>
        <a className="btn btn-primary btn-block btn-lg" href="/session?mode=learn">
          Aprende significado <span className="small faint">· audio + lógica española</span>
        </a>
        <a className="btn btn-block" href="/session?mode=review">
          Repasar lo debido
        </a>
        <a className="btn btn-block" href="/session?mode=practice">
          Practicar libre <span className="small faint">sin FSRS</span>
        </a>
        <a className="btn btn-block" href="/session?mode=misses">
          A pulir <span className="small faint">frases falladas</span>
        </a>
      </div>

      <div className="row between small faint">
        <span>
          {stats ? `${stats.totalCards} frases` : "—"} · {stats ? `${stats.sourceCount} fuentes` : "—"}
        </span>
        <a href="/ingest">Añadir fuente →</a>
      </div>
    </div>
  );
}
