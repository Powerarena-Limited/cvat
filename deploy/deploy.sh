ENV_NAME=$1
export CVAT_HOST=cvat-$ENV_NAME.standalone.powerarena.com
export NUCTL_VERSION=1.8.14

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

# TODO Check cvat up
sleep 10
docker exec -i cvat_server bash -ic "DJANGO_SUPERUSER_PASSWORD=1 python3 ~/manage.py createsuperuser --username admin --email admin@cvat.com --no-input"

# install_nuctl
gpu_support