ENV_NAME=nb
export CVAT_HOST=cvat-$ENV_NAME.standalone.powerarena.com
export NUCTL_VERSION=1.8.14
export CVAT_SERVER_VERSION=v2.4.8.1113

export CVAT_DATA_HOME=/media/disk3/cvat-data
export CVAT_DB_DIR=$CVAT_DATA_HOME/cvat-db-$ENV_NAME
export CVAT_DATA_DIR=$CVAT_DATA_HOME/cvat-data-$ENV_NAME
export CVAT_KEYS_DIR=$CVAT_DATA_HOME/cvat-keys-$ENV_NAME
export CVAT_LOGS_DIR=$CVAT_DATA_HOME/cvat-logs-$ENV_NAME
export CVAT_EVENTS_DB_DIR=$CVAT_DATA_HOME/cvat-events-db-$ENV_NAME

# make a function if folder $1 not exist, create folder and give 755 permission
function create_folder() {
    if [ -d "$1" ]; then
        echo "Folder $1 already exist"
    else
        mkdir -p $1
        chmod 755 $1
    fi
}

create_folder $CVAT_DB_DIR
create_folder $CVAT_DATA_DIR
create_folder $CVAT_KEYS_DIR
create_folder $CVAT_LOGS_DIR
create_folder $CVAT_EVENTS_DB_DIR


function install_nuctl() {
	wget https://github.com/nuclio/nuclio/releases/download/$NUCTL_VERSION/nuctl-$NUCTL_VERSION-linux-amd64
	sudo chmod +x nuctl-$NUCTL_VERSION-linux-amd64
	sudo ln -sf $(pwd)/nuctl-$NUCTL_VERSION-linux-amd64 /usr/local/bin/nuctl
}

function gpu_support () {
	cd serverless
	./deploy_gpu.sh pytorch/facebookresearch/sam/nuclio
}

function deploy_cvat_with_serverless() {
	docker compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml up -d
	# Check the exit code of the previous command
	if [ $? -ne 0 ]; then
		echo "Failed to run 'docker compose'. Falling back to 'docker-compose'."
		# Run 'docker-compose' command instead
		docker-compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml up -d
	fi
}

function install_nvidia_toolkit() {
	if ! dpkg -s nvidia-container-toolkit >/dev/null 2>&1; then
		sudo apt-get update
		sudo apt-get install -y nvidia-container-toolkit
		sudo nvidia-ctk runtime configure --runtime=docker
		sudo systemctl restart docker
		sudo docker run --rm --runtime=nvidia --gpus all nvidia/cuda:11.6.2-base-ubuntu20.04 nvidia-smi
	else
		echo "nvidia-container-toolkit package is already installed."
	fi
}

# install_nvidia_toolkit
docker compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml down
deploy_cvat_with_serverless

# Check cvat up
sleep 120
docker exec -i cvat_server bash -ic "DJANGO_SUPERUSER_PASSWORD=1 python3 ~/manage.py createsuperuser --username admin --email admin@cvat.com --no-input"

# if nuctl not installed then install it
if ! command -v nuctl &> /dev/null
then
    export http_proxy=http://192.168.0.111:9118
    export https_proxy=$http_proxy
    install_nuctl
    gpu_support
else
    echo "nuctl already installed"
fi