ARG PHP_VERSION=8.3
FROM php:${PHP_VERSION}-fpm-alpine

# The -dev packages below are build-only (headers/static libs for compiling
# the extensions), but on Alpine the actual runtime .so files (libpng,
# libjpeg-turbo, freetype, libzip, libpq, sqlite-libs, oniguruma, libcurl)
# were only ever pulled in as THEIR dependencies - deleting the -dev
# packages afterward also removed those as orphans, leaving gd, pdo_pgsql,
# pgsql and zip unable to load at all. Explicitly keeping the runtime libs
# installed (not just as transitive deps) before deleting the build set
# fixes that.
RUN apk add --no-cache --virtual .build-deps \
        libpng-dev libjpeg-turbo-dev freetype-dev \
        libzip-dev postgresql-dev sqlite-dev \
        oniguruma-dev curl-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" \
        mysqli pdo pdo_mysql pdo_pgsql pgsql pdo_sqlite \
        mbstring gd zip curl opcache \
    && apk add --no-cache libpng libjpeg-turbo freetype libzip libpq sqlite-libs oniguruma libcurl \
    && apk del .build-deps

WORKDIR /var/www
