#!/usr/bin/env bash
# docker compose for the production stack, with both env files:
#   infra/compose.sh ps
#   infra/compose.sh logs -f --since 10m api
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
compose "$@"
