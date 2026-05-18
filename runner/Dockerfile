FROM alpine:latest

# Install base dependencies
RUN apk add --no-cache \
    curl \
    jq \
    git \
    bash \
    aws-cli \
    tar \
    gzip \
    ca-certificates \
    docker-cli \
    docker-cli-buildx \
    openssl

WORKDIR /tmp

# Install yq
RUN curl -L https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/bin/yq && \
    chmod +x /usr/bin/yq

# Install aws-iam-authenticator
RUN curl -sS -o aws-iam-authenticator https://amazon-eks.s3.us-west-2.amazonaws.com/1.19.6/2021-01-05/bin/linux/amd64/aws-iam-authenticator && \
    chmod +x ./aws-iam-authenticator && \
    mv ./aws-iam-authenticator /usr/local/bin/

# Install kubectl
RUN curl -sS -o kubectl https://amazon-eks.s3.us-west-2.amazonaws.com/1.20.4/2021-04-12/bin/linux/amd64/kubectl && \
    chmod +x ./kubectl && \
    mv ./kubectl /usr/local/bin/

# Install eksctl
RUN EKSCTL_VERSION=v0.196.0 && \
    curl -sL "https://github.com/eksctl-io/eksctl/releases/download/${EKSCTL_VERSION}/eksctl_Linux_amd64.tar.gz" | tar xz -C /tmp && \
    mv /tmp/eksctl /usr/local/bin/ && \
    chmod +x /usr/local/bin/eksctl

# Install gomplate
RUN curl --silent --location "https://github.com/hairyhenderson/gomplate/releases/latest/download/gomplate_linux-amd64" -o /usr/local/bin/gomplate && \
    chmod +x /usr/local/bin/gomplate

# Install Helm
RUN curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 && \
    chmod +x get_helm.sh && \
    ./get_helm.sh && \
    rm get_helm.sh

# Install Helmfile
RUN HELMFILE_VERSION=1.2.2 && \
    curl -L https://github.com/helmfile/helmfile/releases/download/v${HELMFILE_VERSION}/helmfile_${HELMFILE_VERSION}_linux_amd64.tar.gz -o helmfile.tar.gz && \
    tar -xzf helmfile.tar.gz && \
    chmod +x helmfile && \
    mv helmfile /usr/local/bin/ && \
    rm helmfile.tar.gz

# Install helm-diff plugin
# We use a specific version for better stability during install
RUN helm plugin install https://github.com/databus23/helm-diff --version v3.9.11

# Credential helper script that implements the docker credential helper
# protocol for ECR, using aws-cli (already installed) to get auth tokens.
COPY runner/docker-credential-ecr-login /usr/local/bin/docker-credential-ecr-login
RUN chmod +x /usr/local/bin/docker-credential-ecr-login

# Install crane
RUN CRANE_VERSION=v0.20.0 && \
    curl -sL https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_linux_x86_64.tar.gz | tar xz && \
    mv crane /usr/local/bin/ && \
    chmod +x /usr/local/bin/crane

WORKDIR /app

# Keep container running
CMD ["sleep", "infinity"]
