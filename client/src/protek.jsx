// File: protek.jsx
import React, { useEffect, useMemo, useState } from "react";
import NewSlideProtek from "./NewSlideProtek";

/* ----------------- stile bottoni scorciatoie ----------------- */
const PROTEK_BTN_STYLE = {
  padding: "10px 20px",
  background: "#1A202C",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  boxShadow: "0 4px 6px rgba(0,0,0,.3)",
  transition: "transform .2s",
};
const PROTEK_BTN_HOVER = {
  transform: "scale(1.05)",
  boxShadow: "0 6px 8px rgba(0,0,0,.4)",
};

/* ----------------- scorciatoie esterne ----------------- */
const PROTEK_CONSUMI_URL =
  (import.meta?.env?.VITE_CONSUMI_URL?.replace(/\/+$/, "")) ||
  `${location.protocol}//${location.hostname}:3002`;
const PROTEK_STORICO_FALLBACK = "http://192.168.1.41/wsmeasure/big?language=it";
const PROTEK_STORICO_CONFIRM =
  "Vuoi accedere alla finestra Storico? pin 99999 puk 00000 9999 00000";

/* ----------------- Agent Protek (backend energia) ----------------- */
const PROTEK_BASE =
  (import.meta?.env?.VITE_PROTEK_AGENT &&
    import.meta.env.VITE_PROTEK_AGENT.replace(/\/+$/, "")) ||
  "http://192.168.1.250:5052/api";

/* ----------------- fetch robusto ----------------- */
async function safeFetchJson(input, init) {
  const res = await fetch(input, init);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  let data, text;
  try {
    if (ct.includes("application/json")) data = await res.json();
    else {
      text = await res.text();
      const t = (text || "").trim();
      if (t.startsWith("{") || t.startsWith("[")) data = JSON.parse(t);
    }
  } catch {}
  return { ok: res.ok, status: res.status, data, text };
}

/* ----------------- util formattazione ----------------- */
function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtDuration(start, end) {
  if (!start || !end) return "—";
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "—";
  const mins = Math.floor((b - a) / 60000);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${hh}h ${mm}m`;
}

/* ----------------- helpers di normalizzazione ----------------- */
const first = (...vals) =>
  vals.find((v) => v !== undefined && v !== null && v !== "") ?? "";
const toISO = (d, t) => {
  if (!d) return null;
  try {
    if (t) return new Date(`${d} ${t}`).toISOString();
    return new Date(d).toISOString();
  } catch {
    return null;
  }
};

// ISO week helpers
function getISOWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
function getISOWeekYear(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return d.getUTCFullYear();
}

// Restituisce il filename del weekly per la settimana/anno selezionati
const getFilenameForWeek = (w = selectedWeek, y = selectedYear) =>
  weeksList.find((x) => x.week === w && x.year === y)?.filename || null;


/* ----------------- confronto "smart" delle righe ----------------- */
function areRowsEqual(a = [], b = []) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const mapA = new Map(a.map((r) => [String(r.id ?? ""), r]));
  for (const rb of b) {
    const id = String(rb.id ?? "");
    const ra = mapA.get(id);
    if (!ra) return false;
    const keys = [
      "description",
      "customer",
      "latestState",
      "startTime",
      "endTime",
      "consumo_kwh",
    ];
    for (const k of keys) {
      const va = ra[k];
      const vb = rb[k];
      if (k === "consumo_kwh") {
        const na = Number.isFinite(+va) ? +va : va;
        const nb = Number.isFinite(+vb) ? +vb : vb;
        if (na !== nb) return false;
      } else if (va !== vb) {
        return false;
      }
    }
  }
  return true;
}

/* ================================================================
   COMPONENTE
================================================================ */
export default function ProtekPage({ onBack, server }) {
  const API_BASE = (
    server || import.meta?.env?.VITE_API_BASE || "http://192.168.1.250:3001"
  ).replace(/\/+$/, "");
  const api = (p) => `${API_BASE}${p.startsWith("/") ? p : `/${p}`}`;

  // dati tabella
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshedAt, setRefreshedAt] = useState("");
  const [meta, setMeta] = useState(null);

  // filtri
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("ALL");

  // impostazioni
  const [storicoConsumiUrl, setStoricoConsumiUrl] = useState("");
  const [monitorPath, setMonitorPath] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // settimane
  const [weeksList, setWeeksList] = useState([]); // [{week, year, filename}]
  const [selectedWeek, setSelectedWeek] = useState(null);
  const [selectedYear, setSelectedYear] = useState(null);
  const [userTouchedWeek, setUserTouchedWeek] = useState(false);

  // helper per ottenere il filename della settimana selezionata
  const getFilenameForWeek = (w = selectedWeek, y = selectedYear) =>
    weeksList.find((x) => x.week === w && x.year === y)?.filename || null;


  // === Potenza istantanea dall’agent ===
  const [instantKw, setInstantKw] = useState(null);       // smussato (EMA)
  const [instantKwRaw, setInstantKwRaw] = useState(null); // lettura grezza
  const [instantStale, setInstantStale] = useState(false);
  const [instantTs, setInstantTs] = useState("");
  const EMA_ALPHA = 0.4; // smoothing

  /* -------- Normalizzatori -------- */
  const normalizeFromPrograms = (list = []) =>
    list.map((p, i) => ({
      id: p.id ?? `${p.code || "row"}-${i}`,
      code: first(p.code, p.programCode, p.ProgramCode, p.name, p.Program),
      description: first(
        p.description,
        p.descrizione,
        p.programDescription,
        p.note,
        p.title
      ),
      customer: first(p.customer, p.customerName, p.client, p.cliente),
      latestState: first(p.latestState, p.state, p.status, p.Stato, p.Status),
      startTime:
        first(
          p.startTime,
          toISO(p.startDate, p.startTime),
          p.startedAt,
          p.start_date
        ) || null,
      endTime:
        first(
          p.endTime,
          toISO(p.endDate, p.endTime),
          p.completedAt,
          p.readyDate
        ) || null,
      numWorkings: p.numWorkings ?? p.workings ?? 0,
      consumo_kwh: p.consumo_kwh, // può esserci già dal server manager
      operators: p.operators,
      machines: p.machines,
      ordersCount: p.ordersCount,
      qtyOrdered: p.qtyOrdered,
      piecesFromNestings: p.piecesFromNestings,
    }));

  /* ----------------- settings ----------------- */
  const fetchSettings = async () => {
    try {
      const res = await safeFetchJson(api("/api/protek/settings"));
      if (res.ok && res.data) {
        const raw =
          typeof res.data.storicoConsumiUrl === "string"
            ? res.data.storicoConsumiUrl
            : "";
        setStoricoConsumiUrl(raw.replace(/"/g, "").trim());

        const mp =
          typeof res.data.monitorPath === "string" ? res.data.monitorPath : "";
        setMonitorPath(mp);
      }
    } catch (e) {
      console.warn("[PROTEK] Impossibile leggere impostazioni:", e?.message || e);
    }
  };

  /* ----------------- settimane disponibili ----------------- */
  const fetchWeeksList = async () => {
    try {
      const r = await safeFetchJson(api("/api/protek/settimanali-disponibili"));
      if (r.ok && Array.isArray(r.data)) {
        setWeeksList(r.data);
        if (!userTouchedWeek && r.data.length > 0) {
          setSelectedWeek(r.data[0].week);
          setSelectedYear(r.data[0].year);
        }
      } else {
        setWeeksList([]);
      }
    } catch {
      setWeeksList([]);
    }
  };

  /* ----------------- Calcolo kWh da agent Protek ----------------- */
  const calcEnergyForRows = async (rowsToCalc) => {
    // prepara jobs {id, startTime, endTime}
    const jobs = rowsToCalc
      .filter((r) => r.startTime) // serve almeno start
      .map((r) => ({
        id: String(r.id ?? ""),
        startTime: r.startTime,
        endTime: r.endTime || null, // se mancante → finestra mobile fino ad adesso
      }));

    if (jobs.length === 0) return rowsToCalc;

    // batch in chunk per evitare request troppo grandi
    const chunkSize = 150;
    const chunks = [];
    for (let i = 0; i < jobs.length; i += chunkSize) {
      chunks.push(jobs.slice(i, i + chunkSize));
    }

    const byId = {};
    for (const ch of chunks) {
      try {
        const r = await safeFetchJson(`${PROTEK_BASE}/energy/rangebulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobs: ch }),
        });
        if (r.ok && r.data && r.data.data && r.data.data.byId) {
          Object.assign(byId, r.data.data.byId);
        }
      } catch (e) {
        console.warn("calcEnergyForRows chunk error:", e);
      }
    }

    // unisci ai rows
    const merged = rowsToCalc.map((r) => {
      const id = String(r.id ?? "");
      const it = byId[id];
      if (!it || typeof it.kwh !== "number") return r;

      // Se job è ancora aperto (endTime mancante), mostro "~kWh"
      const kwh = Number(it.kwh);
      const open = !r.endTime;
      return {
        ...r,
        consumo_kwh: open ? `~${kwh.toFixed(3)}` : Number(kwh.toFixed(6)),
      };
    });

    return merged;
  };

  /* ----------------- dati per settimana ----------------- */
  const fetchWeeklyData = async (
    week = selectedWeek,
    year = selectedYear,
    opts = { silent: false }
  ) => {
    if (!week || !year) return;
    const { silent = false } = opts;

    try {
      if (!silent) {
        setLoading(true);
        setError("");
      }

      const r = await safeFetchJson(
        api(`/api/protek/storico-settimana?week=${week}&year=${year}`)
      );

      let baseRows = [];
      let newMeta = null;

      if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
        baseRows = normalizeFromPrograms(r.data);
        newMeta = { week, year, source: "weekly" };
      } else {
        // fallback all'elenco "programs" live
        const r2 = await safeFetchJson(api("/api/protek/programs"));
        if (r2.ok && Array.isArray(r2.data?.programs)) {
          baseRows = normalizeFromPrograms(r2.data.programs);
          newMeta = r2.data.meta || r2.data.__meta || { source: "programs" };
        } else {
          baseRows = [];
          newMeta = null;
        }
      }

      // --> calcola i kWh dal device (file data_protek.json) tramite agent
const enriched = await calcEnergyForRows(baseRows);

setRefreshedAt(new Date().toISOString());

// Salva meta con filename, se disponibile
const filename = getFilenameForWeek(week, year);
newMeta = { ...(newMeta || {}), week, year, filename, source: (newMeta?.source || "weekly") };
setMeta(newMeta);

// Imposta le righe ora (usa l'array arricchito)
if (!areRowsEqual(rows, enriched)) {
  setRows(enriched);
}

// Se nel weekly mancano consumo_kwh -> chiedi al 5052 di annotare e poi ricarica
const missingKwh = Array.isArray(enriched) && enriched.length > 0 &&
  enriched.some(r => r.consumo_kwh == null);


      if (missingKwh && filename) {
        // CHIAMATA al 5052 per annotare i kWh in modo non-decrescente
        await safeFetchJson(`${PROTEK_BASE}/protek/annotate-file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: filename }),
        });

        // RICARICO il weekly per mostrare i valori aggiornati
        const r3 = await safeFetchJson(
          api(`/api/protek/storico-settimana?week=${week}&year=${year}`)
        );
        if (r3.ok && Array.isArray(r3.data)) {
          const rowsAfter = normalizeFromPrograms(r3.data);
          if (!areRowsEqual(rows, rowsAfter)) {
            setRows(rowsAfter);
          }
        }
      }
    } catch (e) {
      if (!silent) {
        setRows([]);
        setMeta(null);
        setError(String(e?.message || e));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  /* ----------------- lifecycle ----------------- */
  const reloadAll = () => {
    fetchSettings();
    fetchWeeksList();
  };

  useEffect(() => {
    reloadAll();
    // eslint-disable-next-line react-hooks-exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedWeek && selectedYear) {
      fetchWeeklyData(selectedWeek, selectedYear, { silent: false });
    }
    // eslint-disable-next-line react-hooks-exhaustive-deps
  }, [selectedWeek, selectedYear]);

  // Auto-refresh dati tabella (solo settimana corrente) in SILENT
  useEffect(() => {
    if (!selectedWeek || !selectedYear) return;
    const isCurrent =
      selectedWeek === getISOWeek(new Date()) &&
      selectedYear === getISOWeekYear(new Date());
    if (!isCurrent) return;
    const id = setInterval(() => {
      fetchWeeklyData(selectedWeek, selectedYear, { silent: true });
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks-exhaustive-deps
  }, [selectedWeek, selectedYear]);

  // Polling potenza istantanea (1 Hz) con smoothing EMA
  useEffect(() => {
    let mounted = true;

    const fetchInstant = async () => {
      try {
        const r = await safeFetchJson(`${PROTEK_BASE}/instant`);
        if (!mounted) return;

        if (r.ok && r.data) {
          let val = null;
          if (typeof r.data.instant_kw === "number") {
            val = r.data.instant_kw;
          } else {
            const k1 = Number(r.data.instant_kw_1 ?? 0);
            const k2 = Number(r.data.instant_kw_2 ?? 0);
            if (Number.isFinite(k1) || Number.isFinite(k2)) {
              val =
                (Number.isFinite(k1) ? k1 : 0) +
                (Number.isFinite(k2) ? k2 : 0);
            }
          }
          if (val != null && Number.isFinite(val)) {
            setInstantKwRaw(val);
            setInstantKw((prev) =>
              prev == null ? val : prev + EMA_ALPHA * (val - prev)
            );
          }
          setInstantStale(Boolean(r.data.stale));
          setInstantTs(String(r.data.ts || new Date().toISOString()));
        }
      } catch {}
    };

    fetchInstant();
    const id = setInterval(fetchInstant, 1000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  /* ----------------- handlers ----------------- */
  const handleSettingsSaved = (payload) => {
    if (payload && typeof payload.storicoConsumiUrl === "string") {
      setStoricoConsumiUrl(payload.storicoConsumiUrl.replace(/"/g, "").trim());
    }
    if (payload && typeof payload.monitorPath === "string") {
      setMonitorPath(payload.monitorPath);
    }
    reloadAll();
  };
  const handleSettingsClose = () => {
    setSettingsOpen(false);
    setTimeout(reloadAll, 100);
  };

  /* ----------------- filtri client ----------------- */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const hay = [
        r.code,
        r.description,
        r.customer,
        r.operators,
        r.machines,
        String(r.ordersCount),
        String(r.qtyOrdered),
        String(r.piecesFromNestings),
      ]
        .join(" | ")
        .toLowerCase();

      const passesSearch = !q || hay.includes(q);
      const passesState =
        stateFilter === "ALL" ||
        (r.latestState || "").toLowerCase() === stateFilter.toLowerCase();

      return passesSearch && passesState;
    });
  }, [rows, search, stateFilter]);

// === Ordina i risultati: più recenti in alto (usa endTime, altrimenti startTime)
const filteredSorted = useMemo(() => {
  const toTs = (row) => {
    const t = row.endTime || row.startTime || null;
    const ts = t ? new Date(t).getTime() : 0;
    return Number.isFinite(ts) ? ts : 0;
  };
  // copia + sort DESC
  return [...filtered].sort((a, b) => toTs(b) - toTs(a));
}, [filtered]);


  const storicoUrlClean = useMemo(
    () => (storicoConsumiUrl || "").replace(/"/g, "").trim(),
    [storicoConsumiUrl]
  );
  const storicoEffectiveUrl = storicoUrlClean || PROTEK_STORICO_FALLBACK;

  const handleOpenConsumi = () => {
    window.open(PROTEK_CONSUMI_URL, "_blank");
  };
  const handleOpenStorico = () => {
    if (window.confirm(PROTEK_STORICO_CONFIRM)) {
      window.open(storicoEffectiveUrl, "_blank");
    }
  };

  // Badge potenza istantanea
  const InstantBadge = () => {
    const valTxt =
      instantKw == null ? "—" : Number(instantKw).toFixed(2) + " kW";
    const dotColor = instantStale ? "#F59E0B" : "#10B981"; // giallo se stale, verde se ok
    const title =
      instantTs && instantKwRaw != null
        ? `Ultimo: ${Number(instantKwRaw).toFixed(3)} kW @ ${fmtDate(instantTs)}`
        : "Potenza istantanea Protek";
    return (
      <div
        className="px-3 py-1 rounded-xl shadow text-sm flex items-center gap-2"
        title={title}
        style={{ background: "#F8FAFC", border: "1px solid #E2E8F0" }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dotColor,
            display: "inline-block",
          }}
        />
        <span className="font-medium">Potenza:</span>
        <span className="font-mono">{valTxt}</span>
      </div>
    );
  };

  return (
    <div className="w-full h-full flex flex-col gap-3 p-4">
      {/* HEADER */}
      <div className="flex items-center justify-between">
        <div className="text-xl font-semibold">Protek – Monitor Lavorazioni</div>
        <div className="flex items-center gap-2">
          {/* Badge potenza istantanea */}
          <InstantBadge />

          {/* HOME */}
          <button
            className="p-2 rounded-xl shadow hover:shadow-md"
            title="Torna allo Splash"
            aria-label="Home"
            onClick={onBack}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 10.5L12 3l9 7.5" />
              <path d="M5.5 9.5V20a1.5 1.5 0 0 0 1.5 1.5h10A1.5 1.5 0 0 0 18.5 20V9.5" />
              <path d="M9 21v-6h6v6" />
            </svg>
          </button>

          <button
            className="px-3 py-1 rounded-xl shadow text-sm hover:shadow-md flex items-center gap-2"
            title="Impostazioni Protek"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 3.4l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.39 1.26 1 1.51.16.07.33.11.51.11H21a2 2 0 1 1 0 4h-.09c-.18 0-.35.04-.51.11-.61.25-1 .85-1 1.51z"></path>
            </svg>
            Impostazioni
          </button>

          <button
            className="px-3 py-1 rounded-xl shadow text-sm hover:shadow-md"
            onClick={() => {
              if (selectedWeek && selectedYear) {
                fetchWeeklyData(selectedWeek, selectedYear, { silent: false });
              } else {
                reloadAll();
              }
            }}
            title="Aggiorna"
          >
            Aggiorna
          </button>

          <button
            className="px-3 py-1 rounded-xl shadow text-sm hover:shadow-md"
            onClick={async () => {
              try {
                const body =
                  selectedWeek && selectedYear
                    ? { week: selectedWeek, year: selectedYear }
                    : {};
                await safeFetchJson(api("/api/protek/rigenera-settimana"), {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                });
                await fetchWeeklyData(selectedWeek, selectedYear, { silent: false });
                await fetchWeeksList();
              } catch {}
            }}
            title="Rigenera subito il file settimanale dal server"
          >
            Rigenera settimana
          </button>
        </div>
      </div>

      {/* Bottoni scorciatoie */}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          gap: 20,
          justifyContent: "center",
          marginBottom: 12,
        }}
      >
        <button
          style={PROTEK_BTN_STYLE}
          onMouseOver={(e) =>
            Object.assign(e.currentTarget.style, PROTEK_BTN_HOVER)
          }
          onMouseOut={(e) =>
            Object.assign(e.currentTarget.style, PROTEK_BTN_STYLE)
          }
          onClick={handleOpenConsumi}
        >
          Consumi kWh
        </button>
        <button
          style={PROTEK_BTN_STYLE}
          onMouseOver={(e) =>
            Object.assign(e.currentTarget.style, PROTEK_BTN_HOVER)
          }
          onMouseOut={(e) =>
            Object.assign(e.currentTarget.style, PROTEK_BTN_STYLE)
          }
          onClick={handleOpenStorico}
          title={storicoEffectiveUrl}
        >
          Storico Consumi
        </button>
      </div>

      {/* INFO + FILTRI */}
      <div className="text-xs text-gray-500 flex items-center gap-3 flex-wrap">
        <div>
          Path monitorato:{" "}
          <span className="font-mono">
            {monitorPath || meta?.monitorPath || "—"}
          </span>
        </div>
        <div>
          • aggiornato:{" "}
          {refreshedAt
            ? new Date(refreshedAt).toLocaleString("it-IT")
            : "—"}
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {/* Selettore Settimana */}
          <div className="flex items-center gap-2">
            <span>Settimana:</span>
            <select
              className="border rounded-lg px-2 py-1 text-sm"
              value={
                selectedWeek && selectedYear
                  ? `${selectedWeek}_${selectedYear}`
                  : ""
              }
              onChange={(e) => {
                const [w, y] = e.target.value.split("_");
                setSelectedWeek(Number(w));
                setSelectedYear(Number(y));
                setUserTouchedWeek(true);
              }}
              title="Filtro per settimana"
            >
              {weeksList.map(({ week, year }) => (
                <option key={`${week}_${year}`} value={`${week}_${year}`}>
                  {`Settimana ${week} / ${year}`}
                </option>
              ))}
            </select>
          </div>

          {/* Ricerca */}
          <input
            className="border rounded-lg px-2 py-1 text-sm"
            placeholder="Cerca per codice/descrizione/cliente"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {/* Stato */}
          <select
            className="border rounded-lg px-2 py-1 text-sm"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            title="Filtro stato"
          >
            <option value="ALL">Tutti gli stati</option>
            <option value="STARTED">STARTED</option>
            <option value="RUNNING">RUNNING</option>
            <option value="PAUSED">PAUSED</option>
            <option value="FINISHED">FINISHED</option>
            <option value="DONE">DONE</option>
          </select>
        </div>
      </div>

      {/* ERROR */}
      {error && (
        <div className="p-2 rounded bg-red-100 text-red-700 text-sm">{error}</div>
      )}

      {/* TABELLA */}
      <div className="flex-1 overflow-auto rounded-2xl border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50">
            <tr className="text-left">
              <th className="p-2">Descrizione</th>
              <th className="p-2">Cliente</th>
              <th className="p-2">Stato</th>
              <th className="p-2">Inizio</th>
              <th className="p-2">Fine</th>
              <th className="p-2">Durata</th>
              <th className="p-2">Consumo kWh</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-gray-400">
                  Caricamento…
                </td>
              </tr>
            ) : !error && filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-gray-400">
                  Nessun dato da mostrare
                </td>
              </tr>
            ) : (
              filteredSorted.map((r) => (

                <tr key={r.id} className="border-t hover:bg-gray-50">
                  <td className="p-2">{r.description || "—"}</td>
                  <td className="p-2">{r.customer || "—"}</td>
                  <td className="p-2">{r.latestState || "—"}</td>
                  <td className="p-2">{fmtDate(r.startTime)}</td>
                  <td className="p-2">{fmtDate(r.endTime)}</td>
                  <td className="p-2">{fmtDuration(r.startTime, r.endTime)}</td>
                  <td className="p-2">
                    {r.consumo_kwh === undefined || r.consumo_kwh === null
                      ? "—"
                      : typeof r.consumo_kwh === "string" &&
                        r.consumo_kwh.startsWith("~")
                      ? r.consumo_kwh // job in corso → "~x.xxx"
                      : Number(r.consumo_kwh).toFixed(3)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* FOOTER */}
      <div className="text-xs text-gray-500">
        Totale righe: <b>{rows?.length ?? 0}</b>
      </div>

      {/* SLIDE-OVER IMPOSTAZIONI */}
      {settingsOpen && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[1px] flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-[min(1100px,96vw)] h-[min(90vh,820px)] overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b">
              <div className="text-base font-semibold">Impostazioni Protek</div>
              <button
                className="px-3 py-1 rounded-xl shadow text-sm hover:shadow-md"
                onClick={() => {
                  setSettingsOpen(false);
                  setTimeout(reloadAll, 100);
                }}
              >
                Chiudi
              </button>
            </div>
            <div className="h-[calc(100%-48px)] overflow-auto">
              <NewSlideProtek
                server={API_BASE}
                onSaved={(payload) => {
                  if (payload && typeof payload.storicoConsumiUrl === "string") {
                    setStoricoConsumiUrl(
                      payload.storicoConsumiUrl.replace(/"/g, "").trim()
                    );
                  }
                  if (payload && typeof payload.monitorPath === "string") {
                    setMonitorPath(payload.monitorPath);
                  }
                  reloadAll();
                }}
                onClose={() => {
                  setSettingsOpen(false);
                  setTimeout(reloadAll, 100);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
