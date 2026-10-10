# Changelog

## `2026-10-10` — upgrade a CKAN 2.10.11
- `ckan/Dockerfile`: immagine base `ckan/ckan-base:2.10.11-py3.10`; `.env.example` allineato a `CKAN_VERSION=2.10.11`.
- 2.10.11 (26 agosto 2026) chiude otto advisory di sicurezza. Due riguardano direttamente questo stack: **GHSA-5r6j-4c43-7mx6**, bypass non autenticato dell'allowlist dei query parser Solr in `package_search`, che e' l'endpoint su cui poggiano tutti gli endpoint DCAT; e **GHSA-8hw7-23gj-5599**, authorization bypass in `datastore_search_sql`. Gli altri sei: SQL injection in `datastore_create`, XSS stored nel Text view, nel DataTables view e via `markdown_extract()`, session fixation nella registrazione, esposizione di metadati privati tramite le API follow.
- Prima dell'upgrade e' stato verificato, file per file, se 2.10.11 modifica qualcuno dei file di CKAN che il Dockerfile sovrascrive. Non modificati, quindi mantenuti: `lib/dictization/model_dictize.py`, `lib/base.py`, `logic/validators.py`, `templates/snippets/language_selector.html`. Modificati da 2.10.11, quindi **gli override sono stati rimossi** per non annullare le correzioni: `logic/__init__.py` e `views/util.py`.
- `patches/util.py` rimosso: la copia era identica al file originale di 2.10.10, quindi l'override non aggiungeva nulla e avrebbe soppresso la gestione di `FlaskRouteBuildError` su `internal_redirect` introdotta in 2.10.11.
- `patches/__init__.py` rimosso: avrebbe soppresso l'aggiunta di `**kwargs` a `fresh_context()`, necessaria a una delle correzioni. Il contenuto dell'override non era piu' utile: riscritture di chiamate a `log.debug` e una condizione che, per come era scritta, non alterava il flusso.
- Da verificare dopo il deploy: la correzione su `datastore_search_sql` irrigidisce `is_single_statement()` in `ckanext/datastore/helpers.py`, che ora rifiuta le query contenenti `#` anche all'interno di una stringa. Eventuali client che generano SQL con quel carattere vanno adeguati.
- Verificato che le estensioni non usino query parser locali ne' campi magici Solr nelle `fq`. I requirements cambiano solo `certifi`, `lxml` 6.0.2 -> 6.1.1 e `PyJWT` 2.12 -> 2.13.

## `2026-10-09` — conformita' DCAT-AP 3.0 e metriche MQA di data.europa.eu
Serie di correzioni al profilo RDF, tutte verificate sul grafo pubblicato e sull'API MQA di data.europa.eu (`metricsVersion 2.0.0`). Punto di partenza: dataset 7,0/7,5, distribuzioni 7,25/7,5, `datasetFinal` 7,125.

**Metriche di disponibilita' rimaste a zero.** Gli unici `result=0` erano `admsIdentifierAvailability`, `relationAvailability` (dataset) e `documentationAvailability` (distribuzione), 0,25 ciascuna. Il mapping esisteva gia' in `euro_dcat_ap.py` per gli extra `alternate_identifier`, `related_resource` e `documentation`: mancavano i valori, perche' nessuno popola quegli extra. Sono stati aggiunti fallback deterministici:
- `adms:identifier`: nodo `adms:Identifier` con una sola `skos:notation` (id CKAN). Sta in `ckanext-dcatapit/.../dcat/profiles.py` e non in `euro_dcat_ap.py`, perche' il profilo `it_dcat_ap` gira dopo ed esegue `g.remove((dataset_ref, ADMS.identifier, None))`.
- `dct:relation`: catalogo dell'ente titolare sul portale.
- `foaf:page` sulla distribuzione: `documentation`/`describedBy` della risorsa, altrimenti una `dcat:landingPage` gia' presente nel grafo, con una guardia che vieta di coincidere con il dataset o con la distribuzione stessa. Senza quella guardia il valore puo' collassare sull'URI del dataset, che in alcune configurazioni ha la stessa forma della pagina del dataset: la distribuzione documenterebbe il dataset e il nodo del dataset si porterebbe dietro un `rdf:type foaf:Document`. Conseguenza accettata: i dataset senza landing page e senza documentazione sulla risorsa non espongono `foaf:page`.

**Tipizzazione dei nodi nel grafo.** Diverse shape di DCAT-AP 3.0 impongono `sh:class`, e il validatore non dereferenzia gli URI: il tipo va dichiarato nel grafo pubblicato.
- `adms:status`: il warning `StatusRestrictionADMS` non dipendeva dal vocabolario usato. Verificato sull'endpoint SPARQL di data.europa.eu che scatta con entrambi — 205.860 occorrenze con `purl.org/adms/status/Completed` e 17.216 con l'URI EU `distribution-status/COMPLETED` usato come IRI nudo. Le sole distribuzioni senza warning (circa 3.600) usano l'URI EU **e** dichiarano il concetto nel grafo. Aggiunte quindi le triple `a skos:Concept` e `skos:inScheme` accanto a ogni `adms:status`.
- `dcat:landingPage`: erano IRI nudi, mentre `dcat:DatasetShape` impone `sh:class foaf:Document`. Il tipo viene ora dichiarato nel profilo `it_dcat_ap`, che gira per ultimo e copre anche le landing page aggiunte da dcatapit.
- Nessuno dei valori passa da `URIRefOrLiteral`: le shape di `adms:identifier` e `dct:relation` impongono `sh:nodeKind sh:BlankNodeOrIRI`, e un literal genererebbe un warning nuovo.

**`dcat:byteSize` con datatype errato.** `dcat:DistributionShape` impone `sh:datatype xsd:nonNegativeInteger` e `sh:maxCount 1`, mentre `euro_dcat_ap.py` emetteva `Literal(float(size), datatype=XSD.decimal)`, cioe' `"1024.0"^^xsd:decimal`, su ogni distribuzione del catalogo. Corretto anche un difetto collaterale: il test era `if resource_dict.get("size")`, falso anche per `size == 0`, quindi una risorsa da 0 byte veniva pubblicata come 1024. Il default 1024 scatta ora solo con valore assente o non numerico non negativo. Aggiunta la guardia su `byteSize` gia' presente nel grafo, per `sh:maxCount 1`.

**`organization_list?all_fields=true` restituiva 500.** `json.dumps` riceveva il sentinella `missing` di navl. Catena completa: `_group_or_org_list` chiama `organization_show` per ogni organizzazione forzando `include_extras=False`; `convert_from_extras` non trova extras da convertire e la chiave resta a `missing`; la catena di validator di `identifier` contiene solo `not_empty`, che registra l'errore ma **non rimuove la chiave**, a differenza di `ignore_missing` e `ignore_empty` che fanno `data.pop(key)`; `group_show` scarta gli errori di validazione e il sentinella arriva alla serializzazione. Correzione in `db_to_form_schema()`: la catena di lettura diventa `[convert_from_extras, ignore_missing] + validator`. Messa li' e non in `get_custom_organization_schema()`, perche' quella lista serve anche a creazione e aggiornamento: anteporre `ignore_missing` renderebbe `identifier` opzionale in scrittura.

## `2026-09-28` — `dct:provenance` sui dataset harvestati
- `patches/ckanext-dcatapit/.../dcat/profiles.py`: a fine `parse_dataset` il profilo `it_dcat_ap` compila `provenance` quando manca, usando solo dati certi del dataset (ente titolare, catalogo d'origine). Se non bastano, il campo resta vuoto: nessun testo generico.
- Copre l'indicatore MQA "Origine" (Riutilizzabilita', 0,25). Testo personalizzabile con `ckanext.dcatapit.provenance_template`.
- La stessa regola e' implementata sullo stack CKAN 2.12 nell'estensione `ckanext-dcatita`; qui l'intervento e' in-place perche' le estensioni sono vendorizzate sotto `patches/`.

## `2026-06-01`
Pulizia e robustezza del setup Docker (versione demo):
- **Nessun dominio hardcoded**: `ckan.oaipmh.base_url` e `ckanext.dcat.base_uri` sono derivati da `CKAN_SITE_URL`; aggiunta variabile opzionale `CKAN_OAIPMH_BASE_URL`. GeoNames parametrizzato via `GEONAMES_USERNAME`.
- **`.env.example` riscritto**: rimossi gli spazi attorno agli `=` (causa di valori con spazi spuri), blocco iniziale "DA MODIFICARE", `CKAN_VERSION=2.10.9`, `TZ=Europe/Rome`.
- **`docker-compose.yml`**: rimossa la chiave obsoleta `version`; eliminati gli override `environment:` sugli URL DB che divergevano dal `.env` sul `?sslmode=disable` (sorgente unica = `.env`); healthcheck CKAN con `start_period: 300s` per evitare lo stato `unhealthy` durante il caricamento dei vocabolari; healthcheck db/solr/redis con intervalli espliciti.
- **NGINX**: espone sia HTTP (`NGINX_PORT_HOST`) sia HTTPS (`NGINX_SSLPORT_HOST`); corretto l'ENTRYPOINT con `openssl` malformato (doppio `-keyout` verso directory inesistente); certificato self-signed generato una sola volta in `certs/`.
- **Setup gruppi**: lo script `03_ckan_groups.end` (estensione non eseguita dall'entrypoint) sostituito da `setup_groups.sh`, idempotente, copiato in `/srv/app/setup_groups.sh` ed eseguibile con `docker compose exec ckan bash /srv/app/setup_groups.sh`.
- **Dockerfile CKAN**: `apt-get update && apt-get install -y nano curl` (prima `apt install nano` falliva); corretto `chmod` che puntava al file sbagliato (`topics.json` -> `regions.rdf`).
- **Repo ripulito**: rimossi `__pycache__/`, `*.pyc`, file `*.orig`/`*.old`/`*.pyintermedio`.


## `2026-03-15`
E' stato inserito il file bash [04_patch_uwsgi.sh](ckan/docker-entrypoint.d/04_patch_uwsgi.sh) che estende lo star_ckan.sh con  gli EXTRAS di uSWGI. Nel file .env è stato inserito EXTRA_UWSGI_OPTS=--http-timeout 600 --socket-timeout 600 --ignore-sigpipe --ignore-write-errors --disable-write-exception che estende il time out del CKAN nella creazione dei catalog.rdf/ttl, da 60 secondi a 600 per i cataloghi molto grossi o CKAN sottodimensionati

## `2026-02-19`
Estensione patchata per OAI-PMH per l'interfacciamento con OPENAIRE. Configurare lo script `/docker-entrypoint.d/01_setup_xloader.sh` con l'URL del proprio server. Endpoint di verifica: `/oai?verb=Identify`, `/oai?verb=ListMetadataFormats`, e per l'elenco completo da una data `/oai?verb=ListRecords&metadataPrefix=oai_datacite&from=2026-01-01`.
- Se OpenAIRE non serve, rimuovere `dcat_ap_edp_mqa` da `ckanext.dcat.rdf.profiles` in `01_setup_xloader.sh` e dalla sezione plugin del file `.env`.

## `2026-02-13`
Migrazione al CKAN 2.10.9 e fix vari

## `2026-02-10`
Fix docker-compose.yml per errore primo avvio

## `2026-01-27`
Inserito file css.example con il css da inserire nel Front End dell'Admin, nel caso si voglia avere un layout diverso.

## `2026-01-07`
Patch per hasPart come subcatalog per le organizzazioni create in locale
dovete sempre e solo accertarvi che quando create una organizzazione il campo URL sia sempre valorizzato (diventa il site e quindi la URI del subcatalog).

## `2025-12-24`
Eliminato il Datapusher ed inserito di Xloader

## `2025-12-22`
Patch del 2025-04-09 disattivata e abilitato il recepimento automatico della url tramite ckan_site_url

## `2025-12-20`
Risolto bug per HVD non valorizzati nelle modifiche manuali e che generavano extras hvd_category: "" al posto di non creare proprio la proprietà

## `2025-09-15`
test per Postgres16 nativamente supportato. Modificati i files Docker e .yml. Beta

**DATA.EUROPA.EU** richiede che le accessURL e i downloadURL siano raggiunbili in HEAD con risposta 200. Testare le proprie risorse con CURL -I URL 

Versione beta, stabile

~~## `2025-04-09`~~
OBSOLETA: ~~nel file [__euro_dcat_ap.py__](ckan/patches/ckanext-dcat/ckanext/dcat/profiles/euro_dcat_ap.py) è inserita una patch delicata. l'accessURL viene sostituito con la landingpage della risorsa sul CKAN e il downloadURL viene popolato con il valore di download della risorsa (ex accessURL). Sostituire il path del dominio con il proprio portale CKAN:~~

	    if dataset_dict.get('id'):
               resource_dict['access_url']='<CKAN_SITE_URL>/dataset/'+dataset_dict['id']+'/resource/'+resource_dict['id']

~~Se NON si vuole tale trasformazione, commentare le due righe di codice precedenti. il downloadURL, in tal caso, verrà impostato identico all'accessURL~~

## `2024-09-27`
Il codice è al 99,999% pronto per una installazione stand alone. le patch che ogni tanto aggiorno sono per harvesting di cataloghi remoti. Se non è il vostro caso, credo che si possa considerare stabile.

## `2024-06-27`
La mappatura automatica dei GRUPPI durante gli harvesting, è settata manualmente nel file [mapping.py](ckan/patches/ckanext-dcatapit/ckanext/dcatapit/mapping.py) (estensione DCATAPIT) e non in nella variabile ckanext.dcatapit.theme_group_mapping.file in ckan.ini. Punta a /srv/app/patches/theme_to_group.ini . Questo file viene copiato automaticamente in quella posizione, non bisogna fare nulla nella compilazione da Docker proposta. Se si fanno configurazioni differenti, va modificato il path.

## `2024-06-20`
RISOLTO HARVESTING SIA IN RDF/TTL CHE CON DCAT JSON. ESEGUIRE 2 VOLTE L'HARVESTING PER ATTIVARE PATCH SUCCESSIVE SU FORMATI,ACCESS_RIGHTS ect

## `2024-06-19`
SE SI VUOLE AVERE IL FILTRO HVD CATEGORY modificare in ckan.ini -> search.facets = organization groups tags res_format license_id hvd_category

## `2024-06-18`
PRESENTI ANCORA ALCUNI BUG IN HARVESTING JSON. 

## `2024-06-07`
AGGIORNATO FRONTEND DI CKAN CON HVD, ACCESS SERVICE E APPLICABLE LEGISLATION. 

## `2024-06-01`
VERSIONE NON STABILE E CON MOLTI ERRORI: DA NON USARE IN PRODUZIONE. 















