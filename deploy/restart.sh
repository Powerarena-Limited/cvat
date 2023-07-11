ENV_NAME=$1
export CVAT_HOST=cvat-$ENV_NAME.standalone.powerarena.com

docker-compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml down
docker-compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml up -d --build