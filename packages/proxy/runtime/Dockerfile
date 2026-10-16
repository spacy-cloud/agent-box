FROM node:24-alpine
RUN apk add --no-cache openssl \
 && adduser -D -H -u 10001 -s /sbin/nologin proxy \
 && mkdir -p /etc/abox-proxy /run/abox-proxy \
 && chown 10001:10001 /etc/abox-proxy /run/abox-proxy \
 && chmod 0700 /etc/abox-proxy /run/abox-proxy
COPY proxy.mjs lib.mjs /opt/abox-proxy/
USER 10001
ENTRYPOINT ["node","/opt/abox-proxy/proxy.mjs"]
