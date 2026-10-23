FROM nginx:stable-alpine

ENV NGINX_DIR=/etc/nginx

RUN apk upgrade --no-cache && apk add --no-cache openssl

COPY setup/nginx.conf ${NGINX_DIR}/nginx.conf
COPY setup/index.html /usr/share/nginx/html/index.html
COPY setup/default.conf ${NGINX_DIR}/conf.d/default.conf

# Genera un certificato self-signed (solo se assente) e avvia NGINX.
# Cert e chiave finiscono entrambi in ${NGINX_DIR}/certs (coerente con default.conf).
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p ${NGINX_DIR}/certs && { [ -f ${NGINX_DIR}/certs/ckan-local.crt ] || openssl req -subj '/C=IT/ST=Italy/L=Italy/O=CKAN-Demo/CN=localhost' -x509 -newkey rsa:4096 -nodes -keyout ${NGINX_DIR}/certs/ckan-local.key -out ${NGINX_DIR}/certs/ckan-local.crt -days 825; } && exec nginx -g 'daemon off;'"]
