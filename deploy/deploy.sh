export CVAT_HOST=cvat-deploy.standalone.powerarena.com
docker compose -f docker-compose.yml up -d

# TODO Check cvat up
sleep 10
docker exec -i cvat_server bash -ic "DJANGO_SUPERUSER_PASSWORD=1 python3 ~/manage.py createsuperuser --username admin --email admin@cvat.com --no-input"
