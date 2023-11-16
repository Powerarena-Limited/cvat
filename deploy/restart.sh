ENV_NAME=$1
export CVAT_SERVER_VERSION=$2

echo "ENV_NAME: $ENV_NAME"
echo "CVAT_SERVER_VERSION: $2"
echo "CVAT_VERSION: $3"

export CVAT_HOST=cvat-$ENV_NAME.standalone.powerarena.com


docker compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml down
docker compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml up -d --build
