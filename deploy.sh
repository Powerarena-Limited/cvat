
mkdir -p $cvat_events_path
sudo chomd -R 755 $cvat_events_path
mkdir -p $cvat_db_path
sudo chomd -R 755 $cvat_db_path
mkdir -p $cvat_data_path
sudo chomd -R 755 $cvat_data_path
mkdir -p $cvat_keys_path
sudo chomd -R 755 $cvat_keys_path
mkdir -p $cvat_logs_path
sudo chomd -R 755 $cvat_logs_path

export CVAT_HOST=cvat-deploy.standalone.powerarena.com
docker-compose -f docker-compose.yml -f components/analytics/docker-compose.analytics.yml up -d --build