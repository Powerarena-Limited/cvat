FROM cvat/server:v2.4.8

USER root
RUN apt-get update && \
    apt-get install -y iputils-ping dnsutils netcat curl vim && \
    rm -rf /var/lib/apt/lists/*
USER django