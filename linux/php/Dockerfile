ARG PHP_VERSION=8.3
FROM php:${PHP_VERSION}-fpm-alpine

RUN apk add --no-cache \
        libpng-dev libjpeg-turbo-dev freetype-dev \
        libzip-dev postgresql-dev sqlite-dev \
        oniguruma-dev curl-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" \
        mysqli pdo pdo_mysql pdo_pgsql pgsql pdo_sqlite \
        mbstring gd zip curl opcache \
    && apk del libpng-dev libjpeg-turbo-dev freetype-dev libzip-dev postgresql-dev sqlite-dev oniguruma-dev curl-dev

WORKDIR /var/www
