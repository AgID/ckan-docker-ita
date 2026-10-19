# CKAN Docker per l'Italia

> [!NOTE]
> Stack CKAN **2.10.11** + PostgreSQL **16** + Solr **9** + Redis + NGINX, già
> predisposto per le funzionalità dei cataloghi open data italiani. Pensato per essere
> provato in locale e poi spostato su un dominio reale cambiando una sola
> variabile (`CKAN_SITE_URL`). Leggere il [CHANGELOG](CHANGELOG.md) per i
> passaggi più delicati legati all'harvesting dei cataloghi federati.

## Cosa include

- **DCAT-AP_IT** — estensione `ckanext-dcatapit` (Geosolutions) adeguata a CKAN 2.10.10.
- **OAI-PMH** — `ckanext-oai-pmh-server` (con supporto DataCite/OpenAIRE).
- **Harvesting** — `ckanext-harvest` + harvester CKAN, RDF e DCAT-JSON.
- **Linked Open Data / RDF** — `ckanext-dcat` (profili `euro_dcat_ap_2`, `it_dcat_ap`)
  con export `catalog.rdf` / `catalog.ttl` e `/dataset/{id}.rdf`.
- **MQA / data.europa.eu** — `ckanext-dcat-ap-edp-mqa` (disattivabile, vedi sotto).
- **Multilingua** (`ckanext-multilang`) e **Xloader** per il DataStore.

## Prerequisiti

- Docker Engine + plugin Compose v2 (comando `docker compose`).
  Guida: <https://docs.docker.com/engine/install/ubuntu/>
- Verifica: `docker run hello-world` e `docker compose version`.

---

## Configurazione (`.env`)

Tutta la configurazione passa dal file `.env`. Si parte da `.env.example`:
tutte le variabili hanno default sensati per un test locale, e l'unico blocco
realmente da toccare è quello in cima al file (`>>> DA MODIFICARE <<<`).

Variabili chiave:

| Variabile | A cosa serve |
|---|---|
| `CKAN_SITE_URL` | URL pubblico del portale, **senza slash finale**. Da qui vengono derivati automaticamente `ckanext.dcat.base_uri` e l'URL base OAI-PMH. |
| `CKAN_SYSADMIN_NAME` / `CKAN_SYSADMIN_PASSWORD` | Utente e password del primo amministratore. |
| `NGINX_PORT_HOST` / `NGINX_SSLPORT_HOST` | Porte host per accesso **non-SSL** e **SSL**. |
| `GEONAMES_USERNAME` | Username GeoNames per il geocoding (default `demo`). |
| `CKAN_OAIPMH_BASE_URL` | (opzionale) forza l'URL base OAI; se vuoto usa `${CKAN_SITE_URL}/oai`. |

### Demo locale vs dominio reale

Basta impostare `CKAN_SITE_URL` 

- HTTP locale: `CKAN_SITE_URL=http://localhost:8080`
- HTTPS locale: `CKAN_SITE_URL=https://localhost:8443`
- IP privato: `CKAN_SITE_URL=http://192.168.1.50:8080`
- Produzione: `CKAN_SITE_URL=https://dati.miocomune.it`

### SSL o non-SSL

NGINX espone **entrambi** gli accessi contemporaneamente:

- non-SSL → `http://<host>:${NGINX_PORT_HOST}` (default `8080`)
- SSL → `https://<host>:${NGINX_SSLPORT_HOST}` (default `8443`, certificato
  self-signed generato in automatico al primo avvio).

Si usa quello che si preferisce; `CKAN_SITE_URL` deve coerentemente puntare
allo schema/porta scelti. In produzione, terminare il TLS con un certificato
valido (es. reverse proxy esterno o sostituendo il cert in `nginx/certs`).

---

## Primo avvio (passi esatti)

Eseguire i comandi **in ordine**, aspettando il completamento di ciascuno.

1. Clonare e preparare il `.env`:

   ```sh
   git clone https://github.com/piersoft/ckan-docker-ita.git
   cd ckan-docker-ita
   cp .env.example .env
   ```

2. Modificare nel `.env` almeno `CKAN_SITE_URL` e `CKAN_SYSADMIN_PASSWORD`
   (vedi tabella sopra).

3. Costruire le immagini:

   ```sh
   docker compose build
   ```

4. Avviare lo stack:

   ```sh
   docker compose up -d
   ```

5. Attendere che CKAN sia **healthy** (il primo avvio carica i vocabolari
   DCAT-AP_IT e può richiedere alcuni minuti):

   ```sh
   docker compose ps
   ```

6. Eseguire **una sola volta** il setup dei gruppi tematici (idempotente):

   ```sh
   docker compose exec ckan bash /srv/app/setup_groups.sh
   ```

7. Riavviare CKAN per applicare i marker di completamento:

   ```sh
   docker compose restart ckan
   ```

Il portale è ora raggiungibile all'indirizzo impostato in `CKAN_SITE_URL`.

> [!NOTE]
> Il passo 6 va ripetuto solo dopo un nuovo `docker compose build` (immagine
> ricostruita), **non** a ogni `restart`.

---

## Comandi utili

- **Build** (ricostruire le immagini):

  ```sh
  docker compose build
  ```

- **Start / Stop**:

  ```sh
  docker compose up -d
  docker compose down          # ferma e rimuove i container (i volumi restano)
  ```

- **CKAN in stato `unhealthy`** — riavviare CKAN, attendere 2-3 minuti, poi
  riavviare NGINX:

  ```sh
  docker compose restart ckan
  sleep 180
  docker compose restart nginx
  ```

- **Setup iniziale dei gruppi** (vedi passo 6):

  ```sh
  docker compose exec ckan bash /srv/app/setup_groups.sh
  ```

- **Log** in tempo reale:

  ```sh
  docker compose logs -f ckan
  ```

- **Reset totale** (cancella anche i dati: DB, indice Solr, storage):

  ```sh
  docker compose down -v
  ```

---

## Verifica delle funzionalità

- Catalogo RDF: `${CKAN_SITE_URL}/catalog.rdf` e `.../catalog.ttl`
- RDF del singolo dataset: `${CKAN_SITE_URL}/dataset/{id}.rdf`
- OAI-PMH: `${CKAN_SITE_URL}/oai?verb=Identify`,
  `.../oai?verb=ListMetadataFormats`,
  `.../oai?verb=ListRecords&metadataPrefix=oai_dc`
- Harvesting: interfaccia in `${CKAN_SITE_URL}/harvest`

---

## Validazione SHACL con il profilo di data.europa.eu

`tools/validate_edp_shacl.py` valida il `catalog.ttl` con **le stesse shape che
usa data.europa.eu**, cosi' da vedere violazioni e warning prima che compaiano
sul portale europeo. Non usa le shape SEMIC "pure": scarica
`shapes.ttl` + `deprecateduris.ttl` dal progetto
[piveau-metrics-validating-shacl](https://gitlab.com/piveau/metrics/piveau-metrics-validating-shacl),
cioe' il profilo "DCAT-AP 3.0.1 Level 1" con cui EDP valida i metadati
harvestati. Piveau aggiunge regole proprie che nelle shape SEMIC non esistono.

```bash
pip install rdflib pyshacl

# un singolo dataset
python3 tools/validate_edp_shacl.py https://dati.gov.it/opendata --name NOME-DATASET

# le prime 3 pagine del catalogo (100 dataset per pagina)
python3 tools/validate_edp_shacl.py https://dati.gov.it/opendata --pages 3

# solo un ente
python3 tools/validate_edp_shacl.py https://dati.gov.it/opendata --fq organization:NOME-ENTE

# un TTL gia' scaricato
python3 tools/validate_edp_shacl.py --file catalog.ttl

# aggiunge anche le shape raccomandate, piu' severe del profilo EDP
python3 tools/validate_edp_shacl.py https://dati.gov.it/opendata --level 2
```

Altre opzioni: `--dcatap` per la versione delle shape (default `3.0.0`, quella
indicata nei report DQV di EDP),
`--examples` per quanti esempi mostrare di ogni segnalazione, `--json FILE` per
salvare il riepilogo. Codice di uscita: `0` se non ci sono Violation, `1` se ce
ne sono, `2` in caso di errore — quindi si puo' usare in una pipeline.

Le shape vengono scaricate una volta e messe in cache nella directory
temporanea del sistema. Due avvertenze pratiche: serve rete verso `gitlab.com`,
e **`dati.gov.it` va interrogato senza `www`**, perche' il WAF blocca le
richieste che non arrivano da un browser.

Ogni pagina viene validata separatamente, come fa EDP: unire le pagine in un
unico grafo duplicherebbe i nodi anonimi dei sottocataloghi e produrrebbe falsi
errori di cardinalita' sul publisher.

### Come leggere l'esito

`Violation` sono non conformita' da correggere. `Warning` no: molti vengono
dalle shape di deprecazione di piveau, che segnalano cambi di vocabolario fra
DCAT-AP 2.1 e 3.0 e in alcuni casi penalizzano proprio il vocabolario nuovo.
Prima di inseguire un warning conviene leggere la shape che lo genera nei file
in cache, perche' non sempre indica un errore nei metadati.

### Profili italiani: DCAT-AP_IT, vocabolari, HVD

Con `--profile` lo stesso script valida anche secondo le regole italiane. Le
shape stanno in `tools/shapes/` e non vengono scaricate.

| Profilo | Cosa controlla | Fonte |
|---|---|---|
| `edp` (default) | shape di piveau usate da data.europa.eu | piveau-metrics-validating-shacl |
| `dcatapit` | identificativo, titolare (`dct:rightsHolder`), frequenza, temi, data di modifica; soggetti con `dct:identifier` e `foaf:name` non vuoti; punto di contatto con `vcard:fn` e `vcard:hasEmail`; formato, URL di accesso e licenza della distribuzione; tipi `dcatapit:*` | Linee guida AgID per i cataloghi dati |
| `vocabolari` | temi sui 14 valori EU `data-theme`, frequenza, lingua, formato, diritti di accesso, media type IANA, URI ELI, categorie HVD | authority table EU |
| `hvd` | `dcatap:applicableLegislation` con l'ELI del Reg. UE 2023/138 e `dcatap:hvdCategory` su dataset, distribuzioni e servizi | Guida operativa AgID sui dati di elevato valore v1.0 (azione #hvd14), DCAT-AP HVD 2.2.0 |
| `agid` | identificativo del dataset `codiceIPA:identificativo` (solo lettere, cifre, `-` e `_`) con il prefisso uguale al codice IPA del titolare; codice IPA del titolare senza caratteri speciali; email dell'editore del catalogo e dei sottocataloghi non PEC | Indicazioni operative AgID per l'harvesting su dati.gov.it (non regole DCAT): escono come `Info` e non cambiano l'esito |

Nel profilo `dcatapit` le proprieta' obbligatorie producono una `Violation`, le
raccomandate un `Warning`. Il profilo `hvd` si applica solo alle risorse che
dichiarano l'ELI 2023/138 o una categoria HVD, alle loro distribuzioni e ai
servizi che le servono: le shape HVD ufficiali di SEMIC assumono invece un
catalogo interamente HVD. Per i vocabolari i temi sono controllati sull'elenco
chiuso, gli altri valori sul namespace dell'URI.

Il profilo `agid` raccoglie criteri di gestione del catalogo nazionale, non
regole DCAT: identificativi univoci e riconducibili all'ente, e un'email
ordinaria (PEO) per contattare chi gestisce il catalogo. Non essendo regole,
tutte le segnalazioni sono `Info` ("indicazioni", in viola nella pagina) e non
rendono il catalogo non conforme. La PEC si riconosce in modo euristico (`pec`
come parte dell'indirizzo, `cert.`, gestori PEC noti). Non e' incluso in `it`;
lo e' in `tutti`.

Prima dell'harvesting va sempre verificato che l'endpoint del catalogo e, a
campione, le risorse rispondano `200` a una richiesta `HEAD` (`curl -I <url>`),
senza WAF o filtri su IP e User-Agent: i dati aperti devono essere accessibili
e interoperabili. Il validatore non lo controlla: il risultato dipende da chi fa
la richiesta, e quello che conta e' l'harvester.

```bash
# EDP + tutti i profili italiani + regole operative AgID
python3 tools/validate_edp_shacl.py --file catalog.ttl --profile tutti

# solo i profili italiani (it = dcatapit,vocabolari,hvd)
python3 tools/validate_edp_shacl.py https://dati.gov.it/opendata --pages 2 --profile it
```

`--file` accetta anche RDF/XML e JSON-LD.

### Validatore nel browser

`tools/validatore-web/` contiene la stessa validazione come pagina web: si
carica un file (Turtle, RDF/XML, N-Triples, JSON-LD), si scelgono i profili e
si ottiene l'elenco delle segnalazioni raggruppate per regola, con esempi ed
esportazione in JSON o CSV. Tutto avviene nel browser, il file non viene inviato
a nessun server. Le shape EDP sono incluse nella pagina (licenza Apache 2.0,
Fraunhofer FOKUS) invece di essere scaricate.

La pagina e' pubblicata su GitHub Pages dal workflow
`.github/workflows/validatore-pages.yml`, che riparte a ogni modifica della
pagina o delle shape. Per costruirla in locale:

```bash
cd tools/validatore-web
npm ci
npm run build          # produce dist/index.html, un file unico
node test/run.mjs catalog.ttl   # stessa validazione da riga di comando
```

La scheda "CKAN" scarica direttamente `catalog.ttl` da un portale, ma funziona
solo se il server permette la lettura da altre pagine (CORS). Con i portali che
non lo permettono, `dati.gov.it` compreso, si scarica il file e lo si carica
dalla scheda "File".

Sugli stessi file la pagina e lo script Python danno gli stessi conteggi, per
profilo e per gravita'.

---

## Note sulle patch (harvesting cataloghi federati)

Le patch nei file `processors.py`, `rdf.py`, `profiles.py` (dentro `ckan/patches`
e nelle estensioni `ckanext-dcat` / `ckanext-dcatapit` incluse) nascono
dall'analisi degli harvesting dei cataloghi nazionali, regionali e comunali su
[dati.gov.it](https://dati.gov.it). Servono a "neutralizzare" metadati
incompleti o non conformi dei cataloghi remoti, così che l'export finale in
Linked Open Data resti corretto. Per un'installazione **stand-alone** (senza
harvesting di cataloghi terzi) la maggior parte di queste patch non incide.

Dettagli ed esempi nel [CHANGELOG](CHANGELOG.md).

## Disattivare l'integrazione OpenAIRE / MQA

Se non serve l'integrazione con OpenAIRE/`data.europa.eu`:

1. rimuovere `dcat_ap_edp_mqa` dalla variabile `CKAN__PLUGINS` nel `.env`;
2. rimuovere `dcat_ap_edp_mqa` da `ckanext.dcat.rdf.profiles` in
   `ckan/docker-entrypoint.d/02_ckan-init.sh`.

## Crediti

- Estensione originale DCAT-AP_IT re-ingegnerizzata e aggiornata: [Geosolutions — ckanext-dcatapit](https://github.com/geosolutions-it/ckanext-dcatapit)
- OAI-PMH: [tlmat-unican — ckanext-oai-pmh-server](https://github.com/tlmat-unican/ckanext-oai-pmh-server)
- Immagini base CKAN: [ckan/ckan-docker-base](https://github.com/ckan/ckan-docker-base)

- Progetto e personalizzazione a cura di @piersoft (Francesco Piero Paolicelli) per conto di [AgID](https://www.agid.gov.it/it).
