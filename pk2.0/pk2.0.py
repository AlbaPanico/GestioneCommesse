import tkinter as tk
from tkinter import messagebox
import json
import os

# Ottieni il percorso della directory home dell'utente e definisci il percorso del file di configurazione
directory_home = os.path.expanduser('~')
percorso_file_configurazione = os.path.join(directory_home, 'configurazione.json')

# Carica o inizializza i parametri di configurazione
def carica_parametri():
    try:
        with open(percorso_file_configurazione, 'r') as file:
            return json.load(file)
    except FileNotFoundError:
        return {
            "Volume,estimato per anno mq": 16000,
            "costo_C_litro": 175,
            "costo_M_litro": 175,
            "costo_Y_litro": 175,
            "costo_K_litro": 175,
            "costo_W_litro": 210,
            "consumo_CMYK_mq": 0.006,
            "consumo_W_mq": 0.015,
            "costi_vari_operatore_mq": 0.96,
            "investimento_mq": 1.66,
            "assistenza_ricambi_mq": 0.96,
            "costo_orario_prestampa": 25
        }

# Salva i parametri modificati
def salva_parametri(parametri):
    with open(percorso_file_configurazione, 'w') as file:
        json.dump(parametri, file, indent=4)

# Imposta le dimensioni della finestra come percentuale dello schermo
def imposta_dimensioni_finestra(root, percentuale_larghezza, percentuale_altezza):
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    larghezza = int(screen_width * percentuale_larghezza)
    altezza = int(screen_height * percentuale_altezza)
    x = (screen_width - larghezza) // 2
    y = (screen_height - altezza) // 2
    root.geometry(f'{larghezza}x{altezza}+{x}+{y}')


# Finestra di Setup
def apri_finestra_setup():
    print("Inizio apri_finestra_setup")
    finestra_setup = tk.Toplevel()
    finestra_setup.title("Impostazioni")
    imposta_dimensioni_finestra(finestra_setup, 0.3, 0.5)
    
    finestra_interna = tk.Frame(finestra_setup, bd=10, relief=tk.GROOVE)
    finestra_interna.pack(expand=True, fill=tk.BOTH, padx=20, pady=20)
    
    global parametri
    
    # Crea una copia separata dei parametri da visualizzare e modificare
    parametri_da_modificare = parametri.copy()
    
    inputs = []
    for key, value in parametri_da_modificare.items():
        row = tk.Frame(finestra_interna)
        row.pack(side=tk.TOP, fill=tk.X, padx=5, pady=5)
        tk.Label(row, text=key, width=30, anchor='w').pack(side=tk.LEFT)
        entry = tk.Entry(row, width=10)  # Imposta una larghezza fissa per il campo di input
        entry.insert(0, str(value))
        entry.pack(side=tk.RIGHT)
        inputs.append(entry)
    
    def salva_modifiche():
        for i, key in enumerate(parametri_da_modificare):
            try:
                parametri_da_modificare[key] = float(inputs[i].get())
            except ValueError:
                messagebox.showerror("Errore", "Inserire valori numerici validi per " + key)
                return
        # Aggiorna i parametri globali con i valori modificati
        parametri.update(parametri_da_modificare)
        salva_parametri(parametri)
        messagebox.showinfo("Salvataggio", "Modifiche salvate con successo!")
        finestra_setup.destroy()  # Chiudi la finestra delle impostazioni dopo il salvataggio
    
    # Bottone per salvare le modifiche
    tk.Button(finestra_interna, text="Salva modifiche", command=salva_modifiche).pack(side=tk.BOTTOM)
    
    # Promemoria per il salvataggio prima della chiusura della finestra
    def conferma_chiusura():
        print("Chiamata conferma_chiusura")
        if messagebox.askokcancel("Conferma", "Vuoi chiudere la finestra senza salvare le modifiche?"):
            finestra_setup.destroy()

    finestra_setup.protocol("WM_DELETE_WINDOW", conferma_chiusura)
    print("Fine apri_finestra_setup")

# Esegui calcolo su pressione del bottone, aggiornata per la nuova formula di consumo
def esegui_calcolo():
    try:
        lunghezza_mm = float(lunghezza_var.get())
        larghezza_mm = float(larghezza_var.get())
        quantita = float(quantita_var.get())  # Recupera il valore della quantità inserita
        if lunghezza_mm <= 0 or larghezza_mm <= 0 or quantita <= 0:  # Verifica che anche la quantità sia maggiore di 0
            messagebox.showerror("Errore", "Valori di lunghezza, larghezza e quantità devono essere maggiori di 0.")
            return
        lunghezza_m = lunghezza_mm / 1000
        larghezza_m = larghezza_mm / 1000
        area_mq = lunghezza_m * larghezza_m
        consumo_cmyk = parametri["consumo_CMYK_mq"] * area_mq if stato_bottoni["CMYK"] else 0
        
        # Calcolo del consumo medio di inchiostro W con moltiplicatori specifici
        moltiplicatore_w = 1  # Moltiplicatore di base per inchiostro W
        moltiplicatore_costi = 1  # Moltiplicatore di base per i costi vari, investimento, assistenza
        
        if stato_bottoni["1W"]:
            moltiplicatore_w = 1
            moltiplicatore_costi = 2  # Moltiplica i costi per 2
        elif stato_bottoni["2W"]:
            moltiplicatore_w = 2
            moltiplicatore_costi = 3  # Moltiplica i costi per 3
        elif stato_bottoni["3W"]:
            moltiplicatore_w = 3
            moltiplicatore_costi = 4  # Moltiplica i costi per 4
        elif stato_bottoni["4W"]:
            moltiplicatore_w = 4
            moltiplicatore_costi = 5  # Moltiplica i costi per 5
        
        consumo_w = parametri["consumo_W_mq"] * area_mq * moltiplicatore_w
        
        # Calcola i costi vari, di investimento e assistenza, poi moltiplica per il moltiplicatore appropriato
        costi_vari_al_mq = ((parametri["costi_vari_operatore_mq"] + parametri["investimento_mq"] + parametri["assistenza_ricambi_mq"]) * area_mq) * moltiplicatore_costi
        
        costo_totale = (parametri["costo_C_litro"] * consumo_cmyk) + (parametri["costo_W_litro"] * consumo_w) + costi_vari_al_mq
        
         # Nuovo calcolo per includere il costo orario di prestampa per unità
        costo_orario_prestampa_per_unita = parametri["costo_orario_prestampa"] / quantita
        
        # Aggiungi questo costo al costo totale della stampa
        costo_totale += costo_orario_prestampa_per_unita
        
        # La variabile costo_totale viene poi utilizzata come prima per mostrare il costo e passarlo a apri_finestra_report()
        
        costo_stampa_var.set(f"€ {costo_totale:.2f}")
        apri_finestra_report(area_mq, consumo_cmyk, consumo_w, costo_totale)
        
    except ValueError:
        messagebox.showerror("Errore", "Inserire valori numerici validi.")





def apri_finestra_report(area_mq, consumo_cmyk, consumo_w, costo_totale):
    finestra_report = tk.Toplevel()
    finestra_report.title("Report Calcolo Area e Consumo Inchiostro")
    imposta_dimensioni_finestra(finestra_report, 0.4, 0.5)
    
    costo_medio_cmyk = parametri["costo_C_litro"] * consumo_cmyk
    costo_medio_w = parametri["costo_W_litro"] * consumo_w
    
    if area_mq > 0:
        tk.Label(finestra_report, text=f"Superficie calcolata in mq: {area_mq:.3f}").pack()
    if consumo_cmyk > 0:
        tk.Label(finestra_report, text=f"Consumo medio di inchiostro CMYK (litri): {consumo_cmyk:.3f}").pack()
        tk.Label(finestra_report, text=f"Costo medio inchiostro CMYK: {costo_medio_cmyk:.2f}").pack()
    if consumo_w > 0:
        tk.Label(finestra_report, text=f"Consumo medio di inchiostro W (litri): {consumo_w:.3f}").pack()
        tk.Label(finestra_report, text=f"Costo medio inchiostro W: {costo_medio_w:.2f}").pack()
    
    # Calcola e mostra i costi vari al mq
    costi_vari_al_mq = (parametri["costi_vari_operatore_mq"] + parametri["investimento_mq"] + parametri["assistenza_ricambi_mq"]) * area_mq
    tk.Label(finestra_report, text=f"Costi vari al mq: {costi_vari_al_mq:.2f}").pack()
    
    # Etichetta per il costo totale della stampa (duplicato)
    duplicato_frame = tk.Frame(finestra_report)
    duplicato_frame.pack(pady=5)
    tk.Label(duplicato_frame, text="Costo totale stampa: ", font=font_grande).pack(side=tk.LEFT)
    tk.Label(duplicato_frame, text=f"€ {costo_totale:.2f}", font=font_grande).pack(side=tk.LEFT)

    # Etichetta per il costo totale della stampa (originale)
    tk.Label(finestra_report, text=f"Costo di stampa totale: € {costo_totale:.2f}").pack()

    # Duplica il costo totale della stampa originale con stile identico
    tk.Label(finestra_report, text=f"Costo totale stampa: € {costo_totale:.2f}", font=font_grande).pack()

# Funzione per gestire il clic sui pulsanti, aggiornata per permettere la deselezione
def gestisci_clic(pulsante):
    global stato_bottoni
    if pulsante in ["1W", "2W", "3W", "4W"]:  # Applica logica solo ai pulsanti W
        stato_bottoni[pulsante] = not stato_bottoni[pulsante]  # Toggle dello stato del pulsante
        for strato in ["1W", "2W", "3W", "4W"]:
            if strato != pulsante:  # Deseleziona tutti gli altri pulsanti W
                stato_bottoni[strato] = False
                bottoni[strato].configure(bg=colore_deselezionato)
        bottoni[pulsante].configure(bg=colore_selezionato if stato_bottoni[pulsante] else colore_deselezionato)
    else:  # Per gli altri pulsanti, inclusi CMYK, applica la logica di toggle
        stato_bottoni[pulsante] = not stato_bottoni[pulsante]
        bottoni[pulsante].configure(bg=colore_selezionato if stato_bottoni[pulsante] else colore_deselezionato)

font_grande = ('Century Gothic', 14)

# Variabili globali per la gestione dello stato dei pulsanti
stato_bottoni = {"CMYK": False, "1W": False, "2W": False, "3W": False, "4W": False}
colore_selezionato = "#90ee90"
colore_deselezionato = "SystemButtonFace"

# Variabile globale per memorizzare i parametri correnti
parametri = carica_parametri()

# Finestra Principale
root = tk.Tk()
root.title("PrintKalculator V 2.0")

# Imposta le dimensioni della finestra come percentuale dello schermo
imposta_dimensioni_finestra(root, 0.5, 0.6)

# Aggiungi scritta con il nome dell'applicazione e colore azzurrino
tk.Label(root, text="PrintKalculator V 2.0", font=("Century Gothic", 24), fg="#004c84").pack()

# Aggiungi spazio extra sotto la scritta
tk.Frame(root, height=20).pack()

frame_centrale = tk.Frame(root)
frame_centrale.pack(expand=True, fill=tk.BOTH)

# Label e campo di input per la lunghezza
tk.Label(frame_centrale, text="Lunghezza (mm):", font=font_grande).pack()
lunghezza_var = tk.StringVar()
lunghezza_entry = tk.Entry(frame_centrale, font=font_grande, textvariable=lunghezza_var, width=10)
lunghezza_entry.pack()

# Label e campo di input per la larghezza
tk.Label(frame_centrale, text="Larghezza (mm):", font=font_grande).pack()
larghezza_var = tk.StringVar()
larghezza_entry = tk.Entry(frame_centrale, font=font_grande, textvariable=larghezza_var, width=10)
larghezza_entry.pack()

# Aggiunto: Label e campo di input per la quantità
tk.Label(frame_centrale, text="Quantità:", font=font_grande).pack()
quantita_var = tk.StringVar()
quantita_entry = tk.Entry(frame_centrale, font=font_grande, textvariable=quantita_var, width=10)
quantita_entry.pack()



# Pulsanti di selezione, aggiornati per permettere la deselezione e applicare moltiplicatori
frame_pulsanti = tk.Frame(frame_centrale)
frame_pulsanti.pack(pady=(20, 0))  # Aggiunto padding superiore per distanziare i bottoni dalla riga precedente

bottoni = {}
for testo in ["CMYK", "1W", "2W", "3W", "4W"]:
    bottoni[testo] = tk.Button(frame_pulsanti, text=testo, font=font_grande, bg=colore_deselezionato,
                               command=lambda t=testo: gestisci_clic(t))
    bottoni[testo].pack(side=tk.LEFT)

# Aggiungi uno spaziatore per separare i bottoni dalla riga successiva
tk.Frame(frame_centrale, height=10).pack()

# Bottone "Calcola"
tk.Button(frame_centrale, text="Calcola", font=font_grande, command=esegui_calcolo).pack()

# Casella di testo per il costo di stampa totale
costo_stampa_var = tk.StringVar()
costo_stampa_entry = tk.Entry(frame_centrale, font=font_grande, textvariable=costo_stampa_var, state='readonly', justify="center")
costo_stampa_entry.pack(pady=(20, 0))  # Aumentato padding superiore per distanziare la casella di testo dal pulsante "Calcola"

# Aggiungi la didascalia in grassetto sotto il campo "costo totale stampa"
font_didascalia = ('Century Gothic', 14, 'bold')  # Definisce un font in grassetto per la didascalia
didascalia = tk.Label(frame_centrale, text="Costo totale stampa", font=font_didascalia)
didascalia.pack()  # Aggiunge la didascalia sotto la casella di testo

# Bottone "Impostazioni"
tk.Button(root, text="Impostazioni", font=font_grande, command=apri_finestra_setup).pack(side=tk.BOTTOM, pady=(0, 20))  # Aggiunto padding inferiore per distanziare il pulsante "Impostazioni" dal basso


root.mainloop()
