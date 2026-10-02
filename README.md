# CKAN Docker per l'Italia

> [!NOTE]
> Stack CKAN **2.10.10** + PostgreSQL **16** + Solr **9** + Redis + NGINX, già
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

- Estensione DCAT-AP_IT: [Geosolutions — ckanext-dcatapit](https://github.com/geosolutions-it/ckanext-dcatapit)
- OAI-PMH: [tlmat-unican — ckanext-oai-pmh-server](https://github.com/tlmat-unican/ckanext-oai-pmh-server)
- Immagini base CKAN: [ckan/ckan-docker-base](https://github.com/ckan/ckan-docker-base)

- Progetto e personalizzazione a cura di @piersoft (Francesco Piero Paolicelli) per conto di [AgID](https://www.agid.gov.it/it).
