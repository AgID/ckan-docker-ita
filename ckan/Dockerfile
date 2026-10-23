FROM ckan/ckan-base:2.10.11-py3.10 AS ckan

USER root

# Install any extensions needed by your CKAN instance
# See Dockerfile.dev for more details and examples
### Harvester ###
#RUN pip3 install -e 'git+https://github.com/ckan/ckanext-harvest.git@master#egg=ckanext-harvest' && \
COPY patches/ckanext-harvest ${APP_DIR}/src/ckanext-harvest
RUN    pip3 install -e ${APP_DIR}/src/ckanext-harvest/
RUN    pip3 install -r ${APP_DIR}/src/ckanext-harvest/requirements.txt
# will also require gather_consumer and fetch_consumer processes running (please see https://github.com/ckan/ckanext-harvest)

### Scheming ###
#RUN  pip3 install -e 'git+https://github.com/ckan/ckanext-scheming.git@master#egg=ckanext-scheming'

### Pages ###
#RUN  pip3 install -e git+https://github.com/ckan/ckanext-pages.git#egg=ckanext-pages

RUN pip3 install pylons
RUN pip3 install routes

# Install ckanext-dcat HVD
#RUN  pip3 install -e git+https://github.com/ckan/ckanext-dcat.git@56-tmp#egg=ckanext-dcat && \
COPY patches/ckanext-dcat ${APP_DIR}/src/ckanext-dcat
RUN     pip3 install -e ${APP_DIR}/src/ckanext-dcat/
RUN     pip3 install -r ${APP_DIR}/src/ckanext-dcat/requirements.txt

# Install ckanext-dcatapit
COPY patches/ckanext-dcatapit ${APP_DIR}/src/ckanext-dcatapit
RUN     pip3 install -e ${APP_DIR}/src/ckanext-dcatapit/

# X-Loader
RUN pip3 install --no-cache-dir \
    git+https://github.com/ckan/ckanext-xloader.git@2.2.0#egg=ckanext-xloader \
    && pip3 install --no-cache-dir \
    -r https://raw.githubusercontent.com/ckan/ckanext-xloader/2.2.0/requirements.txt

# Install ckanext-multilang
RUN  pip3 install -e git+https://github.com/geosolutions-it/ckanext-multilang.git@master#egg=ckanext-multilang  && \
     pip3 install -e ${APP_DIR}/src/ckanext-multilang/

# DCATAPIT theme to group mapping file
COPY patches/theme_to_group.ini "${APP_DIR}/patches/theme_to_group.ini"
RUN chmod 666 "${APP_DIR}/patches/theme_to_group.ini"

# OPENAIRE ESTENSIONI
COPY patches/ckanext-dcat-ap-edp-mqa ${APP_DIR}/src/ckanext-dcat-ap-edp-mqa
RUN     pip3 install -e ${APP_DIR}/src/ckanext-dcat-ap-edp-mqa
RUN     pip3 install -r ${APP_DIR}/src/ckanext-dcat-ap-edp-mqa/requirements.txt
COPY patches/ckanext-oai-pmh-server ${APP_DIR}/src/ckanext-oai-pmh-server
RUN     pip3 install -e ${APP_DIR}/src/ckanext-oai-pmh-server
RUN     pip3 install -r ${APP_DIR}/src/ckanext-oai-pmh-server/requirements.txt

# CKAN group to DCATAPIT theme mapping file
COPY patches/topics.json "${APP_DIR}/patches/topics.json"
RUN chmod 666 "${APP_DIR}/patches/topics.json"

# DCATAPIT regions vocabulary file
COPY patches/regions.rdf "${APP_DIR}/patches/regions.rdf"
RUN chmod 666 "${APP_DIR}/patches/regions.rdf"

# model_dictize.py e base.py: ora patch in patches/ckan/ (02, 03), vedi sotto.

COPY patches/xmlrpc.py /usr/local/lib/python3.10/site-packages/pylons/controllers/xmlrpc.py
COPY patches/jsonrpc.py /usr/local/lib/python3.10/site-packages/pylons/controllers/jsonrpc.py
COPY patches/core.py /usr/local/lib/python3.10/site-packages/pylons/controllers/core.py
COPY patches/supervisord.conf /etc/supervisord.conf
COPY patches/sprite-resource-icons.png "${APP_DIR}/src/ckan/ckan/public/base/images"
COPY patches/ckan_logo_col.png "${APP_DIR}/src/ckan/ckan/public/base/images"
# 10.10.26 Rimosso l'override di ckan/logic/__init__.py (era patches/__init__.py,
# "patch per user not auth to show in harvesting"). Due ragioni:
#  1. 2.10.11 modifica quel file (fresh_context accetta **kwargs, serve alla
#     correzione GHSA-jgwg-vp4m-5xw5 sull'esposizione di metadati privati via
#     API follow): sovrascriverlo con la copia 2.10.10 annullava la correzione.
#  2. Delle 4 modifiche che conteneva, 3 erano riscritture cosmetiche di
#     log.debug e la quarta era
#       if 'package_show' not in action or 'package_search' not in action:
#     condizione sempre vera (nessun nome di action contiene entrambe le
#     stringhe), quindi il raise NotAuthorized scattava comunque: la patch non
#     aveva alcun effetto.
# patch per avere il rating dal portale europeo dei dati aperti. Decommentare se si vuole il punteggio
#COPY patches/read.html "${APP_DIR}/src/ckan/ckan/templates/package/read.html"
# fix origin con landingpage e non /edit/: ora patch patches/ckan/05 (vedi sotto)
# 10.10.26 Rimosso l'override di ckan/views/util.py (era patches/util.py):
# la copia era identica a upstream 2.10.10, zero differenze, e in 2.10.11 quel
# file riceve la gestione di FlaskRouteBuildError su internal_redirect (400
# invece di 500 su URL non costruibile).

#FIX per XLOADER per il comando ckan xloader status. Consigliato:
COPY patches/command.py /usr/local/lib/python3.10/site-packages/ckanext/xloader/command.py

# Min length resource = 5: ora patch patches/ckan/04 (vedi sotto)

# Copy custom initialization scripts
# CSS predefinito accessibile (WCAG 2.1 AA): impostato come "Custom CSS" da
# docker-entrypoint.d/05_custom_css.sh se l'admin non ne ha uno proprio
COPY css.example ${APP_DIR}/css.example
COPY docker-entrypoint.d/* /docker-entrypoint.d/

COPY patches/groups ${APP_DIR}/patches/groups

# Apply any patches needed to CKAN core or any of the built extensions (not the
# runtime mounted ones)
# patches/ckan/01_pagination_accessibilita.patch: paginazione accessibile
# (WCAG 1.3.1, 2.4.4, 4.1.2) — <nav> con etichetta, frecce con testo per i
# lettori di schermo, aria-current sulla pagina corrente, puntini non link.
# Le modifiche al core che prima sostituivano interi file (rischio: annullare in
# silenzio le correzioni di sicurezza delle nuove versioni di CKAN) sono patch:
#   02 model_dictize: rows=50 nel conteggio dataset di gruppi/organizzazioni
#   03 base.py: shim `model` / `c` per le estensioni pre-2.10
#   04 validators: nome risorsa di almeno 5 caratteri (invece di 7)
#   05 language_selector: campo `redirect_url` invece di `url`
# Se una nuova versione di CKAN cambia quei file, la patch non si applica e la
# build si ferma (invece di sovrascrivere il file aggiornato).
COPY patches ${APP_DIR}/patches

RUN for d in $APP_DIR/patches/*; do \
        if [ -d $d ]; then \
            for f in `ls $d/*.patch | sort -g`; do \
                cd $SRC_DIR/`basename "$d"` && echo "$0: Applying patch $f to $SRC_DIR/`basename $d`"; patch -p1 < "$f" || exit 1 ; \
            done ; \
        fi ; \
    done


# Script manuale per il setup iniziale dei gruppi tematici (vedi README)
COPY setup_groups.sh ${APP_DIR}/setup_groups.sh
RUN chmod +x ${APP_DIR}/setup_groups.sh

# Utilita' di base e aggiornamenti di sicurezza Debian (un solo layer, non interattivo).
# - apt-get upgrade: correzioni non ancora presenti nell'immagine base
#   (perl, expat, pcre2, gnutls, libpq, python3.11 di sistema...)
# - via gli header del kernel Linux lasciati dalla base (linux-headers, kbuild,
#   compiler): servono solo a compilare moduli, nel container il kernel e' quello
#   dell'host. Portavano oltre 1600 segnalazioni (CVE del kernel) senza effetto reale.
#   linux-libc-dev resta: e' richiesto da libc6-dev.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends nano curl \
    && KHDR="$(dpkg-query -W -f '${binary:Package}\n' 'linux-headers-*' 'linux-kbuild-*' 'linux-compiler-gcc-*' 2>/dev/null || true)" \
    && if [ -n "$KHDR" ]; then apt-get purge -y $KHDR; fi \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install setuptools==80
# Aggiornamenti di sicurezza delle librerie Python fissate da CKAN 2.10.11
# (versioni minime che correggono CVE note, segnalate da Trivy/Docker Scout).
# urllib3 2.x: compatibile con requests 2.32 di CKAN 2.10 su Python 3.10.
RUN pip3 install --no-cache-dir -U \
        "certifi>=2026.10.19" \
        "PyJWT>=2.14.0,<3" \
        "urllib3>=2.8.0,<3" \
        "sqlparse>=0.5.5,<0.6" \
    && (pip3 check || true)

# Entrypoint: genera e conserva nel volume i segreti se nel .env mancano
# (o sono CHANGE_ME). Con segreti reali nel .env non fa nulla. Vedi lo script.
COPY setup/ckan-ita-entrypoint.sh ${APP_DIR}/ckan-ita-entrypoint.sh
RUN chmod 755 ${APP_DIR}/ckan-ita-entrypoint.sh
# Impostare ENTRYPOINT azzera il CMD ereditato: va ridichiarato.
ENTRYPOINT ["/srv/app/ckan-ita-entrypoint.sh"]
CMD ["/srv/app/start_ckan.sh"]
