SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

all: lint build

ci: lint build

lint:
	npx eslint src/

build:
	npx tsc

update-libraries:
	npm install --save @thehonker/k8s-operator@latest
	npm install --save @playm8s/crds@latest

dev-link:
	cd node_modules/@playm8s && rm -rf crds && ln -s "$${HOME}/Repos/playm8s/pm8s-crds" crds
	cd node_modules/@thehonker && rm -rf k8s-operator && ln -s "$${HOME}/Repos/playm8s/k8s-operator-node" k8s-operator
	npm list
	npm version

dev: build
	node dist/main.mjs
