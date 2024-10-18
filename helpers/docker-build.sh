#!/bin/bash
set -e

# Globals
HL='\033[0;34m\033[1m' # Highlight
NC='\033[0m' # No Color
REPOSITORY=${@: -1}
DOCKER_FILE=Dockerfile
BUILD_ARGS=

command -v git >/dev/null 2>&1 || {
  echo -e "💥  ${WA}git is not installed.$NC";
  exit 1
}

command -v docker >/dev/null 2>&1 || {
  echo -e "💥  ${WA}Docker is not installed.$NC";
  exit 1
}

# Help
usage () {
    echo "usage: ./docker-build.sh <REPOSITORY>" >&2
    echo >&2
    echo "Generate a docker image and upload it to specified repository." >&2
}

while getopts "hf:a:" flag; do
    case "${flag}" in
        h) usage; exit 0;;
        f) echo -e "🗃   Using dockerfile $HL${OPTARG}$NC" && DOCKER_FILE=$OPTARG;;
        a) echo -e "⭐️  Using build arguments $HL${OPTARG}$NC" && BUILD_ARGS=$OPTARG;;
        *) usage; exit 0;;
    esac
done

main () {
  # Checks
  if [ "$#" -lt 1 ]; then
    usage
    exit 1
  fi

  echo "ℹ️   Preparing repository"
  git fetch
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pink-robin-gmbh/cloud-actions/main/helpers/generate-version.sh)" -- -j -s version
  source version.sh

  echo "🐳  Starting Docker build"
  echo ""
  echo -e "Repository:                       $HL$REPOSITORY$NC"
  echo -e "Latest tag:                       $HL$LATEST_TAG$NC"
  if [ -n "$DOCKER_TAG" ] && [ "$LATEST_TAG" != "$DOCKER_TAG" ]; then
    echo -e "Docker tag:                       $HL$DOCKER_TAG$NC"
  fi
  if [ -n "$BUILD_ARGS" ]; then
    echo -e "Using build arguments:            $HL$BUILD_ARGS$NC"
  fi

  docker build -f $DOCKER_FILE -t $REPOSITORY:$LATEST_TAG $BUILD_ARGS .
  docker push $REPOSITORY:$LATEST_TAG

  if [ -n "$DOCKER_TAG" ] && [ "$LATEST_TAG" != "$DOCKER_TAG" ]; then
    echo ""
    echo "🐳  Pushing $DOCKER_TAG tag additional to $LATEST_TAG"
    docker image tag $REPOSITORY:$LATEST_TAG $REPOSITORY:$DOCKER_TAG
    docker push $REPOSITORY:$DOCKER_TAG
  fi

  echo ""
  echo "👋  Done & Bye"
}

( cd . && main "$@" )
