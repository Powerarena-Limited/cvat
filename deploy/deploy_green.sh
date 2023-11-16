export CVAT_HOST=cvat-green.standalone.powerarena.com

docker compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml up -d --build
