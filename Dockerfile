FROM ubuntu:22.04

ARG DATABASE_URL
# probably not needed here but needed if running prisma commands in this build phase

RUN apt-get update && apt-get install -y curl gnupg zip unzip openssl

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

ENV BUN_INSTALL=$HOME/bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH=$PATH:$HOME/bun/bin

WORKDIR /app

COPY package.json .
COPY bun.lockb .
COPY prisma prisma

RUN bun install
# I chose to prisma generate & deploy during start phase

COPY . .
# copy anything else over that's necessary

EXPOSE 3000

CMD ["bun", "production"]