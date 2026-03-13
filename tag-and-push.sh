#!bash

# where this .sh file lives
DIRNAME=$(dirname "$0")
SCRIPT_DIR=$(cd "$DIRNAME" || exit 1; pwd)
cd "$SCRIPT_DIR" || exit 1

# Get the current version from package.json
OLD_VERSION=$(jq -r '.version' package.json)

# Function to increment the version
increment_version() {
  local version=$1
  local major=$(echo "$version" | cut -d'.' -f1)
  local minor=$(echo "$version" | cut -d'.' -f2)
  local patch=$(echo "$version" | cut -d'.' -f3)
  echo "$major.$minor.$((patch + 1))"
}

# Increment the patch version
VERSION=$(increment_version "$OLD_VERSION")

export VERSION

jq --raw-output '.version = $ENV.VERSION' package.json 2>&1 | tee package.json.new
mv package.json.new package.json

npm install --include=dev --legacy-peer-deps || exit 1

git add package.json package-lock.json

# Check if there are changes to commit
if ! git diff-index --quiet HEAD --; then
  git commit -m "${VERSION} - $*" || { echo "Failed to commit changes"; exit 1; }
else
  echo "No changes to commit"
fi

# Check if tag already exists
if git rev-parse "${VERSION}" >/dev/null 2>&1; then
  echo "Tag ${VERSION} already exists."
  exit 1
fi

# Create new tag
git tag "${VERSION}" || { echo "Failed to create tag"; exit 1; }

# Push with error handling
if ! git push; then
  echo "Failed to push commits"
  git tag -d "${VERSION}"
  exit 1
fi

if ! git push --tags; then
  echo "Failed to push tags"
  git tag -d "${VERSION}"
  exit 1
fi
