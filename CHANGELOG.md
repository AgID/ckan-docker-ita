# Changelog

## `2026-10-09` — foaf:page puntava al dataset stesso (difetto introdotto in giornata)
- Verificato sul grafo in produzione: su dati.gov.it l'URI del dataset e' **esattamente** `https://www.dati.gov.it/view-dataset/dataset?id=<name>`, lo stesso URL che il fallback di `foaf:page` costruiva. Risultato: la distribuzione documentava il dataset stesso e il nodo del dataset si portava dietro un `rdf:type foaf:Document`.
- `foaf:page` ora usa, in ordine: `documentation`/`describedBy` della risorsa, altrimenti una `dcat:landingPage` gia' presente nel grafo. Piu' una guardia: il valore non puo' mai coincidere con `dataset_ref` ne' con la distribuzione.
- Conseguenza da accettare: i dataset senza landingPage e senza documentazione sulla risorsa non espongono `foaf:page`, quindi restano a 0 su `documentationAvailability`. Preferibile a un grafo sbagliato.
- Corretto anche un difetto preesistente: su dati.gov.it `dcat:landingPage` era un IRI nudo, mentre la shape `dcat:DatasetShape` impone `sh:class foaf:Document`. Ora il tipo e' dichiarato nel grafo, nel profilo `it_dcat_ap` che gira per ultimo, cosi' copre anche le landingPage aggiunte da dcatapit. Lo stack 2.12 le tipizzava gia'.

## `2026-10-09` — organization_list?all_fields=true: il campo era `identifier` (fix in dcatapit)
- Il campo che lasciava il sentinella `missing` in output e' **`identifier`**, confermato dalla risposta ora che l'endpoint torna 200: `[k for k,v in r.items() if v is None]` -> `['identifier']`.
- Meccanismo completo: `organization_list?all_fields=true` chiama `organization_show` per ogni organizzazione forzando `include_extras=False`; `convert_from_extras` non trova extras da convertire e la chiave resta a `missing`. Nella catena di `identifier` c'e' **solo** `not_empty`, che registra l'errore ma **non rimuove la chiave** (a differenza di `ignore_missing` e `ignore_empty`, che fanno `data.pop(key)`); `group_show` poi **scarta** gli errori (`group_dict, _errors = plugin_validate(...)`) e il sentinella finisce in `json.dumps`.
- Correzione: in `show_group_schema()` (2.12) / `db_to_form_schema()` (2.10) la catena diventa `[convert_from_extras, ignore_missing] + validator`. Messo qui e non in `get_custom_organization_schema()`, perche' quella lista serve anche a `create_group_schema`/`update_group_schema`: anteporre `ignore_missing` la' renderebbe `identifier` opzionale in scrittura.

## `2026-10-09` — byteSize: datatype sbagliato (xsd:decimal invece di xsd:nonNegativeInteger)
- La shape `dcat:DistributionShape` di DCAT-AP 3.0 impone su `dcat:byteSize` `sh:datatype xsd:nonNegativeInteger` e `sh:maxCount 1`. `euro_dcat_ap.py` emetteva `Literal(float(size), datatype=XSD.decimal)`, cioe' `"1024.0"^^xsd:decimal`: datatype errato su **ogni** distribuzione del catalogo. Lo stack 2.12 era gia' corretto (`ckanext-dcatita` ricasta con `int()`), questo no.
- Corretto anche un difetto collaterale: il test era `if resource_dict.get("size")`, falsy anche per `size == 0`, quindi una risorsa da 0 byte veniva pubblicata come 1024. Ora il default 1024 scatta solo se il valore manca davvero o non e' un numero non negativo.
- Aggiunta la guardia `if not any(g.objects(distribution, DCAT.byteSize))` per rispettare `sh:maxCount 1`.

## `2026-10-09` — le ultime 3 metriche MQA a zero: adms:identifier, dct:relation, foaf:page
- Rilevate sull'API MQA di data.europa.eu (`metricsVersion 2.0.0`): dataset **7,0/7,5**, distribuzioni **7,25/7,5**, `datasetFinal` **7,125**. Gli unici `result=0` erano `admsIdentifierAvailability`, `relationAvailability` (dataset) e `documentationAvailability` (distribuzione), 0,25 ciascuna.
- Il mapping esisteva gia' in `euro_dcat_ap.py` (extra `alternate_identifier`, `related_resource`, `documentation`): erano i **valori** a mancare, perche' dcatapit non popola quegli extra. Aggiunti fallback deterministici, come per `adms:status` e `byteSize`.
- `euro_dcat_ap.py`: `dct:relation` -> catalogo dell'ente sul portale nazionale; `foaf:page` sulla distribuzione -> `documentation`/`describedBy` della risorsa, altrimenti la pagina del dataset, **con `rdf:type foaf:Document` nel grafo** (la shape impone `sh:class foaf:Document` e il validatore non dereferenzia).
- `ckanext-dcatapit/.../dcat/profiles.py`: `adms:identifier` -> nodo `adms:Identifier` con una sola `skos:notation` (id CKAN). Va qui e non in `euro_dcat_ap.py` perche' il profilo `it_dcat_ap`, che gira dopo, esegue `g.remove((dataset_ref, ADMS.identifier, None))` e azzererebbe il fallback.
- Nessun valore passa da `URIRefOrLiteral`: le shape di `adms:identifier` e `dct:relation` impongono `sh:nodeKind sh:BlankNodeOrIRI`, un literal genererebbe un warning nuovo.
- Atteso dopo l'harvest: dataset 7,5/7,5, distribuzioni 7,5/7,5, `datasetFinal` **7,5**.

## `2026-10-09` — adms:status: il warning SHACL di EDP non dipendeva dal vocabolario
- Il validatore di data.europa.eu (shape `dcatap300level1`, `:StatusRestriction`) segnala `StatusRestrictionADMS` sulle distribuzioni. Verificato sull'endpoint SPARQL di EDP: il warning scatta con **entrambi** i vocabolari — 205.860 risultati con `purl.org/adms/status/Completed`, 17.216 con l'URI EU `distribution-status/COMPLETED` usato "nudo".
- La shape richiede `skos:inScheme <...distribution-status>` **nel grafo pubblicato** (il validatore non dereferenzia il NAL). Le sole distribuzioni senza warning su EDP (~3.600) usano l'URI EU **e** dichiarano il concetto nel grafo.
- `euro_dcat_ap.py`: valore riportato al vocabolario EU e aggiunte le triple `a skos:Concept` / `skos:inScheme` accanto a `adms:status`.
- Il punteggio MQA non era comunque intaccato: `statusAvailability` vale 0,25 anche con l'URI ADMS (la metrica misura solo la presenza della proprieta').

## `2026-09-28` — dct:provenance sui dataset harvestati (indicatore MQA "Origine")
- `patches/ckanext-dcatapit/.../dcat/profiles.py`: a fine `parse_dataset` il profilo `it_dcat_ap` compila `provenance` quando manca, usando solo dati certi del dataset (ente titolare, catalogo d'origine). Se non bastano, il campo resta vuoto: nessun testo generico.
- Copre l'indicatore MQA "Origine" (Riutilizzabilita', 0,25). Testo personalizzabile con `ckanext.dcatapit.provenance_template`.
- Stessa regola implementata sullo stack CKAN 2.12 (`piersoft/ckan-docker-ita-212`) nell'estensione `ckanext-dcatita`; qui in-place perche' le estensioni sono vendorizzate in `patches/`.

## `2026-06-01`
Pulizia e robustezza del setup Docker (versione demo):
- **Nessun dominio hardcoded**: `ckan.oaipmh.base_url` e `ckanext.dcat.base_uri` sono derivati da `CKAN_SITE_URL`; aggiunta variabile opzionale `CKAN_OAIPMH_BASE_URL`. GeoNames parametrizzato via `GEONAMES_USERNAME`.
- **`.env.example` riscritto**: rimossi gli spazi attorno agli `=` (causa di valori con spazi spuri), blocco iniziale "DA MODIFICARE", `CKAN_VERSION=2.10.9`, `TZ=Europe/Rome`.
- **`docker-compose.yml`**: rimossa la chiave obsoleta `version`; eliminati gli override `environment:` sugli URL DB che divergevano dal `.env` sul `?sslmode=disable` (sorgente unica = `.env`); healthcheck CKAN con `start_period: 300s` per evitare lo stato `unhealthy` durante il caricamento dei vocabolari; healthcheck db/solr/redis con intervalli espliciti.
- **NGINX**: espone sia HTTP (`NGINX_PORT_HOST`) sia HTTPS (`NGINX_SSLPORT_HOST`); corretto l'ENTRYPOINT con `openssl` malformato (doppio `-keyout` verso directory inesistente); certificato self-signed generato una sola volta in `certs/`.
- **Setup gruppi**: lo script `03_ckan_groups.end` (estensione non eseguita dall'entrypoint) sostituito da `setup_groups.sh`, idempotente, copiato in `/srv/app/setup_groups.sh` ed eseguibile con `docker compose exec ckan bash /srv/app/setup_groups.sh`.
- **Dockerfile CKAN**: `apt-get update && apt-get install -y nano curl` (prima `apt install nano` falliva); corretto `chmod` che puntava al file sbagliato (`topics.json` -> `regions.rdf`).
- **Repo ripulito**: rimossi `__pycache__/`, `*.pyc`, file `*.orig`/`*.old`/`*.pyintermedio` e la chiave TLS privata committata in `nginx/setup/`.


## `2026-03-15`
E' stato inserito il file bash [04_patch_uwsgi.sh](https://github.com/piersoft/ckan-docker/blob/master/ckan/docker-entrypoint.d/04_patch_uwsgi.sh) che estende lo star_ckan.sh con  gli EXTRAS di uSWGI. Nel file .env è stato inserito EXTRA_UWSGI_OPTS=--http-timeout 600 --socket-timeout 600 --ignore-sigpipe --ignore-write-errors --disable-write-exception che estende il time out del CKAN nella creazione dei catalog.rdf/ttl, da 60 secondi a 600 per i cataloghi molto grossi o CKAN sottodimensionati

## `2026-02-19`
Estensione patchata per OAI-PMH per l'interfacciamento con OPENAIRE. Configurare lo script /docker-entrypoint.d/01_setup_xloader.sh con l'url del proprio server al posto di piersoftckan.biz. Esempio https://www.piersoftckan.biz/oai?verb=ListMetadataFormats oppure https://www.piersoftckan.biz/oai?verb=Identify o. Per elenco totale da una data --> https://www.piersoftckan.biz/oai?verb=ListRecords&metadataPrefix=oai_datacite&from=2026-01-01.
## SE NON  SERVE OpenAIRE cancellare dcat_ap_edp_mqa in 01_setup_xloader.sh in ckanext.dcat.rdf.profiles e nel file .env nella sezione plugin

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
OBSOLETA: ~~nel file [__euro_dcat_ap.py__](https://github.com/piersoft/ckan-docker/blob/master/ckan/patches/ckanext-dcat/ckanext/dcat/profiles/euro_dcat_ap.py) è inserita una patch delicata. l'accessURL viene sostituito con la landingpage della risorsa sul CKAN e il downloadURL viene popolato con il valore di download della risorsa (ex accessURL). Sostituire il path del dominio con il proprio portale CKAN:~~

	    if dataset_dict.get('id'):
               resource_dict['access_url']='https://www.piersoftckan.biz/dataset/'+dataset_dict['id']+'/resource/'+resource_dict['id']

~~Se NON si vuole tale trasformazione, commentare le due righe di codice precedenti. il downloadURL, in tal caso, verrà impostato identico all'accessURL~~

## `2024-09-27`
Il codice è al 99,999% pronto per una installazione stand alone. le patch che ogni tanto aggiorno sono per harvesting di cataloghi remoti. Se non è il vostro caso, credo che si possa considerare stabile.

## `2024-06-27`
La mappatura automatica dei GRUPPI durante gli harvesting, è settata manualmente nel file [mapping.py](https://github.com/piersoft/ckan-docker/blob/master/ckan/patches/ckanext-dcatapit/ckanext/dcatapit/mapping.py) (estensione DCATAPIT) e non in nella variabile ckanext.dcatapit.theme_group_mapping.file in ckan.ini. Punta a /srv/app/patches/theme_to_group.ini . Questo file viene copiato automaticamente in quella posizione, non bisogna fare nulla nella compilazione da Docker proposta. Se si fanno configurazioni differenti, va modificato il path.

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















