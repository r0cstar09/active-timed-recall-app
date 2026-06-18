import type { CSSProperties } from "react";

export type RegionKey = "madrid" | "cdmx" | "medellin" | "buenos-aires" | "san-juan";

export const REGIONS: Array<{ key: RegionKey; name: string; accent: string; flag: string; tile: string; landmark: string }> = [
  { key: "madrid", name: "Madrid", accent: "#c75b39", flag: "ES", tile: "talavera", landmark: "Puerta del Sol" },
  { key: "cdmx", name: "CDMX", accent: "#1f7a8c", flag: "MX", tile: "talavera", landmark: "Palacio rhythm" },
  { key: "medellin", name: "Medellín", accent: "#6b7d4e", flag: "CO", tile: "andes", landmark: "Valley cable" },
  { key: "buenos-aires", name: "Buenos Aires", accent: "#7c2d3a", flag: "AR", tile: "andalusian", landmark: "Obelisco glow" },
  { key: "san-juan", name: "San Juan", accent: "#e8a33d", flag: "PR", tile: "caribbean", landmark: "Old city fort" },
];

export function regionForIndex(index: number) {
  return REGIONS[((index % REGIONS.length) + REGIONS.length) % REGIONS.length];
}

export function regionFromText(text = "") {
  const lower = text.toLowerCase();
  return REGIONS.find((r) => lower.includes(r.key) || lower.includes(r.name.toLowerCase()) || lower.includes(r.flag.toLowerCase())) ?? regionForIndex(text.length);
}

export function RegionArt({ region, className = "", small = false }: { region: RegionKey | string; className?: string; small?: boolean }) {
  const r = REGIONS.find((x) => x.key === region) ?? regionFromText(String(region));
  const style = { "--region-accent": r.accent } as CSSProperties;
  return (
    <svg className={`region-art region-${r.key} ${small ? "small" : ""} ${className}`} style={style} viewBox="0 0 240 150" role="img" aria-label={`${r.name} landmark illustration`}>
      <defs>
        <linearGradient id={`sky-${r.key}`} x1="0" x2="1"><stop stopColor={r.accent} stopOpacity=".34"/><stop offset="1" stopColor="#e8a33d" stopOpacity=".2"/></linearGradient>
      </defs>
      <rect width="240" height="150" rx="28" fill={`url(#sky-${r.key})`} />
      <circle cx="196" cy="36" r="19" fill="#f4cf72" opacity=".9" />
      <path d="M0 118 C48 92 82 128 126 104 C166 82 197 102 240 83 V150 H0Z" fill={r.accent} opacity=".18" />
      {r.key === "madrid" && <><path d="M52 102h136v26H52z" fill="currentColor" opacity=".12"/><path d="M68 100V62h24v38M108 100V50h24v50M148 100V66h24v34" stroke="currentColor" strokeWidth="8"/><path d="M78 57l42-22 42 26" fill="none" stroke="currentColor" strokeWidth="7"/></>}
      {r.key === "cdmx" && <><path d="M44 105h152v23H44z" fill="currentColor" opacity=".12"/><path d="M64 100h112V69H64z" stroke="currentColor" strokeWidth="8" fill="none"/><path d="M82 69l38-28 38 28M92 88h56" stroke="currentColor" strokeWidth="7"/></>}
      {r.key === "medellin" && <><path d="M18 116c34-42 66-38 104-10s67 8 100-28v72H18z" fill="currentColor" opacity=".13"/><path d="M52 74l136-28M74 69v44M168 50v52" stroke="currentColor" strokeWidth="6"/><rect x="92" y="51" width="30" height="18" rx="7" fill="currentColor" opacity=".55"/></>}
      {r.key === "buenos-aires" && <><path d="M112 34h16l10 88H102z" fill="currentColor" opacity=".55"/><path d="M70 123h100M88 110h64" stroke="currentColor" strokeWidth="7"/><path d="M52 128h136" stroke="currentColor" strokeWidth="10" opacity=".2"/></>}
      {r.key === "san-juan" && <><path d="M48 90h138v38H48z" fill="currentColor" opacity=".13"/><path d="M62 100V69h28v31M102 100V60h28v40M142 100V72h28v28" stroke="currentColor" strokeWidth="8"/><path d="M48 72h148M58 122h128" stroke="currentColor" strokeWidth="7"/><path d="M40 126c34-15 60-1 90-9 32-9 58-17 86 1" stroke="#1f7a8c" strokeWidth="6" opacity=".55" fill="none"/></>}
      <text x="18" y="34" fontSize="17" fontWeight="800" fill="currentColor" opacity=".72">{r.flag}</text>
    </svg>
  );
}

export function StateIllustration({ type = "loading" }: { type?: "loading" | "empty" | "celebrate" }) {
  return (
    <div className={`state-illo state-${type}`} aria-hidden="true">
      <span className="state-stamp" />
      <span className="state-bag" />
      <span className="state-spark one" />
      <span className="state-spark two" />
    </div>
  );
}
