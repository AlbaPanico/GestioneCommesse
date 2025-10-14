import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Settings, LogOut, Home } from 'lucide-react';

import { Card, CardContent } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import CalendarSlide from './CalendarSlide';
import CommesseGenerateSlide from './CommesseGenerateSlide';
import 'react-calendar/dist/Calendar.css';
import * as XLSX from 'xlsx';
import SelectedCalendar from './SelectedCalendar';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Portal } from '@radix-ui/react-portal';


// --- Sanitizzatori unici ---
const sanitizeAlnum = (s, { upper = true } = {}) =>
  (upper ? String(s).toUpperCase() : String(s)).replace(/[^A-Z0-9]/gi, '');

const sanitizeAlnumSpace = (s, { upper = false } = {}) =>
  (upper ? String(s).toUpperCase() : String(s)).replace(/[^A-Za-z0-9 ]/g, '');

const sanitizeDigits = (s) => String(s).replace(/\D+/g, '');
// --- fine sanitizzatori ---







// Helper per verificare se il form è valido (robusto agli undefined)
const isFormValid = ({ cliente, brand, nomeProdotto, codiceProgetto, codiceCommessa }) => {
  const s = v => String(v ?? '').trim();
  return s(cliente) && s(brand) && s(nomeProdotto) && (s(codiceProgetto) || s(codiceCommessa));
};


// Helper per calcolare un colore in base all'email
const getUserColor = (email) => {
  const colors = ["#F56565", "#ED8936", "#ECC94B", "#48BB78", "#38B2AC", "#4299E1", "#805AD5", "#D53F8C"];
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
};

// Helper per gestire le date
const parseDateFromString = (str) => {
  let date;
  if (str.includes('-')) {
    const [year, month, day] = str.split('-');
    date = new Date(year, month - 1, day);
  } else if (str.includes('/')) {
    const [day, month, year] = str.split('/');
    date = new Date(year, month - 1, day);
  } else {
    date = new Date(str);
  }
  return date;
};

const formatLocalDate = (date) => {
  const day = ('0' + date.getDate()).slice(-2);
  const month = ('0' + (date.getMonth() + 1)).slice(-2);
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

const formatISODate = (date) => {
  const year = date.getFullYear();
  const month = ('0' + (date.getMonth() + 1)).slice(-2);
  const day = ('0' + date.getDate()).slice(-2);
  return `${year}-${month}-${day}`;
};

const formatDisplayDate = (isoDateString) => {
  const parts = isoDateString.split('-'); // [YYYY, MM, DD]
  if (parts.length !== 3) return isoDateString;
  const day = parts[2];
  const month = parts[1];
  const year = parts[0].slice(-2);
  return `${day}_${month}_${year}`;
};

const calculateWorkingDaysRemaining = (deliveryDate) => {
  if (!deliveryDate) return 0;
  const today = new Date();
  const endDate = new Date(deliveryDate);
  if (today > endDate) return 0;
  let count = 0;
  let currentDate = new Date(today);
  while (currentDate <= endDate) {
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      count++;
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }
  return count;
};

export default function EspositoriApp({ onLogout, onHome }) {

  // Disabilita lo scrolling della pagina principale
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Logout automatico dopo 5 minuti di inattività
  useEffect(() => {
    let timeoutId;
    const logoutAfterInactivity = () => {
      alert("Logout automatico per inattività!");
      onLogout && onLogout();
    };
    const resetTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(logoutAfterInactivity, 300000); // 5 minuti
    };
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    events.forEach(event => window.addEventListener(event, resetTimer));
    resetTimer();
    return () => {
      events.forEach(event => window.removeEventListener(event, resetTimer));
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [onLogout]);

  // Heartbeat: invia un ping ogni 30 secondi
  useEffect(() => {
    const sendPing = async () => {
      const currentUser = localStorage.getItem("currentUser");
      if (!currentUser) return;
      try {
        const user = JSON.parse(currentUser);
        if (user.email) {
          await fetch("http://192.168.1.250:3001/api/ping", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: user.email }),
          });
          console.log("Ping inviato per:", user.email);
        }
      } catch (error) {
        console.error("Errore durante il ping:", error);
      }
    };

    sendPing();
    const intervalId = setInterval(sendPing, 30000);
    return () => clearInterval(intervalId);
  }, []);

  // Stati per form, commesse, impostazioni, ecc.
  const [cliente, setCliente] = useState('');
  const [brand, setBrand] = useState('');
  const [nomeProdotto, setNomeProdotto] = useState('');
  const [quantita, setQuantita] = useState('');
  const [codiceProgetto, setCodiceProgetto] = useState('');
  const [codiceCommessa, setCodiceCommessa] = useState('');
  const [dataConsegna, setDataConsegna] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cartellaDaClonare, setCartellaDaClonare] = useState('');
  const [percorsoCartella, setPercorsoCartella] = useState('');
  const [emailDestinatariApertura, setEmailDestinatariApertura] = useState("");
  const [emailDestinatariLavorazione, setEmailDestinatariLavorazione] = useState("");
  const [reportDdtPath, setReportDdtPath] = useState("");
  const [commesse, setCommesse] = useState([]);
  const [commessaSelezionata, setCommessaSelezionata] = useState(null);
  const [duplicaDa, setDuplicaDa] = useState(null);
  const [originalNome, setOriginalNome] = useState("");
  const [modificaOpen, setModificaOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCriteria, setSortCriteria] = useState('dataConsegna');
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedCommessaForCalendar, setSelectedCommessaForCalendar] = useState(null);
  const [modalCalendarOpen, setModalCalendarOpen] = useState(false);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(null);
  const [selectedDeliveries, setSelectedDeliveries] = useState([]);
  const [loggedUsers, setLoggedUsers] = useState([]);
  const [emailOggetto, setEmailOggetto] = useState("");
  const [emailContenuto, setEmailContenuto] = useState("");
  const socketRef = useRef(null);
const [masterBolleUscita, setMasterBolleUscita] = useState("");
const [masterBolleEntrata, setMasterBolleEntrata] = useState("");

// === URL WS con fallback multipli ===
const rawEnv = (import.meta?.env?.VITE_WS_URL || '192.168.1.250:3001').trim();
const pageIsHttps = (typeof window !== 'undefined' && window.location.protocol === 'https:');
const defaultProto = pageIsHttps ? 'wss' : 'ws';

// base senza trailing slash
let baseWs = rawEnv.match(/^wss?:\/\//i) ? rawEnv : `${defaultProto}://${rawEnv}`;
if (baseWs.endsWith('/')) baseWs = baseWs.slice(0, -1);

// opzionale: consenti un path da env (es: VITE_WS_PATH=/ws)
const wsPath = (import.meta?.env?.VITE_WS_PATH || '').trim().replace(/^\/*/, ''); // rimuove "/" iniziali

// endpoint candidati (deduplicati), tutti con trailing "/"
// Prova PRIMA /ws/, poi /socket/, infine la root "/"
const candidates = [
  `${baseWs}/ws/`,
  `${baseWs}/socket/`,
  `${baseWs}/${wsPath || ''}`.replace(/\/+$/, '') + '/',
  `${baseWs}/`,
].filter((u, i, arr) => u && arr.indexOf(u) === i);

// solo per far scattare l'useEffect se cambia la base (valore qualsiasi)
const wsUrl = candidates.join('|'); 
// console.log('[WS] candidates:', candidates);

// Aggiorna automaticamente il nome in base ai campi
useEffect(() => {
  if (modificaOpen) {
    const p = (String(codiceProgetto || '').trim())
      ? 'P' + String(codiceProgetto).trim().replace(/^[Pp]/, '')
      : '';
    const c = (String(codiceCommessa || '').trim()).toUpperCase().startsWith('C')
      ? String(codiceCommessa).toUpperCase()
      : (String(codiceCommessa || '').trim() ? 'C' + String(codiceCommessa).trim().toUpperCase() : '');

    const newNome = `${brand}_${nomeProdotto}_${p}_${c}`;
    setCommessaSelezionata(prev => (prev ? { ...prev, nome: newNome } : null));
  }
}, [brand, nomeProdotto, codiceProgetto, codiceCommessa, modificaOpen]);

  // Recupero degli utenti loggati
  useEffect(() => {
    const fetchLoggedUsers = () => {
      fetch("http://192.168.1.250:3001/api/loggedUsers")
        .then(res => {
          if (!res.ok) throw new Error("Errore nel recupero degli utenti");
          return res.json();
        })
        .then(data => setLoggedUsers(data))
        .catch(err => console.error("Errore nel recupero degli utenti loggati:", err));
    };

    fetchLoggedUsers();
    const intervalId = setInterval(fetchLoggedUsers, 30000);
    return () => clearInterval(intervalId);
    }, []);

// [RIMOSSO] Duplicata la connessione WS per activeUsers.
// Ora la gestione di 'activeUsers' avviene nella sola connessione WebSocket sottostante.

  const handleOpenSelectedCalendar = (commessa) => {

    console.log("handleOpenSelectedCalendar called for:", commessa);
    setSelectedCommessaForCalendar(commessa);
    // Imposta null per aprire il calendario senza data selezionata
    setSelectedCalendarDate(null);
    setModalCalendarOpen(true);
  };

const handleCloseCommessa = async (commessa) => {
  if (!commessa?.percorso) {
    alert("Percorso cartella non disponibile.");
    return;
  }
  if (!window.confirm("Sei sicuro di voler archiviare la commessa?")) return;

  try {
    const resp = await fetch('http://192.168.1.250:3001/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderPath: commessa.percorso,
        reportData: { archiviata: true }
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert("Errore nell'aggiornamento del report: " + (err.message || resp.statusText));
      return;
    }
    // riflette subito nel client
    setCommesse(prev => prev.map(c => c.nome === commessa.nome ? { ...c, archiviata: true } : c));
    alert("Commessa archiviata!");
  } catch (e) {
    console.error("Errore durante l'archiviazione:", e);
    alert("Errore di connessione al server.");
  }
};




  const handleSelectedCalendarClickDay = (date) => {
    console.log("Data selezionata:", date);
    setSelectedCalendarDate(date);
  };

  useEffect(() => {
    if (percorsoCartella && cartellaDaClonare) {
      fetchCommesse(percorsoCartella, cartellaDaClonare);
    }
  }, [percorsoCartella, cartellaDaClonare]);

  const handleGenerateReport = () => {
    if (!commesse || commesse.length === 0) {
      alert("Nessuna commessa da esportare.");
      return;
    }
    const worksheet = XLSX.utils.json_to_sheet(commesse);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Commesse");
    XLSX.writeFile(workbook, "report_commesse.xlsx");
  };

  useEffect(() => {
    if (commessaSelezionata) {
      console.log("Apertura finestra modifica per:", commessaSelezionata);
      setModificaOpen(true);
    }
  }, [commessaSelezionata]);

  // Caricamento impostazioni
  useEffect(() => {
    fetch("http://192.168.1.250:3001/api/leggi-impostazioni")
      .then(res => {
        if (!res.ok) {
          return { settings: { percorsoCartella: "", cartellaDaClonare: "", emailDestinatariInizio: "", emailDestinatariFine: "" } };
        }
        return res.json();
      })
      .then(data => {
        if (data.settings) {
          setPercorsoCartella(data.settings.percorsoCartella || "");
          setCartellaDaClonare(data.settings.cartellaDaClonare || "");
          setEmailDestinatariApertura(data.settings.emailDestinatariApertura || "");
          setEmailDestinatariLavorazione(data.settings.emailDestinatariLavorazione || "");
          setEmailOggetto(data.settings.emailOggetto || "");
          setEmailContenuto(data.settings.emailContenuto || "");
setMasterBolleUscita(data.settings.masterBolleUscita || "");
    setMasterBolleEntrata(data.settings.masterBolleEntrata || "");
setReportDdtPath(data.settings.reportDdtPath || "");
        }
      })
      .catch(err => console.error("Errore leggendo le impostazioni dal server:", err));
    }, []);

  // mantieni sempre aggiornati i due percorsi usati nel fallback
  const latestPercorsoRef = useRef(percorsoCartella);
  const latestCloneRef    = useRef(cartellaDaClonare);
  useEffect(() => { latestPercorsoRef.current = percorsoCartella; }, [percorsoCartella]);
  useEffect(() => { latestCloneRef.current = cartellaDaClonare; }, [cartellaDaClonare]);

  useEffect(() => {
  // usa SEMPRE socketRef.current come singola sorgente di verità
  let reconnectAttempts = 0;
  let reconnectTimer;
  let firstPayloadTimer;
  let receivedFirstPayload = false;
  const MAX_DELAY = 30000;

  const isValidCommessa = (obj) =>
    obj && typeof obj === 'object' && typeof obj.nome === 'string' && obj.nome.trim().length > 0;

  const connect = () => {
    let tried = 0;

    const tryNext = () => {
      if (tried >= candidates.length) {
        const p = latestPercorsoRef.current;
        const c = latestCloneRef.current;
        if (p && c) fetchCommesse(p, c);
        const delay = Math.min(3000 * Math.pow(2, reconnectAttempts++), MAX_DELAY);
        console.warn(`[WS] nessun endpoint valido. Retry in ${Math.round(delay/1000)}s…`);
        reconnectTimer = setTimeout(connect, delay);
        return;
      }

      const url = candidates[tried++];
      try {
        const s = new WebSocket(url);
        socketRef.current = s;

        clearTimeout(firstPayloadTimer);
        receivedFirstPayload = false;
        firstPayloadTimer = setTimeout(() => {
          if (!receivedFirstPayload) {
            const p = latestPercorsoRef.current;
            const c = latestCloneRef.current;
            if (p && c) fetchCommesse(p, c);
          }
        }, 5000);

        s.onopen = () => {
          reconnectAttempts = 0;
          try {
            const cur = localStorage.getItem("currentUser");
            const email = cur ? JSON.parse(cur)?.email : null;
            if (email) s.send(JSON.stringify({ type: 'auth', email }));
          } catch {}
          s.__keepalive = setInterval(() => {
            if (s.readyState === 1) {
              try { s.send(JSON.stringify({ type: 'ping' })); } catch {}
            }
          }, 25000);
        };

        s.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (Array.isArray(data)) {
              receivedFirstPayload = true;
              clearTimeout(firstPayloadTimer);
              setCommesse(data.filter(isValidCommessa));
              return;
            }
            if (data && typeof data === 'object') {
              if (data.type === 'activeUsers') {
                setLoggedUsers(Array.isArray(data.data) ? data.data : []);
                return;
              }
              if (data.type === 'commesseUpdate') {
                receivedFirstPayload = true;
                clearTimeout(firstPayloadTimer);
                const arr = Array.isArray(data.payload) ? data.payload : [];
                setCommesse(arr.filter(isValidCommessa));
                return;
              }
            }
          } catch (e) {
            console.error("WS parse error:", e);
          }
        };

        s.onerror = () => {
          try { clearInterval(s.__keepalive); } catch {}
          try { s.close(); } catch {}
          tryNext();  // prova subito il prossimo endpoint
        };

        s.onclose = (ev) => {
          clearTimeout(firstPayloadTimer);
          try { clearInterval(s.__keepalive); } catch {}

          // se si è chiuso “subito”, prova il prossimo endpoint
          if (tried < candidates.length) {
            tryNext();
            return;
          }
          const delay = Math.min(3000 * Math.pow(2, reconnectAttempts++), MAX_DELAY);
          console.warn(`[WS] chiuso (code=${ev.code}). Retry in ${Math.round(delay/1000)}s…`);
          reconnectTimer = setTimeout(connect, delay);
        };
      } catch (e) {
        console.error("Errore inizializzazione WebSocket su", url, e);
        tryNext();
      }
    };

    tryNext();
  };



    connect();

      return () => {
    clearTimeout(firstPayloadTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const s = socketRef.current;
    if (s) {
      s.onclose = null;          // evita retry sullo smontaggio
      try { clearInterval(s.__keepalive); } catch {}
      try { s.close(); } catch {}
    }
  };
}, [wsUrl]);


  useEffect(() => {


    if (selectedDate) {
      const filtered = commesse.filter(c => c.dataConsegna === selectedDate);
      setSelectedDeliveries(filtered);
    }
  }, [commesse, selectedDate]);

  const filteredCommesse = useMemo(() => {
    let result = commesse.filter(c => {
      if (!c || !c.nome) return false;
      const query = searchQuery.toLowerCase();
      return (
        c.nome.toLowerCase().includes(query) ||
        (c.cliente && c.cliente.toLowerCase().includes(query)) ||
        (c.brand && c.brand.toLowerCase().includes(query)) ||
        (c.codiceProgetto && c.codiceProgetto.toLowerCase().includes(query)) ||
        (c.codiceCommessa && c.codiceCommessa.toLowerCase().includes(query))
      );
    });
    if (sortCriteria) {
      result = result.slice().sort((a, b) => {
        if (sortCriteria === 'dataConsegna') {
          return new Date(a.dataConsegna).getTime() - new Date(b.dataConsegna).getTime();
        } else if (sortCriteria === 'brand') {
          return (a.brand || "").localeCompare(b.brand || "");
        }
        return 0;
      });
    }
    return result;
  }, [commesse, searchQuery, sortCriteria]);

const deliveriesByDate = commesse.reduce((acc, commessa) => {
  if (commessa.dataConsegna && !commessa.archiviata) {
    const parsedDate = parseDateFromString(commessa.dataConsegna);
    const formattedDate = formatLocalDate(parsedDate);
    if (!acc[formattedDate]) acc[formattedDate] = [];
    acc[formattedDate].push(commessa); // pusha l’intera commessa non archiviata
  }
  return acc;
}, {});

  console.log("Commesse state:", commesse);
  console.log("DeliveriesByDate:", deliveriesByDate);

  const fetchCommesse = async (cartellaPath, cartellaDaClonata) => {
    if (!cartellaPath || !cartellaDaClonata) return;
    try {
      console.log("Chiamata API per ottenere commesse...");
      const response = await fetch(
        `http://192.168.1.250:3001/api/commesse?percorsoCartella=${encodeURIComponent(cartellaPath)}&cartellaDaClonare=${encodeURIComponent(cartellaDaClonata)}`
      );
      if (response.ok) {
        const data = await response.json();
        console.log("Dati ricevuti dal server:", data);
        if (Array.isArray(data.commesse) && data.commesse.length > 0) {
          setCommesse(data.commesse.map(c => ({
  cliente: c.cliente,
  brand: c.brand,
  nomeProdotto: c.nomeProdotto || c.nome,
  quantita: c.quantita,
  codiceProgetto: c.codiceProgetto,
  codiceCommessa: c.codiceCommessa,
  dataConsegna: c.dataConsegna,
  inizioProduzione: c.inizioProduzione,
fineProduzioneEffettiva: c.fineProduzioneEffettiva || null,
  percorso: c.percorso,
  presente: c.presente,
  archiviata: c.archiviata, // aggiunto
  nome: c.nome
})));


        } else {
          setCommesse([]);
        }
      } else {
        console.error("Errore nel recupero delle commesse.");
      }
    } catch (error) {
      console.error("Errore di connessione:", error);
    }
  };

  const handleSelectCommessa = async (commessaNome) => {
    if (!percorsoCartella) {
      console.log("Errore: percorsoCartella non è impostato!");
      return;
    }
    try {
      console.log(`Recupero dettagli per la commessa: ${commessaNome}`);
      const response = await fetch(
        `http://192.168.1.250:3001/api/commessa-dettagli?percorsoCartella=${encodeURIComponent(percorsoCartella)}&commessaNome=${encodeURIComponent(commessaNome)}`
      );
      if (response.ok) {
        const commessa = await response.json();
        console.log("Dettagli ricevuti:", commessa);
        setCliente(commessa.cliente ?? "");
        setBrand(commessa.brand || "");
        setNomeProdotto((commessa.nomeProdotto || "").toLowerCase().replace(/[^a-z0-9 ]/g, ""));

        setQuantita(commessa.quantita ?? "");
        setCodiceProgetto(String(commessa.codiceProgetto || "").replace(/^[Pp]/, '').replace(/\D+/g, ''));

        setCodiceCommessa(commessa.codiceCommessa || "");
        setDataConsegna(commessa.dataConsegna || "");
      } else {
        console.error("Errore nel recupero dei dettagli della commessa.");
      }
    } catch (error) {
      console.error("Errore di connessione:", error);
    }
  };

  const handleEditCommessa = async (commessa) => {
  if (!commessa || !commessa.nome) {
    console.log("Errore: Nome della commessa non disponibile!");
    return;
  }
  console.log("Commessa selezionata:", commessa);
  setOriginalNome(commessa.nome); // Salva il nome originale
  setCommessaSelezionata(commessa);

  // 🔹 Attendi il caricamento dei dettagli
  await handleSelectCommessa(commessa.nome);

  // 🔹 Solo dopo apri il dialog
  setModificaOpen(true);
};


  const handleOpenSettings = () => {
    setModificaOpen(false);
    setSettingsOpen(true);
  };

  // Salva le impostazioni
  const handleSaveSettings = () => {
    console.log("Salvataggio impostazioni:", { percorsoCartella, cartellaDaClonare, emailDestinatariApertura, emailDestinatariLavorazione });
    fetch("http://192.168.1.250:3001/api/save-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        percorsoCartella,
        cartellaDaClonare,
        emailDestinatariApertura,
        emailDestinatariLavorazione,
        emailOggetto,
        emailContenuto,
        masterBolleUscita,
        masterBolleEntrata,
        reportDdtPath
      })
    })
      .then(res => {
        if (!res.ok) throw new Error("Errore nel salvataggio delle impostazioni");
        return res.json();
      })
      .then(data => {
        console.log("Impostazioni salvate:", data.message);
        alert("Impostazioni salvate con successo.");
        fetchCommesse(percorsoCartella, cartellaDaClonare);
        setSettingsOpen(false);
      })
      .catch(err => {
        console.error("Errore salvando le impostazioni:", err);
        alert("Errore salvando le impostazioni: " + err);
      });
  };

  // [GIALLA - riga precedente] ---------------------------------------------------
const handleDuplicateClick = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.directory = true;
  input.webkitdirectory = true;
  input.style.display = "none";
  document.body.appendChild(input);

  input.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const folderName = files[0].webkitRelativePath.split("/")[0];
    const folderPath = `${percorsoCartella.replace(/[\\/]+$/,'')}\\${folderName}`;
    setDuplicaDa(folderName);

    // 1) Parser robusto direttamente dal nome: BRAND_PRODOTTO_Pxxx_Cyyy
    const m = folderName.match(/^([^_]+)_([^_]+)_(P[^_]+)_(C[^_]+)$/i);
    if (m) {
  setBrand(m[1]);
  setNomeProdotto(m[2].toLowerCase().replace(/[^a-z0-9 ]/g, ""));

  setCodiceProgetto(m[3].replace(/^[Pp]/, '').replace(/\D+/g, '')); // solo numeri
  setCodiceCommessa(m[4].toUpperCase());
} else {
  const parts = folderName.split('_');
  setBrand(parts[0] || '');
  setNomeProdotto((parts[1] || '').toLowerCase().replace(/[^a-z0-9 ]/g, ""));

  setCodiceProgetto(String(parts[2] || '').replace(/^[Pp]/, '').replace(/\D+/g, '')); // solo numeri
  setCodiceCommessa((parts[3] || '').toUpperCase());
}


    try {
      // 2) Dettagli da commesse.json (se esistono)
      const detRes = await fetch(
        `http://192.168.1.250:3001/api/commessa-dettagli?percorsoCartella=${encodeURIComponent(percorsoCartella)}&commessaNome=${encodeURIComponent(folderName)}`
      );
      if (detRes.ok) {
        const commessa = await detRes.json();
        setCliente(prev => prev || commessa.cliente || ""); // non sovrascrivo se già impostato
        setBrand(prev => prev || commessa.brand || "");
        setNomeProdotto(prev => prev || (commessa.nomeProdotto || "").toLowerCase().replace(/[^a-z0-9 ]/g, ""));

        setCodiceProgetto(prev => prev || String(commessa.codiceProgetto || "").replace(/^[Pp]/, '').replace(/\D+/g, ''));

        setCodiceCommessa(prev => prev || commessa.codiceCommessa || "");
        setDataConsegna("");  // lasciamo vuoto per nuova pianificazione
        setQuantita("");
      }

      // 3) Cliente dal report.json della sorgente (fallback affidabile)
      try {
        const repRes = await fetch(
          `http://192.168.1.250:3001/api/report?folderPath=${encodeURIComponent(folderPath)}`
        );
        if (repRes.ok) {
          const { report } = await repRes.json();
          if (report && report.cliente) {
            setCliente(c => c || String(report.cliente));
          }
        }
      } catch {}

    } catch (err) {
      console.error("Errore selezionando la cartella:", err);
      alert("Errore selezionando la cartella: " + err);
    }
  });

  input.click();
  document.body.removeChild(input);
};
// [GIALLA - riga successiva] ---------------------------------------------------


const resetForm = () => {
  setCliente('');
  setBrand('');
  setNomeProdotto('');
  setQuantita('');
  setCodiceProgetto('');
  setCodiceCommessa('');
  setDataConsegna('');
  setDuplicaDa(null); // <-- azzera eventuale duplicazione precedente
};
 
const handleDayClick = (date) => {
  const formattedDate = formatISODate(date);
  console.log("Giorno cliccato:", formattedDate);
  setSelectedDate(formattedDate);
  const filteredDeliveries = commesse.filter(c => c.dataConsegna === formattedDate);
  setSelectedDeliveries(filteredDeliveries);
};

const handleSubmit = async (e) => {
  e.preventDefault();

  // Validazione campi obbligatori front-end
  if (!isFormValid({ cliente, brand, nomeProdotto, codiceProgetto, codiceCommessa })) {

    alert("Compila Cliente, Brand, Nome Prodotto e almeno uno tra Codice Progetto o Codice Commessa.");
    return;
  }

  // 1) Impostazioni minime per poter creare/duplicare
  if (!percorsoCartella || !cartellaDaClonare) {
    alert("Configura 'Percorso di salvataggio' e 'Cartella da Clonare' nelle Impostazioni.");
    setSettingsOpen(true);
    return;
  }
  // 2) Normalizzazione robusta dei codici: aggiungi P/C solo se c'è testo
  const normP = codiceProgetto && codiceProgetto.trim().length > 0
    ? (codiceProgetto.trim().toUpperCase().startsWith("P")
        ? codiceProgetto.trim().toUpperCase()
        : "P" + codiceProgetto.trim().toUpperCase())
    : "";
  const normC = codiceCommessa && codiceCommessa.trim().length > 0
    ? (codiceCommessa.trim().toUpperCase().startsWith("C")
        ? codiceCommessa.trim().toUpperCase()
        : "C" + codiceCommessa.trim().toUpperCase())
    : "";

  // 3) Base payload (senza duplicaDa)
  const baseData = {
    cliente,
    brand,
    nomeProdotto,
    quantita,
    codiceProgetto: normP,
    codiceCommessa: normC,
    dataConsegna,
    percorsoCartella,
    cartellaDaClonare,
    sovrascrivere: false,
  };

  // 4) Invia SEMPRE duplicaDa se presente; la validazione la fa il server
const dup = (typeof duplicaDa === "string" ? duplicaDa.trim() : "");
const requestData = dup ? { ...baseData, duplicaDa: dup } : baseData;


console.log("Request Data:", requestData);

  try {
    let response = await fetch('http://192.168.1.250:3001/api/genera-commessa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData),
    });

    if (response.status === 409) {
      const targetName = `${brand}_${nomeProdotto}_${normP || 'P?'}_${normC || 'C?'}`;
      const confirmOverwrite = window.confirm(
        `La cartella ${requestData.percorsoCartella}/${targetName} esiste già. Vuoi sovrascriverla?`
      );
      if (confirmOverwrite) {
        const retryData = { ...requestData, sovrascrivere: true };
        response = await fetch('http://192.168.1.250:3001/api/genera-commessa', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(retryData),
        });
        if (response.ok) {
          alert("Cartella sovrascritta con successo!");
          fetchCommesse(percorsoCartella, cartellaDaClonare);
          handleEmailConfirmation();
        } else {
          const errTxt = await response.text().catch(() => "");
          alert("Errore nella sovrascrittura della cartella." + (errTxt ? `\n${errTxt}` : ""));
        }
      }
    } else if (response.status === 400) {
      // Mostra sempre il messaggio specifico che arriva dal backend
      let msg = "Richiesta non valida (400).";
      try {
        const errData = await response.json();
        if (errData && errData.message) msg = errData.message;
      } catch {}
      alert(msg);
    } else if (response.ok) {
      alert("Cartella creata con successo!");
      fetchCommesse(percorsoCartella, cartellaDaClonare);
      handleEmailConfirmation();
      resetForm();
    } else {
      const errTxt = await response.text().catch(() => "");
      alert("Errore nella creazione della cartella." + (errTxt ? `\n${errTxt}` : ""));
    }
  } catch (error) {
    console.error("Errore durante la richiesta:", error);
    alert("Errore di connessione al server.");
  }
};
const handleSaveEditCommessa = async () => {
  if (!commessaSelezionata || !commessaSelezionata.nome) {
    alert("Errore: nessuna commessa selezionata.");
    return;
  }
  if (quantita !== "" && (isNaN(quantita) || Number(quantita) <= 0)) {
    alert("Errore: la quantità, se compilata, deve essere un numero positivo.");
    return;
  }
  
  const normalizedCodiceProgetto = String(codiceProgetto || '')
  .replace(/^[Pp]/, '')            // tieni solo le cifre inserite
  .replace(/\D+/g, '');
const normalizedCodiceCommessa = String(codiceCommessa || '').toUpperCase();

const updatedData = {
  nome: commessaSelezionata.nome,
  cliente: cliente || commessaSelezionata.cliente,
  brand: brand || commessaSelezionata.brand,
  nomeProdotto: nomeProdotto || commessaSelezionata.nomeProdotto,
  quantita: quantita,
  // INVIA SEMPRE normalizzato con P/C
  codiceProgetto: normalizedCodiceProgetto ? ('P' + normalizedCodiceProgetto) : (commessaSelezionata.codiceProgetto || ''),
  codiceCommessa: normalizedCodiceCommessa
    ? (normalizedCodiceCommessa.startsWith('C') ? normalizedCodiceCommessa : 'C' + normalizedCodiceCommessa)
    : (commessaSelezionata.codiceCommessa || ''),
  dataConsegna: dataConsegna || commessaSelezionata.dataConsegna,
};

  
  try {
    const response = await fetch('http://192.168.1.250:3001/api/modifica-commessa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cartellaDaClonare,
        nomeOriginale: originalNome,
        nuovaCommessa: updatedData,
        percorsoCartella
      }),
    });
    if (!response.ok) {
      const errorData = await response.json();
      alert(`Errore nell'aggiornamento della commessa: ${errorData.message}`);
      console.error("Errore server:", errorData);
      return;
    }
    // Destruttura la risposta usando il nome restituito (ad es. "commessa")
    const { commessa } = await response.json();
    alert("Commessa aggiornata con successo!");
    resetForm();
    setCommessaSelezionata(null);
    setModificaOpen(false);
    // Se vuoi semplicemente un refresh della stessa pagina, puoi aggiornare lo stato oppure chiamare fetchCommesse per aggiornare l'elenco
    fetchCommesse(percorsoCartella, cartellaDaClonare);
  } catch (error) {
    console.error("Errore durante l'aggiornamento:", error);
    alert("Errore di connessione al server.");
  }
};

const archiviaCommessa = async (commessa) => {
  if (!window.confirm("Archiviare questa commessa?")) return;
  try {
    await fetch('http://192.168.1.250:3001/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderPath: commessa.percorso,
        reportData: { archiviata: true }
      })
    });
    // Aggiorna in memoria lo stato archiviata
    setCommesse(prev =>
      prev.map(c =>
        c.nome === commessa.nome ? { ...c, archiviata: true } : c
      )
    );
    alert("Commessa archiviata!");
  } catch (err) {
    console.error("Errore archiviazione:", err);
    alert("Errore nell'archiviazione della commessa.");
  }
};

  const handleDeleteCommessa = async () => {
    if (!commessaSelezionata || !commessaSelezionata.nome) {
      alert("Errore: nessuna commessa selezionata.");
      return;
    }
    const confirmDelete = window.confirm(`Sei sicuro di voler cancellare la commessa ${commessaSelezionata.nome}? Questa operazione eliminerà anche la cartella creata.`);
    if (!confirmDelete) return;
    try {
      const url = `http://192.168.1.250:3001/api/cancella-commessa/${encodeURIComponent(percorsoCartella)}/${encodeURIComponent(commessaSelezionata.nome)}`;
      const response = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        alert("Commessa cancellata con successo!");
        setCommesse(prevCommesse => prevCommesse.filter(c => c.nome !== commessaSelezionata.nome));
        resetForm();
        setCommessaSelezionata(null);
        setModificaOpen(false);
      } else {
        const errorData = await response.json();
        alert(`Errore nella cancellazione: ${errorData.message}`);
      }
    } catch (error) {
      console.error("Errore durante la cancellazione:", error);
      alert("Errore di connessione al server durante la cancellazione.");
    }
  };

  const handleEmailConfirmation = () => {
    const confirmEmail = window.confirm("Vuoi inviare un'email di notifica?");
    if (confirmEmail) {
      const pCode = codiceProgetto.startsWith("P") ? codiceProgetto : "P" + codiceProgetto;
      const cCode = codiceCommessa.startsWith("C") ? codiceCommessa : "C" + codiceCommessa;
      const oggettoEmail = `Ho aperto una nuova cartella ${brand}_${nomeProdotto}_${pCode}_${cCode}`;
      const linkCartella = `"\\\\192.168.1.248\\time dati\\ARCHIVIO TECNICO\\ARCHIVIO\\2025\\COMMESSE\\${brand}_${nomeProdotto}_${pCode}_${cCode}"`;
      const corpoEmail = `
Cliente: ${cliente}
Brand: ${brand}
Nome Prodotto: ${nomeProdotto}
Quantità: ${quantita}
Data Consegna: ${dataConsegna}
--------------------------------------
${linkCartella}
      `;
      const mailtoURL = `mailto:${emailDestinatariApertura}?subject=${encodeURIComponent(oggettoEmail)}&body=${encodeURIComponent(corpoEmail)}`;
      window.location.href = mailtoURL;
    }
  };

  return (
    <>
      {/* Contenitore esterno con altezza minima definita */}
      <div className="relative bg-[#28282B] min-h-screen pt-0 pr-4 pb-4 pl-4">

        <CommesseGenerateSlide 
          commesse={commesse}
          archiviaCommessa={archiviaCommessa}
          filteredCommesse={filteredCommesse}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          sortCriteria={sortCriteria}
          setSortCriteria={setSortCriteria}
          handleEditCommessa={handleEditCommessa}
          onSelectDate={(date) => setSelectedDate(date)}
          onOpenCalendar={handleOpenSelectedCalendar}
        />
    <CalendarSlide
  commesse={commesse}
  onClickDay={handleDayClick}
  selectedDate={selectedDate}
  onCommessaClick={(commessa) => {
    setSelectedCommessaForCalendar(commessa);
    setSelectedCalendarDate(commessa.dataConsegna || null);
    setModalCalendarOpen(true);
  }}
/>
        {/* Qui posizioniamo il contenitore centrale in modo assoluto in alto */}
        <div className="absolute top-0 left-[26%] right-[26%]">
          <div className="flex flex-col items-center justify-start bg-[#28282B] pt-4 px-4 pb-4">
            {/* Blocco logo */}
            <div className="mb-8">
              <img src="/Logo Arca.png" alt="Logo Arca" className="w-32" />
              <div className="flex flex-col items-start bg-[#28282B] p-4">
                {/* Blocco logo, pallini e form */}
              </div>
            </div>
            {/* Blocchi per i pallini degli utenti loggati */}
            {loggedUsers.length > 0 && (
              <div className="flex justify-center mt-4 mb-8 space-x-2">
                {loggedUsers.map((user, index) => {
                  const initials = user.email.slice(0, 2).toUpperCase();
                  const bgColor = getUserColor(user.email);
                  return (
                    <div
                      key={index}
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold"
                      style={{ backgroundColor: bgColor }}
                      title={user.email}
                    >
                      {initials}
                    </div>
                  );
                })}
              </div>
            )}
            {!commessaSelezionata && (
              <Card className="w-full max-w-xl shadow-xl" style={{ backgroundColor: 'transparent' }}>
  <CardContent style={{ backgroundColor: 'transparent' }}>
                  <div className="flex justify-between items-center mb-4">
                    <h1 className="text-2xl font-bold text-white">Genera Nuove Commesse</h1>
                    <div className="flex gap-2">
  {/* Bottone Home: quando cliccato, chiama onHome */}
  <button
    onClick={() => onHome && onHome()}
    className="p-2 text-gray-700 hover:text-black"
    title="Home"
  >
    <Home size={24} />
  </button>
                      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                        <DialogTrigger asChild>
                          <button className="p-2 text-gray-700 hover:text-black" title="Impostazioni">
                            <Settings size={24} />
                          </button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-lg bg-white shadow-lg rounded-lg" aria-describedby="dialog-description">
                          <DialogHeader>
                            <DialogTitle>Impostazioni</DialogTitle>
                          </DialogHeader>
                          <p id="dialog-description" className="text-gray-600">Configura i percorsi e i destinatari per le notifiche</p>
                          <div className="grid gap-4 py-4">
                            <div>
                              <label className="block mb-1 font-semibold" htmlFor="percorsoCartella">Percorso di salvataggio</label>
                              <Input id="percorsoCartella" type="text" value={percorsoCartella} onChange={(e) => setPercorsoCartella(e.target.value)} />
                            </div>
                            <div>
                              <label className="block mb-1 font-semibold" htmlFor="cartellaDaClonare">Cartella da Clonare</label>
                              <Input id="cartellaDaClonare" type="text" value={cartellaDaClonare} onChange={(e) => setCartellaDaClonare(e.target.value)} />
                            </div>
                            <div>
                              <label className="block mb-1 font-semibold" htmlFor="emailDestinatariApertura">
                                Destinatari E-mail Apertura Cartella
                              </label>
                              <Input
                                id="emailDestinatariApertura"
                                type="text"
                                value={emailDestinatariApertura}
                                onChange={(e) => setEmailDestinatariApertura(e.target.value)}
                              />
                            </div>
                            <div>
                              <label className="block mb-1 font-semibold" htmlFor="emailDestinatariLavorazione">
                                Destinatari E-mail Inizio/Fine Lavorazione / Consegne
                              </label>
                              <Input
                                id="emailDestinatariLavorazione"
                                type="text"
                                value={emailDestinatariLavorazione}
                                onChange={(e) => setEmailDestinatariLavorazione(e.target.value)}
                              />
                            </div>
     <div>
      <label className="block mb-1 font-semibold" htmlFor="masterBolleUscita">
        Scegli file Bolle in Uscita
      </label>
      <Input
        id="masterBolleUscita"
        type="text"
        placeholder="Percorso file Bolle in Uscita (es: \\\\server\\cartella\\bolleUscita.xlsx)"
        value={masterBolleUscita}
        onChange={e => setMasterBolleUscita(e.target.value)}
      />
    </div>
    <div>
      <label className="block mb-1 font-semibold" htmlFor="masterBolleEntrata">
        Scegli file Bolle in Entrata
      </label>
      <Input
        id="masterBolleEntrata"
        type="text"
        placeholder="Percorso file Bolle in Entrata (es: \\\\server\\cartella\\bolleEntrata.xlsx)"
        value={masterBolleEntrata}
        onChange={e => setMasterBolleEntrata(e.target.value)}
      />
    </div>

<div>
  <label className="block mb-1 font-semibold" htmlFor="reportDdtPath">
    Percorso salvataggio Report DDT
  </label>
  <Input
    id="reportDdtPath"
    type="text"
    placeholder="Percorso dove salvare il report DDT (es: \\\\server\\cartella\\REPORT_DDT)"
    value={reportDdtPath}
    onChange={e => setReportDdtPath(e.target.value)}
  />
</div>


                          </div>
                          <DialogFooter>
                            <Button type="button" onClick={handleSaveSettings}>Salva</Button>
                            <Button type="button" onClick={() => setSettingsOpen(false)}>Chiudi</Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                      <button onClick={() => { if (window.confirm("Sei sicuro di voler effettuare il logout?")) { onLogout && onLogout(); } }} className="p-2 text-gray-700 hover:text-black" title="Logout">
                        <LogOut size={24} />
                      </button>
                    </div>
                  </div>
                  <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4">
  <Button type="button" onClick={handleDuplicateClick} className="bg-blue-500 text-white">
    Duplica da commessa
  </Button>
    <div>
    <label className="block mb-1 font-semibold text-white" htmlFor="cliente">Cliente</label>
    <input
      id="cliente"
      type="text"
      className="w-full rounded border px-2 py-1"
      value={cliente}
      onChange={(e) => setCliente(sanitizeAlnum(e.target.value, { upper: true }))}
    />
  </div>

    <div>
    <label className="block mb-1 font-semibold text-blue-500" htmlFor="brand">Brand</label>
    <input
      id="brand"
      type="text"
      className="w-full rounded border px-2 py-1"
      value={brand}
      onChange={(e) => setBrand(sanitizeAlnum(e.target.value, { upper: true }))}
    />
  </div>

    <div>
    <label className="block mb-1 font-semibold text-blue-500" htmlFor="nomeProdotto">Nome Prodotto</label>
    <input
  id="nomeProdotto"
  type="text"
  className="w-full rounded border px-2 py-1"
  value={nomeProdotto}
  onChange={(e) =>
  setNomeProdotto(
    e.target.value.toLowerCase().replace(/[^a-z0-9 ]/g, "")
  )
}

  required
/>

  </div>

    <div>
    <label className="block mb-1 font-semibold text-green-500" htmlFor="codiceProgetto">Codice Progetto</label>
    <input
      id="codiceProgetto"
      type="text"
      className="w-full rounded border px-2 py-1 bg-white"
      value={codiceProgetto}
      onChange={(e) => setCodiceProgetto(sanitizeDigits(e.target.value))}
      inputMode="numeric"
      pattern="[0-9]*"
    />
  </div>

  <div>
    <label className="block mb-1 font-semibold text-green-500" htmlFor="codiceCommessa">Codice Commessa</label>
    <input id="codiceCommessa" type="text" className="w-full rounded border px-2 py-1 bg-white" value={codiceCommessa} onChange={(e) => setCodiceCommessa(e.target.value)} />
  </div>
  <div>
    <label className="block mb-1 font-semibold text-white" htmlFor="dataConsegna">Data Consegna</label>
    <input id="dataConsegna" type="date" className="w-full rounded border px-2 py-1 bg-white" value={dataConsegna} onChange={(e) => { console.log("Data di Consegna selezionata:", e.target.value); setDataConsegna(e.target.value); }} />
  </div>
  <div>
    <label className="block mb-1 font-semibold text-white" htmlFor="quantita">Quantità</label>
    <input id="quantita" type="number" className="w-full rounded border px-2 py-1" value={quantita} onChange={(e) => setQuantita(e.target.value)} />
  </div>
  <Button
  type="submit"
  disabled={!isFormValid({ cliente, brand, nomeProdotto, codiceProgetto, codiceCommessa })}
  className="mt-4 bg-green-500 text-white border border-gray-300 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
>
  Genera Commessa
</Button>


</form>

                </CardContent>
              </Card>
            )}
            {modificaOpen && !settingsOpen && (
              <Dialog
                open={modificaOpen}
                onOpenChange={(open) => {
                  if (!open) {
                    resetForm();
                    setCommessaSelezionata(null);
                  }
                  setModificaOpen(open);
                }}
              >
                <DialogContent className="sm:max-w-lg" aria-describedby="dialog-description">
                  <DialogHeader>
                     <DialogTitle className="text-white">Modifica Commessa</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-4 py-4" >
                    <div>
  <label style={{ color: "white" }} className="block mb-1 font-semibold">Cliente</label>
  <Input
    type="text"
    value={cliente || ""}
    onChange={(e) => setCliente(e.target.value.toUpperCase())}
    className="bg-white rounded border px-2 py-1"
  />
</div>
<div>
  <label style={{ color: "white" }} className="block mb-1 font-semibold">Brand</label>
  <Input
    type="text"
    value={brand || ""}
    onChange={(e) => setBrand(e.target.value.toUpperCase())}
    className="bg-white rounded border px-2 py-1"
  />
</div>
                    <div>
                      <label className="block mb-1 font-semibold text-white">Nome Prodotto</label>
                      <Input
  type="text"
  value={nomeProdotto || ""}
  onChange={(e) =>
  setNomeProdotto(
    e.target.value.toLowerCase().replace(/[^a-z0-9 ]/g, "")
  )
}

  className="bg-white rounded border px-2 py-1"
/>

                    </div>
                    <div>
                      <label style={{ color: "white" }} className="block mb-1 font-semibold">Codice Progetto</label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="text"
                          value={codiceProgetto || ""}
                          onChange={(e) => setCodiceProgetto(sanitizeDigits(e.target.value))}

                          className="bg-white rounded border px-2 py-1 flex-1"
                        />
                        <Button
                          type="button"
                          onClick={handleEmailConfirmation}
                          className="bg-gray-400 hover:bg-gray-500 text-white text-sm px-2 py-1"
                        >
                          Invia Mail
                        </Button>
                      </div>
                    </div>
                    <div>
                      <label style={{ color: "white" }} className="block mb-1 font-semibold">Codice Commessa</label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="text"
                          value={codiceCommessa || ""}
                          onChange={(e) => setCodiceCommessa(e.target.value)}
                          className="bg-white rounded border px-2 py-1 flex-1"
                        />
                        <Button
                          type="button"
                          onClick={handleEmailConfirmation}
                          className="bg-gray-400 hover:bg-gray-500 text-white text-sm px-2 py-1"
                        >
                          Invia Mail
                        </Button>
                      </div>
                    </div>
                    <div>
                      <label style={{ color: "white" }} className="block mb-1 font-semibold">Quantità</label>
                      <Input
  type="number"
  value={quantita ?? ""}
  onChange={(e) => setQuantita(e.target.value)}
  className="bg-white"
/>

                    </div>
                    <div>
                      <label style={{ color: "white" }} className="block mb-1 font-semibold">Data Consegna</label>
                      <Input
                        type="date"
                        value={dataConsegna || ""}
                        onChange={(e) => setDataConsegna(e.target.value)}
                        className="bg-white"
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button type="button" onClick={handleSaveEditCommessa} className="text-white">
                      Salva Modifiche
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        resetForm();
                        setModificaOpen(false);
                        setCommessaSelezionata(null);
                      }}
className="text-white"
                    >
                      Chiudi
                    </Button>
                    <Button type="button" onClick={handleDeleteCommessa} variant="destructive" className="text-white">
                      Cancella Commessa
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>
      </div>
     
     {modalCalendarOpen && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-800 bg-opacity-75">
    <SelectedCalendar
      onClickDay={handleSelectedCalendarClickDay}
      selectedDate={selectedCalendarDate}
      nomeCommessa={selectedCommessaForCalendar ? selectedCommessaForCalendar.nome : ''}
      consegnaDate={selectedCommessaForCalendar?.dataConsegna ? new Date(selectedCommessaForCalendar.dataConsegna) : null}
      lavorazioneStartDate={null}
      folderPath={selectedCommessaForCalendar ? selectedCommessaForCalendar.percorso : ''}
      quantita={selectedCommessaForCalendar ? selectedCommessaForCalendar.quantita : "N.D."}
      archiviata={!!selectedCommessaForCalendar?.archiviata}
      masterBolleEntrata={masterBolleEntrata}
reportDdtPath={reportDdtPath}
      onClose={() => {
        setModalCalendarOpen(false);
        fetchCommesse(percorsoCartella, cartellaDaClonare); // refresh
      }}
    />
  </div>
)}


    </>
  );
}

//  