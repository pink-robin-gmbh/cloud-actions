#!/usr/bin/env bash
set -e

# Globals
HL='\033[0;34m\033[1m' # Highlight
WA='\033[0;33m\033[1m' # Warning
NC='\033[0m' # No Color

# Initial checks
command -v git >/dev/null 2>&1 || {
  echo -e "💥  ${WA}git is not installed.$NC";
  exit 1
}

command -v npx >/dev/null 2>&1 || {
  echo -e "💥  ${WA}Node.js / NPM / npx is not installed.$NC";
  exit 1
}

command -v openssl >/dev/null 2>&1 || {
  echo -e "💥  ${WA}OpenSSL is not installed.$NC";
  exit 1
}

if [ ! -d ".git" ]; then
  echo -e "💥  ${WA}This is not a git repository.$NC Please run inside root directory of a repository."
  exit 1
fi

# Variables
OUTPUT_HTML=
OUTPUT_MD=
SHORT=`git rev-parse --short HEAD`
REPO_NAME=$(basename `git config --get remote.origin.url` .git)
COMMIT_URL="https://github.com/pink-robin-gmbh/${REPO_NAME}/commit/"
NUM_VERSIONS=30

# Help
usage () {
    echo "usage: source ./generate-changelog.sh [-h] [-x] [-m] [-c] <COMMIT_URL_PREFIX> [-n] <NUM_VERSIONS>" >&2
    echo >&2
    echo "Generate changelog.* file as Markdown or HTML. Commit prefix URL can be modified with -c." >&2
    echo "" >&2
    echo "Options:" >&2
    echo "-h    Show this help" >&2
    echo "-x    Write as .html file" >&2
    echo "-m    Write as .md file" >&2
    echo "-c    Specify commit URL prefix" >&2
    echo "-n    Number of versions/tags to list in changelog" >&2
}

while getopts "hxmc:n:" flag; do
    case "${flag}" in
        h) usage; exit 0;;
        x) OUTPUT_HTML=yes;;
        m) OUTPUT_MD=yes;;
        c) COMMIT_URL=$OPTARG;;
        n) NUM_VERSIONS=$OPTARG;;
        *) usage; exit 1;;
    esac
done
shift $((OPTIND -1))

generateMarkdown() {
    # Add title and shields
    REMOTE_BRANCH=`git branch --remote --verbose --no-abbrev --contains | grep $(git rev-parse --verify HEAD) | sed -rne 's/^[^\/]*\/([^\ ]+).*$/\1/p' | tail -1`
    LOCAL_BRANCH=`git rev-parse --abbrev-ref HEAD`
    GENERATED_AT=$(date +%d.%m.%Y)
    REPO_BRANCH=${REMOTE_BRANCH:-$LOCAL_BRANCH}
    COMMIT_SHORT=`git rev-parse --short HEAD`

    printf "# Changelog\n"
    printf "_Generated_ __${GENERATED_AT}__\n"
    printf "_Repository_ __${REPO_NAME}__\n"
    printf "_Branch_ __${REPO_BRANCH}__\n"
    printf "_Commit_ __${COMMIT_SHORT}__\n\n"

    # Add development commits (no version tag)
    LAST_TAG=`git tag --merged $(git rev-parse --verify HEAD) --sort=-creatordate | head -n 1`
    DEV_COMMITS=`git log HEAD...${LAST_TAG} --pretty=format:"*  **%an** %s [%h](${COMMIT_URL}%H)" | grep -v Merge`
    if [ -n "$DEV_COMMITS" ]; then
    printf "## In development\n"
    printf "$DEV_COMMITS"
    printf "\n\n"
    fi

    # Output version history
    PREVIOUS_TAG=0
    NUM_TAGS=$(($NUM_VERSIONS+1))
    for CURRENT_TAG in $(git tag --merged $(git rev-parse --verify HEAD) --sort=-creatordate | head -n $NUM_TAGS)
    do
        if [ "$PREVIOUS_TAG" != 0 ];then
            TAG_DATE=$(git log -1 --pretty=format:'%ad' --date=format:%d.%m.%Y ${PREVIOUS_TAG})
            printf "## ${PREVIOUS_TAG}\n"
            printf "**${TAG_DATE}**\n\n"
            git log ${CURRENT_TAG}...${PREVIOUS_TAG} --pretty=format:"*  **%an** %s [%h](${COMMIT_URL}%H)" | grep -v Merge
            printf "\n\n"
        fi
        PREVIOUS_TAG=${CURRENT_TAG}
    done

    # Output history from first commit to first version
    if [ "$NUM_VERSIONS" -ge "$(git tag --sort=-creatordate | wc -l)" ]; then
        FIRST_COMMIT=$(git rev-list --max-parents=0 HEAD)
        FIRST_TAG=$(git tag --sort=creatordate | head -n 1)
        FIRST_DATE=$(git log -1 --pretty=format:'%ad' --date=short ${FIRST_TAG})
        printf "## ${FIRST_TAG:-Initial project setup}\n\n"
        printf "**${FIRST_DATE}**\n\n"
        git log ${FIRST_COMMIT}...${FIRST_TAG:-HEAD} --pretty=format:"*  **%an** %s [%h](${COMMIT_URL}%H)" | grep -v Merge
        git log ${FIRST_COMMIT} --pretty=format:"*  **%an** %s [%h](${COMMIT_URL}%H)" | grep -v Merge
        printf "\n\n"
    fi
}

main () {
    echo "📣  Creating changelog from git repository"
    MARKDOWN="$(generateMarkdown)" 

    if [ "$OUTPUT_MD" ]; then
        echo "📝  Writing changelog as Markdown"
        echo "$MARKDOWN" > changelog.md
    fi

    if [ "$OUTPUT_HTML" ]; then
        echo "💄  Writing changelog as HTML"

        TEMP_DIR=`openssl rand -hex 16`
        if [ -d "$TEMP_DIR" ]; then
            echo -e "💥  ${WA}Fatal error.$NC Temp directory exists."
            exit 1
        fi

        TEMP_DIR="./tmp-$TEMP_DIR"
        mkdir "$TEMP_DIR"
        echo "🌍  Downloading styles"
        curl -s -o "$TEMP_DIR/pinkrobin.min.css" https://raw.githubusercontent.com/pink-robin-gmbh/cloud-actions/main/templates/changelog/pinkrobin.min.css
        echo "📝  Writing temporary Markdown"
        echo "$MARKDOWN" > "$TEMP_DIR/changelog.md"
        echo "🔮  Converting Markdown to HTML"
        npx -y markdown-html "$TEMP_DIR/changelog.md" -o changelog.html -s "$TEMP_DIR/pinkrobin.min.css" -t "Changelog: $REPO_NAME"

        echo "🗑   Cleaning up"
        rm -rf "$TEMP_DIR"
    fi

    echo "👋  Done & Bye"
}

( cd . && main "$@" )
