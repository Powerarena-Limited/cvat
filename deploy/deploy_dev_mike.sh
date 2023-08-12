#!/usr/bin/env bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build
CVAT_HOST=192.168.0.123 docker compose -f docker-compose.yml -f docker-compose.dev.yml up

