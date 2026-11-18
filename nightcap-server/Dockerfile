# The Nightcap server, with the web app it serves at /app/. Built from the repository's root
# (it takes nightcap-web too): docker build -f nightcap-server/Dockerfile .

# The web app (nightcap-web), built here so the image always has the one that matches.
FROM node:22.14.0-bookworm-slim AS web
WORKDIR /web
COPY nightcap-web/package.json nightcap-web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY nightcap-web/ ./
# (--build-arg NIGHTCAP_PRIVATE_HANDLER=1: an optional extension goes in, from files git doesn't keep.
# Only this stage sees its source: the image keeps the built app.)
ARG NIGHTCAP_PRIVATE_HANDLER
RUN npm run build
# Compressed copies of the built text files (Brotli, and gzip for the rest), sent to a browser that
# takes them (api.py, web_app): about a quarter the size, and no work per request.
RUN node -e 'const fs=require("fs"),p=require("path"),z=require("zlib");(function walk(d){for(const f of fs.readdirSync(d)){const x=p.join(d,f);if(fs.statSync(x).isDirectory())walk(x);else if(/\.(js|css|html|svg|json|txt|webmanifest)$/.test(f)&&fs.statSync(x).size>1024){const b=fs.readFileSync(x);fs.writeFileSync(x+".br",z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}));fs.writeFileSync(x+".gz",z.gzipSync(b,{level:9}));}}})("dist")'

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY nightcap-server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY nightcap-server/nightcap ./nightcap
# (--build-arg NIGHTCAP_PRIVATE_HANDLER=1: the server's optional extension stays in, from files git
# doesn't keep; without it, the image has none, even when the folder is there.)
ARG NIGHTCAP_PRIVATE_HANDLER
RUN if [ -z "$NIGHTCAP_PRIVATE_HANDLER" ]; then rm -rf ./nightcap/private; fi
# (Readable by the server's own user whatever it was on the machine that built it: a folder kept
# owner-only there would otherwise be copied unreadable, and the extension silently left out.)
RUN if [ -d ./nightcap/private ]; then chmod -R a+rX ./nightcap/private; fi
# The tables, set up by the server itself when it starts (schema.py).
COPY nightcap-server/db/schema.sql ./db/schema.sql
COPY --from=web /web/dist ./web

RUN useradd --system --uid 10001 nightcap
USER nightcap
EXPOSE 7171
CMD ["python", "-m", "nightcap"]
