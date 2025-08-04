FROM node:24

RUN apt-get update && apt-get install -y curl unzip less jq

# Install AWS CLI
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip

# RUN curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb" && \
#     dpkg -i session-manager-plugin.deb && \
#     rm session-manager-plugin.deb

# Create .aws directory and copy files into /root/.aws
RUN mkdir -p /root/.aws
COPY --chmod=600 ./config /root/.aws/config
COPY --chmod=600 ./credentials /root/.aws/credentials

WORKDIR /app

RUN npm install -g aws-cdk

CMD ["bash"]
